from collections.abc import Awaitable, Callable
import json
import logging

from pydantic import ValidationError

from app.tools import ToolRegistry, ToolResult, UnknownToolError


logger = logging.getLogger(__name__)


ToolApprovalHandler = Callable[
    [str, dict[str, object]],
    Awaitable[bool],
]


async def execute_tool_call(
    *,
    registry: ToolRegistry,
    name: str,
    arguments_json: str,
    approval_handler: ToolApprovalHandler | None = None,
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
        if tool.requires_approval:
            if approval_handler is None:
                return ToolResult(
                    content=(
                        f'Tool "{name}" requires explicit approval, but '
                        "no approval handler is available."
                    ),
                    is_error=True,
                )

            approved = await approval_handler(
                name,
                validated_arguments.model_dump(mode="json"),
            )

            if not approved:
                return ToolResult(
                    content=f'Tool "{name}" was rejected by the user.',
                    is_error=True,
                )

        return await tool.execute(validated_arguments)
    except Exception:
        logger.exception('Tool execution failed for "%s".', name)
        return ToolResult(
            content="Tool execution failed.",
            is_error=True,
        )
