from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentRun, Message


class RunMessageBoundaryError(Exception):
    pass


def load_run_messages(
    database_session: Session,
    *,
    agent_run: AgentRun,
) -> list[Message]:
    if agent_run.trigger_message_id is None:
        raise RunMessageBoundaryError(
            "Run does not have an available trigger message."
        )

    statement = (
        select(Message)
        .where(Message.session_id == agent_run.session_id)
        .order_by(
            Message.created_at.asc(),
            Message.id.asc(),
        )
    )
    messages = list(database_session.scalars(statement))

    for index, message in enumerate(messages):
        if message.id == agent_run.trigger_message_id:
            return messages[: index + 1]

    raise RunMessageBoundaryError(
        "Run trigger message was not found in its agent session."
    )
