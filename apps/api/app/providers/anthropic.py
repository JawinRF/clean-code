from collections.abc import AsyncIterator

from anthropic import AsyncAnthropic, omit
from anthropic.types import (
    MessageParam,
    TextBlockParam,
    ToolParam,
    ToolResultBlockParam,
    ToolUseBlockParam,
)

from app.providers.base import (
    ProviderEvent,
    ProviderMessage,
    ProviderRequest,
    ProviderTextBlock,
    ProviderToolCallBlock,
    ProviderToolResultBlock,
    ResponseCompleted,
    TextDelta,
    ToolCallDelta,
)


def _to_anthropic_messages(
    provider_messages: tuple[ProviderMessage, ...],
) -> list[MessageParam]:
    messages: list[MessageParam] = []

    for message in provider_messages:
        content: list[
            TextBlockParam | ToolUseBlockParam | ToolResultBlockParam
        ] = []

        for block in message.content:
            if isinstance(block, ProviderTextBlock):
                content.append(
                    {
                        "type": "text",
                        "text": block.text,
                    }
                )
                continue

            if isinstance(block, ProviderToolCallBlock):
                content.append(
                    {
                        "type": "tool_use",
                        "id": block.call_id,
                        "name": block.name,
                        "input": block.arguments,
                    }
                )
                continue

            if isinstance(block, ProviderToolResultBlock):
                content.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.call_id,
                        "content": block.content,
                        "is_error": block.is_error,
                    }
                )
                continue

            raise TypeError("Unsupported provider content block.")

        messages.append(
            {
                "role": message.role,
                "content": content,
            }
        )

    return messages


class AnthropicAdapter:
    def __init__(self, *, api_key: str) -> None:
        if not api_key.strip():
            raise ValueError("Anthropic API key must not be empty.")

        self._client = AsyncAnthropic(api_key=api_key)

    @property
    def provider_id(self) -> str:
        return "anthropic"

    async def stream(
        self,
        request: ProviderRequest,
    ) -> AsyncIterator[ProviderEvent]:
        messages = _to_anthropic_messages(request.messages)
        tools: list[ToolParam] = [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            for tool in request.tools
        ]
        tool_call_ids_by_index: dict[int, str] = {}

        async with self._client.messages.stream(
            model=request.model,
            messages=messages,
            max_tokens=request.max_output_tokens,
            system=request.system if request.system is not None else omit,
            tools=tools if tools else omit,
        ) as stream:
            async for event in stream:
                if (
                    event.type == "content_block_start"
                    and event.content_block.type == "tool_use"
                ):
                    tool_call_ids_by_index[event.index] = (
                        event.content_block.id
                    )
                    yield ToolCallDelta(
                        call_id=event.content_block.id,
                        name=event.content_block.name,
                        arguments_delta="",
                    )
                    continue

                if (
                    event.type == "content_block_delta"
                    and event.delta.type == "text_delta"
                ):
                    yield TextDelta(text=event.delta.text)
                    continue

                if (
                    event.type == "content_block_delta"
                    and event.delta.type == "input_json_delta"
                ):
                    call_id = tool_call_ids_by_index.get(event.index)

                    if call_id is None:
                        raise RuntimeError(
                            "Anthropic streamed tool input before its tool call."
                        )

                    yield ToolCallDelta(
                        call_id=call_id,
                        arguments_delta=event.delta.partial_json,
                    )

            final_message = await stream.get_final_message()

        yield ResponseCompleted(
            stop_reason=final_message.stop_reason,
        )

    async def close(self) -> None:
        await self._client.close()
