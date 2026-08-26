from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class RunEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    run_id: UUID
    sequence: int
    event_type: str
    payload: dict[str, object]
    schema_version: int
    created_at: datetime
