import asyncio
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionFactory
from app.models import AgentRun, ToolApproval
from app.services.run_events import AgentRunNotFoundError, append_run_event


ToolApprovalDecision = Literal["approved", "rejected"]
ToolApprovalRequest = ToolApproval
DatabaseSessionFactory = Callable[[], AbstractContextManager[Session]]


class ToolApprovalNotFoundError(Exception):
    pass


class ToolApprovalConflictError(Exception):
    pass


def _resolve_approval(
    database_session: Session,
    approval: ToolApproval,
    decision: str,
) -> None:
    approval.status = decision
    approval.resolved_at = datetime.now(UTC)
    database_session.flush()
    append_run_event(
        database_session,
        run_id=approval.run_id,
        event_type="tool.approval.decided",
        payload={
            "approval_id": str(approval.id),
            "call_id": approval.call_id,
            "name": approval.tool_name,
            "decision": decision,
        },
    )


def resolve_run_approvals(
    database_session: Session,
    *,
    run_id: UUID,
    outcome: Literal["cancelled", "interrupted"],
) -> None:
    # Always lock the run before its approvals, including cancellation and recovery.
    database_session.scalar(select(AgentRun).where(AgentRun.id == run_id).with_for_update())
    approvals = database_session.scalars(
        select(ToolApproval)
        .where(ToolApproval.run_id == run_id, ToolApproval.status == "pending")
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    for approval in approvals:
        _resolve_approval(database_session, approval, outcome)


class ToolApprovalCoordinator:
    def __init__(
        self,
        *,
        session_factory: DatabaseSessionFactory = SessionFactory,
    ) -> None:
        self._session_factory = session_factory
        self._decisions: dict[UUID, asyncio.Event] = {}

    def open(
        self,
        database_session: Session,
        *,
        run_id: UUID,
        call_id: str,
        tool_name: str,
        reason: str,
        arguments: dict[str, object],
        file_preview: dict[str, object] | None = None,
    ) -> ToolApproval:
        run = database_session.scalar(
            select(AgentRun).where(AgentRun.id == run_id)
            .with_for_update().execution_options(populate_existing=True)
        )
        if run is None:
            raise AgentRunNotFoundError
        if run.status != "running" or run.cancel_requested_at is not None:
            raise ToolApprovalConflictError("The run is no longer accepting tool approvals.")

        approval = ToolApproval(
            run_id=run_id, call_id=call_id, tool_name=tool_name,
            reason=reason, arguments=arguments,
            file_preview=file_preview,
        )
        database_session.add(approval)
        database_session.flush()
        append_run_event(
            database_session,
            run_id=run_id,
            event_type="tool.approval.requested",
            payload={
                "approval_id": str(approval.id), "call_id": call_id,
                "name": tool_name, "reason": reason,
            },
        )
        return approval

    async def wait(self, approval_id: UUID) -> ToolApprovalDecision:
        decision_event = self._decisions.setdefault(approval_id, asyncio.Event())
        try:
            while True:
                decision_event.clear()
                with self._session_factory() as database_session:
                    approval = database_session.get(ToolApproval, approval_id)
                    if approval is None:
                        raise ToolApprovalNotFoundError
                    outcome = approval.status

                if outcome == "approved":
                    return "approved"
                if outcome == "rejected":
                    return "rejected"
                if outcome != "pending":
                    raise asyncio.CancelledError
                # Subscribe before reading; no DB connection is held while asleep.
                await decision_event.wait()
        finally:
            self._decisions.pop(approval_id, None)

    def notify_decision(self, approval_id: UUID) -> None:
        """Wake a waiter only AFTER the API transaction commits its decision."""
        decision_event = self._decisions.get(approval_id)
        if decision_event is not None:
            decision_event.set()

    def decide(
        self,
        database_session: Session,
        *,
        run_id: UUID,
        approval_id: UUID,
        decision: ToolApprovalDecision,
    ) -> ToolApproval:
        run = database_session.scalar(
            select(AgentRun).where(AgentRun.id == run_id)
            .with_for_update().execution_options(populate_existing=True)
        )
        if run is None:
            raise AgentRunNotFoundError
        approval = database_session.scalar(
            select(ToolApproval)
            .where(ToolApproval.id == approval_id, ToolApproval.run_id == run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if approval is None:
            raise ToolApprovalNotFoundError
        if approval.status == decision:
            return approval
        if approval.status != "pending":
            raise ToolApprovalConflictError("This approval has already been resolved.")
        if run.status != "running" or run.cancel_requested_at is not None:
            raise ToolApprovalConflictError("The run has stopped. This action cannot be approved.")

        _resolve_approval(database_session, approval, decision)
        return approval

    def pending_for_run(
        self, database_session: Session, run_id: UUID, *, include_resolved: bool = False,
        include_children: bool = False,
    ) -> list[ToolApproval]:
        run_ids = select(AgentRun.id).where(
            (AgentRun.id == run_id) | (AgentRun.parent_run_id == run_id)
        ) if include_children else [run_id]
        statement = select(ToolApproval).where(ToolApproval.run_id.in_(run_ids))
        if not include_resolved:
            statement = statement.where(ToolApproval.status == "pending")
        return list(database_session.scalars(
            statement.order_by(ToolApproval.requested_at, ToolApproval.id)
        ))
