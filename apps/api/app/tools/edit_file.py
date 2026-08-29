import os
from pathlib import Path
from stat import S_IMODE
from tempfile import NamedTemporaryFile

from pydantic import BaseModel, Field

from app.tools.base import ToolResult
from app.workspace_paths import (
    InvalidWorkspacePathError,
    resolve_workspace_path,
)


class EditFileInput(BaseModel):
    path: str = Field(
        min_length=1,
        max_length=1_000,
        description=(
            "Relative path of an existing UTF-8 file inside the workspace."
        ),
    )
    old_content: str = Field(
        min_length=1,
        description="Exact literal text to replace.",
    )
    new_content: str = Field(
        description=(
            "Exact replacement text. Use an empty string to delete the "
            "matched text."
        ),
    )
    replace_all: bool = Field(
        default=False,
        description=(
            "Replace every match. When false, old_content must match "
            "exactly once."
        ),
    )


class EditFileTool:
    name = "edit_file"
    description = (
        "Modify an existing UTF-8 text file inside the workspace by "
        "replacing exact literal text."
    )
    input_model = EditFileInput

    def __init__(self, *, workspace_root: str | Path) -> None:
        self._workspace_root = Path(workspace_root).resolve(strict=True)

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, EditFileInput):
            raise TypeError(
                "EditFileTool requires EditFileInput arguments."
            )

        if arguments.old_content == arguments.new_content:
            return ToolResult(
                content="old_content and new_content must differ.",
                is_error=True,
            )

        try:
            target = resolve_workspace_path(
                self._workspace_root,
                arguments.path,
            )
        except InvalidWorkspacePathError as error:
            return ToolResult(
                content=str(error),
                is_error=True,
            )

        if not target.is_file():
            return ToolResult(
                content="Workspace path is not a file.",
                is_error=True,
            )

        try:
            original_content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return ToolResult(
                content="Workspace file is not valid UTF-8 text.",
                is_error=True,
            )
        except OSError:
            return ToolResult(
                content="Workspace file could not be read.",
                is_error=True,
            )

        match_count = original_content.count(arguments.old_content)

        if match_count == 0:
            return ToolResult(
                content="old_content was not found in the workspace file.",
                is_error=True,
            )

        if not arguments.replace_all and match_count > 1:
            return ToolResult(
                content=(
                    f"old_content matched {match_count} times. Provide more "
                    "specific text or set replace_all to true."
                ),
                is_error=True,
            )

        replacement_count = match_count if arguments.replace_all else 1
        updated_content = original_content.replace(
            arguments.old_content,
            arguments.new_content,
            replacement_count,
        )
        temporary_path: Path | None = None

        try:
            target = resolve_workspace_path(
                self._workspace_root,
                arguments.path,
            )

            current_content = target.read_text(encoding="utf-8")

            if current_content != original_content:
                return ToolResult(
                    content=(
                        "Workspace file changed during the edit. Read it "
                        "again and retry."
                    ),
                    is_error=True,
                )

            original_mode = S_IMODE(target.stat().st_mode)

            with NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="",
                dir=target.parent,
                prefix=f".{target.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_file.write(updated_content)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
                temporary_path = Path(temporary_file.name)

            temporary_path.chmod(original_mode)
            os.replace(temporary_path, target)
            temporary_path = None
        except (InvalidWorkspacePathError, OSError):
            return ToolResult(
                content="Workspace file could not be updated.",
                is_error=True,
            )
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

        display_path = target.relative_to(
            self._workspace_root
        ).as_posix()
        return ToolResult(
            content=(
                f"Updated file {display_path}. Replaced "
                f"{replacement_count} occurrence(s)."
            )
        )
