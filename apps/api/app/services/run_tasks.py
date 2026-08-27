import asyncio
import logging
from collections.abc import Callable
from contextlib import AbstractContextManager
from uuid import UUID

from sqlalchemy.orm import Session

from app.database import SessionFactory
from app.providers.registry import create_llm_adapter
from app.services.text_run import (
    AdapterFactory,
    TextRunExecutionError,
    execute_text_run,
)


logger = logging.getLogger(__name__)

DatabaseSessionFactory = Callable[
    [],
    AbstractContextManager[Session],
]


class RunTaskAlreadyActiveError(Exception):
    pass


class RunTaskSupervisorClosedError(Exception):
    pass


class RunTaskSupervisor:
    def __init__(
        self,
        *,
        session_factory: DatabaseSessionFactory = SessionFactory,
        adapter_factory: AdapterFactory = create_llm_adapter,
    ) -> None:
        self._session_factory = session_factory
        self._adapter_factory = adapter_factory
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        self._closed = False

    @property
    def active_run_ids(self) -> frozenset[UUID]:
        return frozenset(self._tasks)

    @property
    def closed(self) -> bool:
        return self._closed

    def start(
        self,
        *,
        run_id: UUID,
        max_output_tokens: int,
        system: str | None = None,
    ) -> asyncio.Task[None]:
        if self._closed:
            raise RunTaskSupervisorClosedError(
                "The run task supervisor is closed."
            )

        if max_output_tokens <= 0:
            raise ValueError(
                "max_output_tokens must be greater than zero."
            )

        existing_task = self._tasks.get(run_id)

        if existing_task is not None:
            if not existing_task.done():
                raise RunTaskAlreadyActiveError(
                    f"Run {run_id} already has an active task."
                )

            self._settle(run_id, existing_task)

        task = asyncio.create_task(
            self._execute(
                run_id=run_id,
                max_output_tokens=max_output_tokens,
                system=system,
            ),
            name=f"agent-run:{run_id}",
        )
        self._tasks[run_id] = task
        task.add_done_callback(
            lambda settled_task: self._settle(
                run_id,
                settled_task,
            )
        )

        return task

    def cancel(self, run_id: UUID) -> bool:
        task = self._tasks.get(run_id)

        if task is None or task.done():
            return False

        return task.cancel()

    async def close(self) -> None:
        if self._closed:
            return

        self._closed = True
        tasks = tuple(self._tasks.values())

        for task in tasks:
            task.cancel()

        if tasks:
            await asyncio.gather(
                *tasks,
                return_exceptions=True,
            )

        self._tasks.clear()

    async def _execute(
        self,
        *,
        run_id: UUID,
        max_output_tokens: int,
        system: str | None,
    ) -> None:
        with self._session_factory() as database_session:
            try:
                await execute_text_run(
                    database_session,
                    run_id=run_id,
                    max_output_tokens=max_output_tokens,
                    system=system,
                    adapter_factory=self._adapter_factory,
                )
            except TextRunExecutionError:
                return

    def _settle(
        self,
        run_id: UUID,
        settled_task: asyncio.Task[None],
    ) -> None:
        current_task = self._tasks.get(run_id)

        if current_task is not settled_task:
            return

        del self._tasks[run_id]

        try:
            settled_task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception(
                "Unexpected error in agent run task %s.",
                run_id,
            )
