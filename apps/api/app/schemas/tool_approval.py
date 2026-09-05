from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


ToolApprovalDecision = Literal["approved", "rejected"]


class ToolApprovalDecisionRequest(BaseModel):
    decision: ToolApprovalDecision


class FileApprovalPreview(BaseModel):
    path: str
    unified_diff: str
    additions: int
    deletions: int
    before_line_endings: str
    after_line_endings: str
    original_sha256: str | None


class ToolApprovalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    run_id: UUID
    call_id: str
    tool_name: str
    reason: str
    arguments: dict[str, object]
    file_preview: FileApprovalPreview | None = None
    requested_at: datetime
    status: Literal["pending", "approved", "rejected", "cancelled", "interrupted"]
    resolved_at: datetime | None
