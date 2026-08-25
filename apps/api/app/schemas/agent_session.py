from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AgentSessionCreate(BaseModel):
    title: str = Field(
        min_length=1,
        max_length=160,
    )


class AgentSessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    workspace_id: UUID
    title: str
    created_at: datetime
