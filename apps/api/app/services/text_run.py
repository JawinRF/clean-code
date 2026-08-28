from asyncio import CancelledError
from collections.abc import Callable
from dataclasses import dataclass
import json
from time import monotonic
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import Message
from app.providers import (
    LlmAdapter,
    ProviderContentBlock,
    ProviderMessage,
    ProviderRequest,
    ProviderTextBlock,
    ProviderToolCallBlock,
    ProviderToolResultBlock,
    ResponseCompleted,
    TextDelta,
    ToolCallDelta,
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
    RunWorkspaceNotFoundError,
    load_run_messages,
    load_run_workspace,
)
from app.services.run_events import append_run_event
from app.services.run_execution import (
    cancel_running_agent_run,
    complete_agent_run,
    fail_agent_run,
    start_agent_run,
)
from app.services.tool_calls import (
    AssembledToolCall,
    ToolCallAssembler,
    ToolCallAssemblyError,
)
from app.services.tool_execution import execute_tool_call
from app.tools import ToolRegistry, create_default_tool_registry


AdapterFactory = Callable[[str], LlmAdapter]
TEXT_DELTA_EVENT_MAX_CHARACTERS = 2_000
TEXT_DELTA_EVENT_MAX_INTERVAL_SECONDS = 0.1


class ProviderStreamProtocolError(Exception):
    pass


class TextRunExecutionError(Exception):
    pass


class MaxAgentStepsError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class _ProviderStep:
    text: str
    tool_calls: tuple[AssembledToolCall, ...]
    completion: ResponseCompleted


def _persist_text_delta(
    database_session: Session,
    *,
    run_id: UUID,
    step: int,
    text: str,
) -> None:
    if not text:
        return

    append_run_event(
        database_session,
        run_id=run_id,
        event_type="assistant.delta",
        payload={
            "step": step,
            "text": text,
        },
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
        (
            RunMessageBoundaryError,
            RunWorkspaceNotFoundError,
            UnsupportedMessageRoleError,
        ),
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

    if isinstance(error, MaxAgentStepsError):
        return (
            "max_steps_exceeded",
            "The agent reached the maximum number of model steps.",
        )

    return (
        "text_run_failed",
        "The text run failed.",
    )


async def _stream_provider_step(
    database_session: Session,
    *,
    adapter: LlmAdapter,
    provider_request: ProviderRequest,
    run_id: UUID,
    step: int,
) -> _ProviderStep:
    assistant_text_parts: list[str] = []
    pending_delta_text = ""
    last_delta_flush_at = monotonic()
    tool_call_assembler = ToolCallAssembler()
    completion_event: ResponseCompleted | None = None

    async for event in adapter.stream(provider_request):
        if isinstance(event, TextDelta):
            if completion_event is not None:
                raise ProviderStreamProtocolError(
                    "A text delta arrived after response completion."
                )

            assistant_text_parts.append(event.text)
            pending_delta_text += event.text

            while len(pending_delta_text) >= TEXT_DELTA_EVENT_MAX_CHARACTERS:
                delta_event_text = pending_delta_text[
                    :TEXT_DELTA_EVENT_MAX_CHARACTERS
                ]
                _persist_text_delta(
                    database_session,
                    run_id=run_id,
                    step=step,
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
                    step=step,
                    text=pending_delta_text,
                )
                pending_delta_text = ""
                last_delta_flush_at = monotonic()

            continue

        if isinstance(event, ToolCallDelta):
            if completion_event is not None:
                raise ProviderStreamProtocolError(
                    "A tool-call delta arrived after response completion."
                )

            try:
                tool_call_assembler.add(event)
            except ToolCallAssemblyError as error:
                raise ProviderStreamProtocolError(str(error)) from error

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
        step=step,
        text=pending_delta_text,
    )

    if completion_event is None:
        raise ProviderStreamProtocolError(
            "The provider stream ended without response completion."
        )

    return _ProviderStep(
        text="".join(assistant_text_parts),
        tool_calls=tool_call_assembler.finish(),
        completion=completion_event,
    )


def _tool_arguments_for_provider(
    tool_call: AssembledToolCall,
) -> dict[str, object]:
    try:
        arguments = json.loads(tool_call.arguments_json)
    except json.JSONDecodeError:
        return {}

    if not isinstance(arguments, dict):
        return {}

    return arguments


async def execute_text_run(
    database_session: Session,
    *,
    run_id: UUID,
    max_output_tokens: int,
    max_steps: int = 8,
    system: str | None = None,
    adapter_factory: AdapterFactory = create_llm_adapter,
    tool_registry: ToolRegistry | None = None,
) -> Message:
    if max_output_tokens <= 0:
        raise ValueError("max_output_tokens must be greater than zero.")

    if max_steps <= 0:
        raise ValueError("max_steps must be greater than zero.")

    agent_run = start_agent_run(
        database_session,
        run_id=run_id,
    )
    session_id = agent_run.session_id
    model_provider = agent_run.model_provider
    model_name = agent_run.model_name
    database_session.commit()

    try:
        workspace = load_run_workspace(
            database_session,
            agent_run=agent_run,
        )
        registry = tool_registry or create_default_tool_registry(
            workspace_root=workspace.root_path,
        )
        run_messages = load_run_messages(
            database_session,
            agent_run=agent_run,
        )
        provider_request = build_provider_request(
            model=model_name,
            messages=run_messages,
            max_output_tokens=max_output_tokens,
            system=system,
            tools=registry.definitions(),
        )
        database_session.commit()

        adapter = adapter_factory(model_provider)
        provider_messages = list(provider_request.messages)

        try:
            if adapter.provider_id != model_provider:
                raise ProviderStreamProtocolError(
                    "The adapter provider ID does not match the run."
                )

            for step in range(1, max_steps + 1):
                append_run_event(
                    database_session,
                    run_id=run_id,
                    event_type="model.step.started",
                    payload={"step": step},
                )
                database_session.commit()

                step_request = ProviderRequest(
                    model=provider_request.model,
                    messages=tuple(provider_messages),
                    max_output_tokens=provider_request.max_output_tokens,
                    system=provider_request.system,
                    tools=registry.definitions(),
                )
                provider_step = await _stream_provider_step(
                    database_session,
                    adapter=adapter,
                    provider_request=step_request,
                    run_id=run_id,
                    step=step,
                )

                append_run_event(
                    database_session,
                    run_id=run_id,
                    event_type="model.step.completed",
                    payload={
                        "step": step,
                        "stop_reason": provider_step.completion.stop_reason,
                        "tool_call_count": len(provider_step.tool_calls),
                    },
                )
                database_session.commit()

                if not provider_step.tool_calls:
                    assistant_message = Message(
                        session_id=session_id,
                        run_id=run_id,
                        role="assistant",
                        content={
                            "parts": [
                                {
                                    "type": "text",
                                    "text": provider_step.text,
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
                            "step": step,
                            "stop_reason": (
                                provider_step.completion.stop_reason
                            ),
                        },
                    )
                    complete_agent_run(
                        database_session,
                        run_id=run_id,
                    )
                    database_session.commit()

                    return assistant_message

                assistant_blocks: list[ProviderContentBlock] = []

                if provider_step.text:
                    assistant_blocks.append(
                        ProviderTextBlock(text=provider_step.text)
                    )

                tool_result_blocks: list[ProviderToolResultBlock] = []

                for tool_call in provider_step.tool_calls:
                    assistant_blocks.append(
                        ProviderToolCallBlock(
                            call_id=tool_call.call_id,
                            name=tool_call.name,
                            arguments=_tool_arguments_for_provider(tool_call),
                        )
                    )
                    append_run_event(
                        database_session,
                        run_id=run_id,
                        event_type="tool.call.proposed",
                        payload={
                            "step": step,
                            "call_id": tool_call.call_id,
                            "name": tool_call.name,
                            "arguments_json": tool_call.arguments_json,
                        },
                    )
                    append_run_event(
                        database_session,
                        run_id=run_id,
                        event_type="tool.execution.started",
                        payload={
                            "step": step,
                            "call_id": tool_call.call_id,
                            "name": tool_call.name,
                        },
                    )
                    database_session.commit()

                    tool_result = await execute_tool_call(
                        registry=registry,
                        name=tool_call.name,
                        arguments_json=tool_call.arguments_json,
                    )
                    append_run_event(
                        database_session,
                        run_id=run_id,
                        event_type="tool.execution.completed",
                        payload={
                            "step": step,
                            "call_id": tool_call.call_id,
                            "name": tool_call.name,
                            "content": tool_result.content,
                            "is_error": tool_result.is_error,
                        },
                    )
                    database_session.commit()

                    tool_result_blocks.append(
                        ProviderToolResultBlock(
                            call_id=tool_call.call_id,
                            content=tool_result.content,
                            is_error=tool_result.is_error,
                        )
                    )

                provider_messages.append(
                    ProviderMessage(
                        role="assistant",
                        content=tuple(assistant_blocks),
                    )
                )
                provider_messages.append(
                    ProviderMessage(
                        role="user",
                        content=tuple(tool_result_blocks),
                    )
                )

            raise MaxAgentStepsError
        finally:
            await adapter.close()
    except CancelledError:
        database_session.rollback()
        cancel_running_agent_run(
            database_session,
            run_id=run_id,
        )
        database_session.commit()
        raise
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
