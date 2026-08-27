from collections.abc import Callable
from time import monotonic
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import Message
from app.providers import (
    LlmAdapter,
    ResponseCompleted,
    TextDelta,
)
from app.providers.registry import (
    ProviderNotConfiguredError,
    UnsupportedProviderError,
    create_llm_adapter,
)
from app.services.provider_requests import (
    UnsupportedMessageRoleError,
    build_provider_request,
)
from app.services.run_context import (
    RunMessageBoundaryError,
    load_run_messages,
)
from app.services.run_events import append_run_event
from app.services.run_execution import (
    complete_agent_run,
    fail_agent_run,
    start_agent_run,
)


AdapterFactory = Callable[[str], LlmAdapter]
TEXT_DELTA_EVENT_MAX_CHARACTERS = 2_000
TEXT_DELTA_EVENT_MAX_INTERVAL_SECONDS = 0.1


class ProviderStreamProtocolError(Exception):
    pass


class TextRunExecutionError(Exception):
    pass


def _persist_text_delta(
    database_session: Session,
    *,
    run_id: UUID,
    text: str,
) -> None:
    if not text:
        return

    append_run_event(
        database_session,
        run_id=run_id,
        event_type="assistant.delta",
        payload={"text": text},
    )
    database_session.commit()


def _safe_failure_details(error: Exception) -> tuple[str, str]:
    if isinstance(error, ProviderNotConfiguredError):
        return (
            "provider_not_configured",
            "The selected model provider is not configured.",
        )

    if isinstance(error, UnsupportedProviderError):
        return (
            "unsupported_provider",
            "The selected model provider is not supported.",
        )

    if isinstance(
        error,
        (RunMessageBoundaryError, UnsupportedMessageRoleError),
    ):
        return (
            "invalid_run_context",
            "The model request context could not be built.",
        )

    if isinstance(error, ProviderStreamProtocolError):
        return (
            "provider_stream_protocol_error",
            "The model provider returned an invalid event stream.",
        )

    return (
        "text_run_failed",
        "The text run failed.",
    )


async def execute_text_run(
    database_session: Session,
    *,
    run_id: UUID,
    max_output_tokens: int,
    system: str | None = None,
    adapter_factory: AdapterFactory = create_llm_adapter,
) -> Message:
    if max_output_tokens <= 0:
        raise ValueError("max_output_tokens must be greater than zero.")

    agent_run = start_agent_run(
        database_session,
        run_id=run_id,
    )
    session_id = agent_run.session_id
    model_provider = agent_run.model_provider
    model_name = agent_run.model_name
    database_session.commit()

    try:
        run_messages = load_run_messages(
            database_session,
            agent_run=agent_run,
        )
        provider_request = build_provider_request(
            model=model_name,
            messages=run_messages,
            max_output_tokens=max_output_tokens,
            system=system,
        )
        database_session.commit()

        adapter = adapter_factory(model_provider)
        assistant_text_parts: list[str] = []
        pending_delta_text = ""
        last_delta_flush_at = monotonic()
        completion_event: ResponseCompleted | None = None

        try:
            if adapter.provider_id != model_provider:
                raise ProviderStreamProtocolError(
                    "The adapter provider ID does not match the run."
                )

            async for event in adapter.stream(provider_request):
                if isinstance(event, TextDelta):
                    if completion_event is not None:
                        raise ProviderStreamProtocolError(
                            "A text delta arrived after response completion."
                        )

                    assistant_text_parts.append(event.text)
                    pending_delta_text += event.text

                    while (
                        len(pending_delta_text)
                        >= TEXT_DELTA_EVENT_MAX_CHARACTERS
                    ):
                        delta_event_text = pending_delta_text[
                            :TEXT_DELTA_EVENT_MAX_CHARACTERS
                        ]
                        _persist_text_delta(
                            database_session,
                            run_id=run_id,
                            text=delta_event_text,
                        )
                        pending_delta_text = pending_delta_text[
                            TEXT_DELTA_EVENT_MAX_CHARACTERS:
                        ]
                        last_delta_flush_at = monotonic()

                    if (
                        pending_delta_text
                        and monotonic() - last_delta_flush_at
                        >= TEXT_DELTA_EVENT_MAX_INTERVAL_SECONDS
                    ):
                        _persist_text_delta(
                            database_session,
                            run_id=run_id,
                            text=pending_delta_text,
                        )
                        pending_delta_text = ""
                        last_delta_flush_at = monotonic()

                    continue

                if isinstance(event, ResponseCompleted):
                    if completion_event is not None:
                        raise ProviderStreamProtocolError(
                            "The provider completed the response more than once."
                        )

                    completion_event = event
                    continue

                raise ProviderStreamProtocolError(
                    "The provider returned an unsupported event type."
                )

            _persist_text_delta(
                database_session,
                run_id=run_id,
                text=pending_delta_text,
            )
        finally:
            await adapter.close()

        if completion_event is None:
            raise ProviderStreamProtocolError(
                "The provider stream ended without response completion."
            )

        assistant_message = Message(
            session_id=session_id,
            run_id=run_id,
            role="assistant",
            content={
                "parts": [
                    {
                        "type": "text",
                        "text": "".join(assistant_text_parts),
                    },
                ],
            },
        )
        database_session.add(assistant_message)
        database_session.flush()

        append_run_event(
            database_session,
            run_id=run_id,
            event_type="assistant.completed",
            payload={
                "message_id": str(assistant_message.id),
                "stop_reason": completion_event.stop_reason,
            },
        )
        complete_agent_run(
            database_session,
            run_id=run_id,
        )
        database_session.commit()

        return assistant_message
    except Exception as error:
        database_session.rollback()
        error_code, error_message = _safe_failure_details(error)

        fail_agent_run(
            database_session,
            run_id=run_id,
            error_code=error_code,
            error_message=error_message,
        )
        database_session.commit()

        raise TextRunExecutionError(error_message) from error
