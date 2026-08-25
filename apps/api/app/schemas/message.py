from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class TextMessagePart(BaseModel):
    type: Literal["text"] = "text"
    text: str


class MessageContent(BaseModel):
    parts: list[TextMessagePart] = Field(
        min_length=1,
    )


class MessageCreate(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=50_000,
    )


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    role: str
    content: MessageContent
    schema_version: int
    created_at: datetime
