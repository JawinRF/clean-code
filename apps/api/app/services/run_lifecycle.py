from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentRun
from app.services.run_events import (
    AgentRunNotFoundError,
    append_run_event,
)


class RunAlreadyFinishedError(Exception):
    pass


def request_run_cancellation(
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

    if agent_run.status == "cancelled":
        return agent_run

    if agent_run.status in {"completed", "failed"}:
        raise RunAlreadyFinishedError

    if agent_run.cancel_requested_at is not None:
        return agent_run

    requested_at = datetime.now(UTC)
    agent_run.cancel_requested_at = requested_at

    if agent_run.status == "queued":
        agent_run.status = "cancelled"
        agent_run.finished_at = requested_at
        database_session.flush()

        append_run_event(
            database_session,
            run_id=run_id,
            event_type="run.cancelled",
            payload={
                "status": "cancelled",
                "cancel_requested_at": requested_at.isoformat(),
                "finished_at": requested_at.isoformat(),
            },
        )
    else:
        database_session.flush()

        append_run_event(
            database_session,
            run_id=run_id,
            event_type="run.cancel_requested",
            payload={
                "status": "running",
                "cancel_requested_at": requested_at.isoformat(),
            },
        )

    return agent_run
