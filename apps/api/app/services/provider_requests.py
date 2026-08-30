from collections.abc import Sequence
from typing import Literal

from app.models import Message
from app.providers import (
    ProviderMessage,
    ProviderRequest,
    ProviderTextBlock,
    ToolDefinition,
)
from app.schemas.message import MessageContent


class UnsupportedMessageRoleError(Exception):
    pass


def build_provider_request(
    *,
    model: str,
    messages: Sequence[Message],
    max_output_tokens: int,
    system: str | None = None,
    tools: tuple[ToolDefinition, ...] = (),
) -> ProviderRequest:
    provider_messages = [
        build_provider_message(message)
        for message in messages
    ]

    return ProviderRequest(
        model=model,
        messages=tuple(provider_messages),
        max_output_tokens=max_output_tokens,
        system=system,
        tools=tools,
    )


def build_provider_message(message: Message) -> ProviderMessage:
    role: Literal["user", "assistant"]

    if message.role == "user":
        role = "user"
    elif message.role == "assistant":
        role = "assistant"
    else:
        raise UnsupportedMessageRoleError(
            f'Cannot send message role "{message.role}" to the model.'
        )

    content = MessageContent.model_validate(message.content)
    text = "".join(part.text for part in content.parts)

    return ProviderMessage(
        role=role,
        content=(ProviderTextBlock(text=text),),
    )
