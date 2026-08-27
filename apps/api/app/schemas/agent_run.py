from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


RunStatus = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
]


class AgentRunCreate(BaseModel):
    trigger_message_id: UUID | None = None
    model_provider: str = Field(
        min_length=1,
        max_length=80,
    )
    model_name: str = Field(
        min_length=1,
        max_length=160,
    )


class AgentRunExecute(BaseModel):
    max_output_tokens: int = Field(
        gt=0,
    )


class AgentRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    trigger_message_id: UUID | None
    status: RunStatus
    model_provider: str
    model_name: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancel_requested_at: datetime | None
    error_code: str | None
    error_message: str | None
