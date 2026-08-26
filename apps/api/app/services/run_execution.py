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
