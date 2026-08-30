import json
from math import ceil

from app.providers import (
    ProviderMessage,
    ProviderRequest,
    ProviderTextBlock,
    ProviderToolCallBlock,
    ProviderToolResultBlock,
)


CHARS_PER_TOKEN = 4
BLOCK_OVERHEAD = 4
ROLE_OVERHEAD = 4


def _estimate_text(text: str) -> int:
    return ceil(len(text) / CHARS_PER_TOKEN)


def estimate_provider_message_tokens(message: ProviderMessage) -> int:
    tokens = ROLE_OVERHEAD

    for block in message.content:
        if isinstance(block, ProviderTextBlock):
            tokens += _estimate_text(block.text) + BLOCK_OVERHEAD
            continue

        if isinstance(block, ProviderToolCallBlock):
            arguments_json = json.dumps(
                block.arguments,
                separators=(",", ":"),
                sort_keys=True,
            )
            tokens += (
                _estimate_text(block.name)
                + _estimate_text(arguments_json)
                + BLOCK_OVERHEAD
            )
            continue

        if isinstance(block, ProviderToolResultBlock):
            tokens += _estimate_text(block.content) + (2 * BLOCK_OVERHEAD)
            continue

        raise TypeError("Unsupported provider content block.")

    return tokens


def estimate_provider_request_tokens(request: ProviderRequest) -> int:
    tokens = sum(
        estimate_provider_message_tokens(message)
        for message in request.messages
    )

    if request.system is not None:
        tokens += _estimate_text(request.system) + ROLE_OVERHEAD

    if request.tools:
        tools_json = json.dumps(
            [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }
                for tool in request.tools
            ],
            separators=(",", ":"),
            sort_keys=True,
        )
        tokens += _estimate_text(tools_json) + BLOCK_OVERHEAD

    return tokens


def _tool_call_ids(message: ProviderMessage) -> set[str]:
    return {
        block.call_id
        for block in message.content
        if isinstance(block, ProviderToolCallBlock)
    }


def _tool_result_ids(message: ProviderMessage) -> set[str]:
    return {
        block.call_id
        for block in message.content
        if isinstance(block, ProviderToolResultBlock)
    }


def _boundary_splits_tool_pair(
    messages: list[ProviderMessage],
    keep_from: int,
) -> bool:
    prefix_calls: set[str] = set()
    prefix_results: set[str] = set()
    tail_calls: set[str] = set()
    tail_results: set[str] = set()

    for message in messages[:keep_from]:
        prefix_calls.update(_tool_call_ids(message))
        prefix_results.update(_tool_result_ids(message))

    for message in messages[keep_from:]:
        tail_calls.update(_tool_call_ids(message))
        tail_results.update(_tool_result_ids(message))

    return bool(
        (prefix_calls & tail_results)
        or (prefix_results & tail_calls)
    )


def select_compactable_prefix(
    messages: list[ProviderMessage],
    *,
    retain_tokens: int,
) -> int | None:
    if len(messages) < 2:
        return None

    accumulated = 0
    keep_from = len(messages)

    for index in range(len(messages) - 1, -1, -1):
        accumulated += estimate_provider_message_tokens(messages[index])
        keep_from = index

        if accumulated >= retain_tokens:
            break

    if keep_from == 0:
        return None

    while keep_from > 0:
        retained_head = messages[keep_from]

        if (
            retained_head.role == "user"
            or _boundary_splits_tool_pair(messages, keep_from)
        ):
            keep_from -= 1
            continue

        break

    if keep_from == 0:
        return None

    return keep_from
