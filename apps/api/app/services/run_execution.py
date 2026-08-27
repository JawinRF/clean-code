from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentRun
from app.services.run_events import (
    AgentRunNotFoundError,
    append_run_event,
)


class RunCannotStartError(Exception):
    pass


class RunCannotFinishError(Exception):
    pass


def start_agent_run(
    database_session: Session,
    *,
    run_id: UUID,
) -> AgentRun:
    agent_run = database_session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id)
        .with_for_update()
    )

    if agent_run is None:
        raise AgentRunNotFoundError

    if agent_run.status != "queued":
        raise RunCannotStartError(
            f'Run with status "{agent_run.status}" cannot start.'
        )

    started_at = datetime.now(UTC)

    agent_run.status = "running"
    agent_run.started_at = started_at
    database_session.flush()

    append_run_event(
        database_session,
        run_id=run_id,
        event_type="run.started",
        payload={
            "status": "running",
            "started_at": started_at.isoformat(),
        },
    )

    return agent_run


def complete_agent_run(
    database_session: Session,
    *,
    run_id: UUID,
) -> AgentRun:
    agent_run = database_session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id)
        .with_for_update()
    )

    if agent_run is None:
        raise AgentRunNotFoundError

    if agent_run.status != "running":
        raise RunCannotFinishError(
            f'Run with status "{agent_run.status}" cannot complete.'
        )

    finished_at = datetime.now(UTC)

    agent_run.status = "completed"
    agent_run.finished_at = finished_at
    database_session.flush()

    append_run_event(
        database_session,
        run_id=run_id,
        event_type="run.completed",
        payload={
            "status": "completed",
            "finished_at": finished_at.isoformat(),
        },
    )

    return agent_run


def fail_agent_run(
    database_session: Session,
    *,
    run_id: UUID,
    error_code: str,
    error_message: str,
) -> AgentRun:
    agent_run = database_session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id)
        .with_for_update()
    )

    if agent_run is None:
        raise AgentRunNotFoundError

    if agent_run.status != "running":
        raise RunCannotFinishError(
            f'Run with status "{agent_run.status}" cannot fail.'
        )

    finished_at = datetime.now(UTC)

    agent_run.status = "failed"
    agent_run.finished_at = finished_at
    agent_run.error_code = error_code
    agent_run.error_message = error_message
    database_session.flush()

    append_run_event(
        database_session,
        run_id=run_id,
        event_type="run.failed",
        payload={
            "status": "failed",
            "finished_at": finished_at.isoformat(),
            "error_code": error_code,
            "error_message": error_message,
        },
    )

    return agent_run
