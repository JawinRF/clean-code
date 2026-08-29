from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


ToolApprovalDecision = Literal["approved", "rejected"]


class ToolApprovalDecisionRequest(BaseModel):
    decision: ToolApprovalDecision


class ToolApprovalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    run_id: UUID
    call_id: str
    tool_name: str
    reason: str
    arguments: dict[str, object]
    requested_at: datetime
