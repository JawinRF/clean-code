from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol


@dataclass(frozen=True, slots=True)
class ProviderTextBlock:
    text: str
    type: Literal["text"] = field(default="text", init=False)


@dataclass(frozen=True, slots=True)
class ProviderToolCallBlock:
    call_id: str
    name: str
    arguments: dict[str, object]
    type: Literal["tool_call"] = field(default="tool_call", init=False)


@dataclass(frozen=True, slots=True)
class ProviderToolResultBlock:
    call_id: str
    content: str
    is_error: bool = False
    type: Literal["tool_result"] = field(default="tool_result", init=False)


ProviderContentBlock = (
    ProviderTextBlock
    | ProviderToolCallBlock
    | ProviderToolResultBlock
)


@dataclass(frozen=True, slots=True)
class ProviderMessage:
    role: Literal["user", "assistant"]
    content: tuple[ProviderContentBlock, ...]


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, object]


@dataclass(frozen=True, slots=True)
class ProviderRequest:
    model: str
    messages: tuple[ProviderMessage, ...]
    max_output_tokens: int
    system: str | None = None
    tools: tuple[ToolDefinition, ...] = ()


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str
    type: Literal["text.delta"] = field(default="text.delta", init=False)


@dataclass(frozen=True, slots=True)
class ToolCallDelta:
    call_id: str
    arguments_delta: str
    name: str | None = None
    type: Literal["tool_call.delta"] = field(
        default="tool_call.delta",
        init=False,
    )


@dataclass(frozen=True, slots=True)
class ResponseCompleted:
    stop_reason: str | None
    type: Literal["response.completed"] = field(
        default="response.completed",
        init=False,
    )


ProviderEvent = TextDelta | ToolCallDelta | ResponseCompleted


class LlmAdapter(Protocol):
    @property
    def provider_id(self) -> str:
        ...

    def stream(
        self,
        request: ProviderRequest,
    ) -> AsyncIterator[ProviderEvent]:
        ...

    async def close(self) -> None:
        ...
