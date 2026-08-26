from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AgentRun, RunEvent


class AgentRunNotFoundError(Exception):
    pass


def append_run_event(
    database_session: Session,
    *,
    run_id: UUID,
    event_type: str,
    payload: dict[str, object],
) -> RunEvent:
    agent_run = database_session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id)
        .with_for_update()
    )

    if agent_run is None:
        raise AgentRunNotFoundError

    # Alternative: store next_event_sequence on AgentRun and increment it
    # atomically instead of calculating MAX(sequence).
    next_sequence = database_session.scalar(
        select(
            func.coalesce(
                func.max(RunEvent.sequence),
                -1,
            )
            + 1
        ).where(RunEvent.run_id == run_id)
    )

    if next_sequence is None:
        raise RuntimeError(
            "Could not determine the next run event sequence."
        )

    run_event = RunEvent(
        run_id=run_id,
        sequence=next_sequence,
        event_type=event_type,
        payload=payload,
    )

    database_session.add(run_event)
    database_session.flush()

    return run_event
