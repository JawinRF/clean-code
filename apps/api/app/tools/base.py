from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel


@dataclass(frozen=True, slots=True)
class ToolResult:
    content: str
    is_error: bool = False


class AgentTool(Protocol):
    name: str
    description: str
    input_model: type[BaseModel]

    async def execute(self, arguments: BaseModel) -> ToolResult:
        ...
