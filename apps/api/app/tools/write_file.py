from pathlib import Path

from pydantic import BaseModel, Field

from app.tools.base import ToolResult
from app.workspace_paths import (
    InvalidWorkspacePathError,
    resolve_workspace_write_path,
)


class WriteFileInput(BaseModel):
    path: str = Field(
        min_length=1,
        max_length=1_000,
        description=(
            "Relative path for the new file inside the workspace."
        ),
    )
    content: str = Field(
        description="Complete UTF-8 text content for the new file.",
    )


class WriteFileTool:
    name = "write_file"
    description = (
        "Create a new UTF-8 text file inside the workspace. "
        "The tool creates missing parent directories and never overwrites "
        "an existing file."
    )
    input_model = WriteFileInput
    requires_approval = True

    def __init__(self, *, workspace_root: str | Path) -> None:
        self._workspace_root = Path(workspace_root).resolve(strict=True)

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, WriteFileInput):
            raise TypeError(
                "WriteFileTool requires WriteFileInput arguments."
            )

        try:
            target = resolve_workspace_write_path(
                self._workspace_root,
                arguments.path,
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            target = resolve_workspace_write_path(
                self._workspace_root,
                arguments.path,
            )

            with target.open(
                "x",
                encoding="utf-8",
                newline="",
            ) as file:
                file.write(arguments.content)
        except InvalidWorkspacePathError as error:
            return ToolResult(
                content=str(error),
                is_error=True,
            )
        except FileExistsError:
            return ToolResult(
                content=(
                    "Workspace file already exists. Use edit_file to "
                    "modify it."
                ),
                is_error=True,
            )
        except OSError:
            return ToolResult(
                content="Workspace file could not be created.",
                is_error=True,
            )

        display_path = target.relative_to(
            self._workspace_root
        ).as_posix()
        return ToolResult(content=f"Created file {display_path}.")
