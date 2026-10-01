from collections.abc import Awaitable, Callable
import json
import logging

from pydantic import ValidationError

from app.tools import ToolRegistry, ToolResult, UnknownToolError
from app.tools.edit_file import EditFileTool
from app.tools.write_file import WriteFileTool
from app.tools.file_preview import prepare_file_preview


logger = logging.getLogger(__name__)


ToolApprovalHandler = Callable[
    [str, dict[str, object], dict[str, object] | None],
    Awaitable[bool],
]


async def execute_tool_call(
    *,
    registry: ToolRegistry,
    name: str,
    arguments_json: str,
    approval_handler: ToolApprovalHandler | None = None,
    on_execution_start: Callable[[], None] | None = None,
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
        file_preview = None
        if isinstance(tool, (EditFileTool, WriteFileTool)):
            file_preview = prepare_file_preview(tool.workspace_root, validated_arguments)
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
                file_preview.as_dict() if file_preview is not None else None,
            )

            if not approved:
                return ToolResult(
                    content=f'Tool "{name}" was rejected by the user.',
                    is_error=True,
                )

        if on_execution_start is not None:
            on_execution_start()
        if isinstance(tool, EditFileTool) and file_preview is not None:
            return await tool.execute(
                validated_arguments, expected_sha256=file_preview.original_sha256,
                expected_path=file_preview.path,
            )
        if isinstance(tool, WriteFileTool) and file_preview is not None:
            return await tool.execute(validated_arguments, expected_path=file_preview.path)
        return await tool.execute(validated_arguments)
    except (ValueError, OSError, UnicodeDecodeError) as error:
        return ToolResult(content=str(error), is_error=True)
    except Exception:
        logger.exception('Tool execution failed for "%s".', name)
        return ToolResult(
            content="Tool execution failed.",
            is_error=True,
        )
