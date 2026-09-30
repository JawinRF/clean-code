"""Bounded, event-driven delegation for the single local runtime.

Task completion futures are the wakeup mechanism. There is no status-polling
model turn, timer-based model wakeup, or automatic replay after a restart.
"""
import asyncio
from collections.abc import Callable
from contextlib import AbstractContextManager
import json
import logging
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AgentRun, AgentSession, Message, RunEvent
from app.providers import LlmAdapter
from app.providers.registry import provider_is_available
from app.services.model_catalog import load_model_catalog
from app.services.run_events import append_run_event
from app.services.run_recovery import interrupt_agent_run
from app.services.tool_approval import ToolApprovalCoordinator
from app.tools.base import ToolResult
from app.tools.delegate_tasks import SubagentTask

logger = logging.getLogger(__name__)
RESULT_MAX_CHARACTERS = 6000
WORKER_SYSTEM = (
    "You are a delegated worker. Complete only your assigned task. Your prompt is your "
    "complete assignment; you do not have the parent's conversation. Other workers share "
    "this workspace: respect the files assigned to you and preserve unrelated changes. "
    "Use the normal tools and approval flow. Do not delegate or start background agents. "
    "Finish with a concise report of findings or changes, file paths, verification actually "
    "performed, and unresolved issues. Do not claim unperformed checks."
)


class SubagentOrchestrator:
    def __init__(
        self, *, session_factory: Callable[[], AbstractContextManager[Session]],
        adapter_factory: Callable[[str], LlmAdapter],
        approval_coordinator: ToolApprovalCoordinator,
        concurrency: int, max_per_run: int, timeout_seconds: int,
    ) -> None:
        self._session_factory = session_factory
        self._adapter_factory = adapter_factory
        self._approvals = approval_coordinator
        self._slots = asyncio.Semaphore(concurrency)
        self.max_per_run = max_per_run
        self._timeout_seconds = timeout_seconds
        self._tasks: dict[UUID, asyncio.Task[dict[str, object]]] = {}

    def available_models(self) -> tuple[tuple[str, str], ...]:
        return tuple(
            (provider.id, model.id)
            for provider in load_model_catalog().providers
            if provider_is_available(provider.id)
            for model in provider.models
        )

    def cancel(self, run_id: UUID) -> bool:
        task = self._tasks.get(run_id)
        return task.cancel() if task is not None and not task.done() else False

    async def delegate(self, parent_id: UUID, assignments: list[SubagentTask]) -> ToolResult:
        available = set(self.available_models())
        for assignment in assignments:
            if (assignment.model_provider, assignment.model_name) not in available:
                return ToolResult(
                    content=f"Model unavailable: {assignment.model_provider}/{assignment.model_name}. "
                    "Choose a configured model with an API key. No workers were started.",
                    is_error=True,
                )

        # Validate and reserve the entire batch under the parent lock, before any dispatch.
        with self._session_factory() as session:
            parent = session.scalar(select(AgentRun).where(AgentRun.id == parent_id).with_for_update())
            if parent is None or parent.status != "running" or parent.cancel_requested_at is not None:
                raise asyncio.CancelledError
            if parent.parent_run_id is not None:
                return ToolResult(content="Workers cannot delegate further.", is_error=True)
            used = session.scalar(select(func.count()).select_from(AgentRun).where(
                AgentRun.parent_run_id == parent_id,
            )) or 0
            if used + len(assignments) > self.max_per_run:
                return ToolResult(
                    content=f"Worker budget exceeded: {self.max_per_run - used} slots remain. "
                    "No workers were started. Complete the remaining work yourself.", is_error=True,
                )
            parent_session = session.get(AgentSession, parent.session_id)
            if parent_session is None:
                raise RuntimeError("Parent session is unavailable.")
            child_ids: list[UUID] = []
            for assignment in assignments:
                child_session = AgentSession(
                    workspace_id=parent_session.workspace_id,
                    parent_session_id=parent_session.id, title=assignment.label,
                )
                session.add(child_session)
                session.flush()
                prompt = Message(
                    session_id=child_session.id, role="user",
                    content={"parts": [{"type": "text", "text": assignment.prompt}]},
                )
                session.add(prompt)
                session.flush()
                child = AgentRun(
                    session_id=child_session.id, parent_run_id=parent_id,
                    agent_label=assignment.label, trigger_message_id=prompt.id,
                    model_provider=assignment.model_provider, model_name=assignment.model_name,
                )
                session.add(child)
                session.flush()
                child_ids.append(child.id)
                details = {
                    "run_id": str(child.id), "session_id": str(child_session.id),
                    "label": assignment.label, "status": "queued",
                    "model_provider": assignment.model_provider, "model_name": assignment.model_name,
                    "max_steps": assignment.max_steps, "max_output_tokens": assignment.max_output_tokens,
                }
                append_run_event(session, run_id=child.id, event_type="run.created", payload=details)
                append_run_event(session, run_id=parent_id, event_type="subagent.created", payload=details)
            append_run_event(
                session, run_id=parent_id, event_type="orchestrator.waiting",
                payload={"child_run_ids": [str(child_id) for child_id in child_ids]},
            )
            session.commit()

        tasks: list[asyncio.Task[dict[str, object]]] = []
        try:
            for child_id, assignment in zip(child_ids, assignments, strict=True):
                task = asyncio.create_task(
                    self._run_child(child_id, parent_id, assignment), name=f"subagent:{child_id}",
                )
                self._tasks[child_id] = task
                tasks.append(task)
            # Completion futures wake this coroutine exactly once for the entire batch.
            settled = await asyncio.gather(*tasks, return_exceptions=True)
            results = [
                self._child_result(child_id, parent_id, assignment)
                if isinstance(result, BaseException) else result
                for child_id, assignment, result in zip(child_ids, assignments, settled, strict=True)
            ]
            with self._session_factory() as session:
                append_run_event(
                    session, run_id=parent_id, event_type="orchestrator.resumed",
                    payload={"child_run_ids": [str(child_id) for child_id in child_ids]},
                )
                session.commit()
            return ToolResult(content=json.dumps({"results": results}, ensure_ascii=False))
        finally:
            # Drain before releasing ownership, including cancellation during dispatch.
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            for child_id in child_ids:
                self._tasks.pop(child_id, None)
                # Covers cancellation before a child's coroutine ever got its first turn.
                with self._session_factory() as session:
                    interrupt_agent_run(session, run_id=child_id, reason="delegation_stopped")
                    session.commit()

    async def _run_child(
        self, child_id: UUID, parent_id: UUID, assignment: SubagentTask,
    ) -> dict[str, object]:
        # Local import keeps the orchestration/tool layer out of the base run loop.
        from app.services.text_run import TextRunExecutionError, execute_text_run

        try:
            async with self._slots:
                with self._session_factory() as session:
                    child = session.get(AgentRun, child_id)
                    if child is None or child.status != "queued":
                        raise asyncio.CancelledError
                    append_run_event(
                        session, run_id=parent_id, event_type="subagent.started",
                        payload={"run_id": str(child_id), "label": assignment.label, "status": "running"},
                    )
                    session.commit()
                    async with asyncio.timeout(self._timeout_seconds):
                        await execute_text_run(
                            session, run_id=child_id, max_steps=assignment.max_steps,
                            max_output_tokens=assignment.max_output_tokens, system=WORKER_SYSTEM,
                            adapter_factory=self._adapter_factory, approval_coordinator=self._approvals,
                        )
        except TextRunExecutionError:
            pass  # The ordinary run loop already persisted the failure.
        except TimeoutError:
            with self._session_factory() as session:
                child = session.get(AgentRun, child_id)
                if child is not None and child.status == "interrupted":
                    child.error_code = "subagent_timeout"
                    child.error_message = "Worker exceeded its time limit. Review saved operations before retrying."
                    session.commit()
        except asyncio.CancelledError:
            with self._session_factory() as session:
                interrupt_agent_run(session, run_id=child_id, reason="delegation_stopped")
                session.commit()
        except Exception:
            logger.exception("Subagent %s failed outside its run loop.", child_id)
            with self._session_factory() as session:
                interrupt_agent_run(session, run_id=child_id, reason="execution_task_lost")
                session.commit()

        return self._child_result(child_id, parent_id, assignment)

    def _child_result(
        self, child_id: UUID, parent_id: UUID, assignment: SubagentTask,
    ) -> dict[str, object]:
        with self._session_factory() as session:
            interrupt_agent_run(session, run_id=child_id, reason="execution_task_lost")
            session.commit()
            child = session.get(AgentRun, child_id)
            if child is None:
                raise RuntimeError("Subagent run is unavailable.")
            message = session.scalar(select(Message).where(
                Message.run_id == child_id, Message.role == "assistant",
            ).order_by(Message.created_at.desc(), Message.id.desc()).limit(1))
            report = "" if message is None else "".join(
                str(part.get("text", "")) for part in message.content.get("parts", [])
            )
            steps = list(session.scalars(select(RunEvent).where(
                RunEvent.run_id == child_id, RunEvent.event_type == "model.step.completed",
            ).order_by(RunEvent.sequence)))
            output_limited = bool(steps and steps[-1].payload.get("stop_reason") == "max_tokens")
            result = {
                "run_id": str(child_id), "session_id": str(child.session_id),
                "label": assignment.label, "status": child.status,
                "model_provider": child.model_provider, "model_name": child.model_name,
                "report": report[:RESULT_MAX_CHARACTERS],
                "report_truncated": len(report) > RESULT_MAX_CHARACTERS or output_limited,
                "error": child.error_message,
                "input_tokens": sum(int(step.payload.get("input_tokens") or 0) for step in steps),
                "output_tokens": sum(int(step.payload.get("output_tokens") or 0) for step in steps),
            }
            append_run_event(
                session, run_id=parent_id, event_type="subagent.settled", payload=result,
            )
            session.commit()
            return result
