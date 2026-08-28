import json

from pydantic import ValidationError

from app.tools import ToolRegistry, ToolResult, UnknownToolError


async def execute_tool_call(
    *,
    registry: ToolRegistry,
    name: str,
    arguments_json: str,
) -> ToolResult:
    try:
        arguments_data = json.loads(arguments_json)
    except json.JSONDecodeError:
        return ToolResult(
            content="Tool arguments are not valid JSON.",
            is_error=True,
        )

    try:
        tool = registry.get(name)
    except UnknownToolError:
        return ToolResult(
            content=f'Tool "{name}" is not available.',
            is_error=True,
        )

    try:
        validated_arguments = tool.input_model.model_validate(
            arguments_data
        )
    except ValidationError:
        return ToolResult(
            content="Tool arguments do not match the required schema.",
            is_error=True,
        )

    try:
        return await tool.execute(validated_arguments)
    except Exception:
        return ToolResult(
            content="Tool execution failed.",
            is_error=True,
        )
