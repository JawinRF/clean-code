from collections.abc import AsyncIterator

from anthropic import AsyncAnthropic, omit
from anthropic.types import MessageParam

from app.providers.base import (
    ProviderEvent,
    ProviderRequest,
    ResponseCompleted,
    TextDelta,
)


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
        messages: list[MessageParam] = [
            {
                "role": message.role,
                "content": message.content,
            }
            for message in request.messages
        ]

        async with self._client.messages.stream(
            model=request.model,
            messages=messages,
            max_tokens=request.max_output_tokens,
            system=request.system if request.system is not None else omit,
        ) as stream:
            async for event in stream:
                if (
                    event.type == "content_block_delta"
                    and event.delta.type == "text_delta"
                ):
                    yield TextDelta(text=event.delta.text)

            final_message = await stream.get_final_message()

        yield ResponseCompleted(
            stop_reason=final_message.stop_reason,
        )
