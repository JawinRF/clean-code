from typing import TYPE_CHECKING
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.tools.base import ToolResult

if TYPE_CHECKING:
    from app.services.orchestration import SubagentOrchestrator


class SubagentTask(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    label: str = Field(min_length=1, max_length=160)
    prompt: str = Field(
        min_length=1, max_length=16000,
        description="Self-contained assignment, necessary context, owned files, and expected result.",
    )
    model_provider: str = Field(min_length=1, max_length=80)
    model_name: str = Field(min_length=1, max_length=160)
    max_steps: int = Field(default=8, ge=1, le=16)
    max_output_tokens: int = Field(default=2048, ge=256, le=4096)


class DelegateTasksInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tasks: list[SubagentTask] = Field(min_length=1, max_length=4)


class DelegateTasksTool:
    name = "delegate_tasks"
    input_model = DelegateTasksInput
    requires_approval = False

    def __init__(self, *, orchestrator: "SubagentOrchestrator", parent_run_id: UUID) -> None:
        self._orchestrator = orchestrator
        self._parent_run_id = parent_run_id
        self.description = (
            "Delegate 1-4 independent tasks concurrently to workers, choosing a model for each. "
            "Use only when delegation helps; handle small tasks directly. Workers get only the "
            "assignment you supply, share the workspace, and retain normal tool approvals. "
            "Assign disjoint files to concurrent writers. Workers cannot delegate. This tool "
            "suspends your turn without model polling and returns once every worker finishes "
            "or fails. Batch independent work into one call. Inspect all results before answering; "
            "do not blindly retry failures or truncated reports. Available provider/model pairs: "
            + ", ".join(f"{provider}/{model}" for provider, model in orchestrator.available_models())
            + f". Maximum {orchestrator.max_per_run} workers across this entire parent run."
        )

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, DelegateTasksInput):
            raise TypeError("DelegateTasksTool requires DelegateTasksInput arguments.")
        return await self._orchestrator.delegate(self._parent_run_id, arguments.tasks)
