import asyncio
from dataclasses import dataclass
import logging
from math import floor
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentRun, Message, RunEvent
from app.providers import (
    LlmAdapter,
    ProviderMessage,
    ProviderRequest,
    ProviderTextBlock,
    ResponseCompleted,
    TextDelta,
    ToolCallDelta,
)
from app.services.context_tokens import (
    estimate_provider_message_tokens,
    estimate_provider_request_tokens,
    select_compactable_prefix,
)
from app.services.provider_requests import build_provider_message
from app.services.run_events import append_run_event


logger = logging.getLogger(__name__)

COMPACTION_THRESHOLD_RATIO = 0.8
COMPACTION_RETAIN_RATIO = 0.16
COMPACTION_MAX_OUTPUT_TOKENS = 8_192
COMPACTION_MAX_ATTEMPTS = 2

SUMMARY_OPEN_TAG = "<compacted-summary>"
SUMMARY_CLOSE_TAG = "</compacted-summary>"

CHECKPOINT_PREAMBLE = (
    "This is an automatically generated checkpoint condensing an earlier "
    "span of the conversation to free up context. Treat the captured context "
    "as established background and build on it without restating it. Continue "
    "the task directly from the messages that follow, without acknowledging "
    "this checkpoint."
)

COMPACTION_INSTRUCTION = "\n".join(
    (
        "You are now acting as a compaction engine for this AI coding "
        "assistant. Condense the conversation ABOVE into a structured "
        "checkpoint that lets another model resume the work with no loss of "
        "essential context.",
        "",
        "Output EXACTLY the Markdown structure below. Keep every section in "
        "order. Use terse bullets, not prose paragraphs. Write \"(none)\" for "
        "an empty section. Never drop a section.",
        "",
        "## Primary Request and Intent",
        "- The user's original and evolving goals. Quote exact wording when "
        "it matters.",
        "",
        "## Key Technical Concepts",
        "- Technologies, frameworks, patterns, and conventions in use.",
        "",
        "## Files and Code",
        "- Exact path, why it matters, and key changes or snippets.",
        "",
        "## Errors and Fixes",
        "- Error, resolution, and related user feedback.",
        "",
        "## Pending Jobs",
        "- Explicitly requested work that is not complete.",
        "",
        "## Current Work",
        "- Precisely what was in progress at this checkpoint.",
        "",
        "## Next Step",
        "- The single next action that follows the latest request, or "
        "\"(none)\".",
        "",
        "## Critical Context",
        "- Decisions and reasons, constraints, user preferences, open "
        "questions, and data needed to continue.",
        "",
        "Rules:",
        "- Write concise English engineering prose.",
        "- Preserve exact file paths, commands, error strings, identifiers, "
        "numeric values, function signatures, and syntax fragments.",
        "- Capture user feedback and explicit instructions faithfully.",
        "- Do not mention this summarization request or say that the context "
        "was compacted.",
        "- Output only the checkpoint text. Do not call tools or take another "
        "action.",
        "- If the conversation already contains a <compacted-summary> block, "
        "merge its still-valid facts with newer information. Do not copy it "
        "verbatim.",
    )
)


class InvalidCompactionCheckpointError(RuntimeError):
    pass


class CompactionSummaryError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ContextNode:
    message: ProviderMessage
    through_message_id: UUID | None


@dataclass(frozen=True, slots=True)
class _StoredCheckpoint:
    summary: str
    through_message_id: UUID


def _checkpoint_message(summary: str) -> ProviderMessage:
    return ProviderMessage(
        role="user",
        content=(
            ProviderTextBlock(
                text=(
                    f"{CHECKPOINT_PREAMBLE}\n\n"
                    f"{SUMMARY_OPEN_TAG}\n"
                    f"{summary.strip()}\n"
                    f"{SUMMARY_CLOSE_TAG}"
                )
            ),
        ),
    )


def _stored_checkpoint(event: RunEvent) -> _StoredCheckpoint:
    summary = event.payload.get("summary")
    through_message_id = event.payload.get("through_message_id")

    if not isinstance(summary, str) or not summary.strip():
        raise InvalidCompactionCheckpointError(
            "A stored compaction checkpoint has no summary text."
        )

    try:
        parsed_message_id = UUID(str(through_message_id))
    except (TypeError, ValueError) as error:
        raise InvalidCompactionCheckpointError(
            "A stored compaction checkpoint has an invalid message boundary."
        ) from error

    return _StoredCheckpoint(
        summary=summary,
        through_message_id=parsed_message_id,
    )


def load_context_nodes(
    database_session: Session,
    *,
    session_id: UUID,
    messages: list[Message],
) -> list[ContextNode]:
    message_indexes = {
        message.id: index
        for index, message in enumerate(messages)
    }
    statement = (
        select(RunEvent)
        .join(AgentRun, RunEvent.run_id == AgentRun.id)
        .where(
            AgentRun.session_id == session_id,
            RunEvent.event_type == "context.compaction.completed",
        )
        .order_by(
            RunEvent.created_at.desc(),
            RunEvent.id.desc(),
        )
    )

    checkpoint: _StoredCheckpoint | None = None

    for event in database_session.scalars(statement):
        candidate = _stored_checkpoint(event)

        if candidate.through_message_id in message_indexes:
            checkpoint = candidate
            break

    nodes: list[ContextNode] = []
    start_index = 0

    if checkpoint is not None:
        nodes.append(
            ContextNode(
                message=_checkpoint_message(checkpoint.summary),
                through_message_id=checkpoint.through_message_id,
            )
        )
        start_index = message_indexes[checkpoint.through_message_id] + 1

    nodes.extend(
        ContextNode(
            message=build_provider_message(message),
            through_message_id=message.id,
        )
        for message in messages[start_index:]
    )

    return nodes


async def _summarize_prefix(
    *,
    adapter: LlmAdapter,
    request: ProviderRequest,
    prefix: list[ContextNode],
) -> tuple[str, str | None]:
    summary_request = ProviderRequest(
        model=request.model,
        messages=(
            *(node.message for node in prefix),
            ProviderMessage(
                role="user",
                content=(
                    ProviderTextBlock(text=COMPACTION_INSTRUCTION),
                ),
            ),
        ),
        max_output_tokens=COMPACTION_MAX_OUTPUT_TOKENS,
        system=request.system,
        tools=request.tools,
    )
    text_parts: list[str] = []
    completion: ResponseCompleted | None = None

    async for event in adapter.stream(summary_request):
        if isinstance(event, TextDelta):
            if completion is not None:
                raise CompactionSummaryError(
                    "Compaction text arrived after response completion."
                )

            text_parts.append(event.text)
            continue

        if isinstance(event, ToolCallDelta):
            raise CompactionSummaryError(
                "The compaction model attempted to call a tool."
            )

        if isinstance(event, ResponseCompleted):
            if completion is not None:
                raise CompactionSummaryError(
                    "The compaction response completed more than once."
                )

            completion = event
            continue

        raise CompactionSummaryError(
            "The compaction model returned an unsupported event."
        )

    if completion is None:
        raise CompactionSummaryError(
            "The compaction stream ended without response completion."
        )

    if completion.stop_reason == "max_tokens":
        raise CompactionSummaryError(
            "Compaction reached its output token limit."
        )

    summary = "".join(text_parts).strip()

    if not summary:
        raise CompactionSummaryError(
            "The compaction model returned an empty summary."
        )

    return summary, completion.stop_reason


def _latest_message_boundary(
    prefix: list[ContextNode],
) -> UUID | None:
    for node in reversed(prefix):
        if node.through_message_id is not None:
            return node.through_message_id

    return None


async def compact_context_if_needed(
    database_session: Session,
    *,
    adapter: LlmAdapter,
    request: ProviderRequest,
    nodes: list[ContextNode],
    run_id: UUID,
    step: int,
    provider_id: str,
    context_window: int,
) -> list[ContextNode]:
    request_with_nodes = ProviderRequest(
        model=request.model,
        messages=tuple(node.message for node in nodes),
        max_output_tokens=request.max_output_tokens,
        system=request.system,
        tools=request.tools,
    )
    estimated_input_tokens = estimate_provider_request_tokens(
        request_with_nodes
    )
    threshold_tokens = floor(
        context_window * COMPACTION_THRESHOLD_RATIO
    )

    if estimated_input_tokens < threshold_tokens:
        return nodes

    retain_tokens = floor(context_window * COMPACTION_RETAIN_RATIO)
    keep_from = select_compactable_prefix(
        [node.message for node in nodes],
        retain_tokens=retain_tokens,
    )

    if keep_from is None:
        return nodes

    prefix = nodes[:keep_from]
    through_message_id = _latest_message_boundary(prefix)

    if through_message_id is None:
        return nodes

    compaction_id = uuid4()
    append_run_event(
        database_session,
        run_id=run_id,
        event_type="context.compaction.started",
        payload={
            "compaction_id": str(compaction_id),
            "step": step,
            "provider": provider_id,
            "model": request.model,
            "estimated_input_tokens": estimated_input_tokens,
            "threshold_tokens": threshold_tokens,
            "retain_tokens": retain_tokens,
        },
    )
    database_session.commit()

    try:
        summary, stop_reason = await _summarize_prefix(
            adapter=adapter,
            request=request_with_nodes,
            prefix=prefix,
        )
        checkpoint = _checkpoint_message(summary)
        shadowed_tokens = sum(
            estimate_provider_message_tokens(node.message)
            for node in prefix
        )
        checkpoint_tokens = estimate_provider_message_tokens(checkpoint)

        if checkpoint_tokens >= shadowed_tokens:
            raise CompactionSummaryError(
                "The compaction summary did not reduce the selected context."
            )

        append_run_event(
            database_session,
            run_id=run_id,
            event_type="context.compaction.completed",
            payload={
                "compaction_id": str(compaction_id),
                "step": step,
                "provider": provider_id,
                "model": request.model,
                "summary": summary,
                "through_message_id": str(through_message_id),
                "shadowed_node_count": len(prefix),
                "shadowed_estimated_tokens": shadowed_tokens,
                "checkpoint_estimated_tokens": checkpoint_tokens,
                "stop_reason": stop_reason,
            },
        )
        database_session.commit()

        return [
            ContextNode(
                message=checkpoint,
                through_message_id=through_message_id,
            ),
            *nodes[keep_from:],
        ]
    except asyncio.CancelledError:
        append_run_event(
            database_session,
            run_id=run_id,
            event_type="context.compaction.failed",
            payload={
                "compaction_id": str(compaction_id),
                "step": step,
                "reason": "cancelled",
            },
        )
        database_session.commit()
        raise
    except Exception as error:
        logger.warning(
            "Context compaction failed for run %s: %s",
            run_id,
            error,
        )
        append_run_event(
            database_session,
            run_id=run_id,
            event_type="context.compaction.failed",
            payload={
                "compaction_id": str(compaction_id),
                "step": step,
                "reason": "summary_failed",
                "error_type": type(error).__name__,
            },
        )
        database_session.commit()
        return nodes
