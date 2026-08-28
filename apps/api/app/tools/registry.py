from collections.abc import Iterable

from app.providers import ToolDefinition
from app.tools.base import AgentTool
from app.tools.echo import EchoTool


class DuplicateToolError(Exception):
    pass


class UnknownToolError(Exception):
    pass


class ToolRegistry:
    def __init__(self, tools: Iterable[AgentTool] = ()) -> None:
        self._tools: dict[str, AgentTool] = {}

        for tool in tools:
            self.register(tool)

    def register(self, tool: AgentTool) -> None:
        if tool.name in self._tools:
            raise DuplicateToolError(
                f'Tool "{tool.name}" is already registered.'
            )

        self._tools[tool.name] = tool

    def get(self, name: str) -> AgentTool:
        tool = self._tools.get(name)

        if tool is None:
            raise UnknownToolError(f'Unknown tool "{name}".')

        return tool

    def definitions(self) -> tuple[ToolDefinition, ...]:
        return tuple(
            ToolDefinition(
                name=tool.name,
                description=tool.description,
                input_schema=tool.input_model.model_json_schema(),
            )
            for tool in self._tools.values()
        )


def create_default_tool_registry() -> ToolRegistry:
    return ToolRegistry([EchoTool()])
