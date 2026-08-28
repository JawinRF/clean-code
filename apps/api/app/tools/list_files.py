from pathlib import Path

from pydantic import BaseModel, Field

from app.workspace_paths import (
    InvalidWorkspacePathError,
    resolve_workspace_path,
)
from app.tools.base import ToolResult


DEFAULT_LIST_FILES_LIMIT = 100
MAX_LIST_FILES_LIMIT = 500


class ListFilesInput(BaseModel):
    path: str = Field(
        default=".",
        min_length=1,
        max_length=1_000,
        description=(
            "Relative directory to list. Use a path inside the workspace."
        ),
    )
    limit: int = Field(
        default=DEFAULT_LIST_FILES_LIMIT,
        gt=0,
        le=MAX_LIST_FILES_LIMIT,
        description="Maximum number of entries to return.",
    )


class ListFilesTool:
    name = "list_files"
    description = (
        "List files and directories in one workspace directory. "
        "Paths are relative to the workspace root."
    )
    input_model = ListFilesInput

    def __init__(self, *, workspace_root: str | Path) -> None:
        self._workspace_root = Path(workspace_root).resolve(strict=True)

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, ListFilesInput):
            raise TypeError(
                "ListFilesTool requires ListFilesInput arguments."
            )

        try:
            directory = resolve_workspace_path(
                self._workspace_root,
                arguments.path,
            )
        except InvalidWorkspacePathError as error:
            return ToolResult(
                content=str(error),
                is_error=True,
            )

        if not directory.is_dir():
            return ToolResult(
                content="Workspace path is not a directory.",
                is_error=True,
            )

        entries: list[tuple[bool, str]] = []

        try:
            children = directory.iterdir()

            for child in children:
                try:
                    resolved_child = child.resolve(strict=True)
                    resolved_child.relative_to(self._workspace_root)
                except (OSError, RuntimeError, ValueError):
                    continue

                if resolved_child.is_dir():
                    is_directory = True
                elif resolved_child.is_file():
                    is_directory = False
                else:
                    continue

                display_path = child.relative_to(
                    self._workspace_root
                ).as_posix()

                if is_directory:
                    display_path += "/"

                entries.append((is_directory, display_path))
        except OSError:
            return ToolResult(
                content="Workspace directory could not be listed.",
                is_error=True,
            )

        entries.sort(
            key=lambda entry: (
                not entry[0],
                entry[1].casefold(),
                entry[1],
            )
        )
        selected_entries = entries[: arguments.limit]

        if not selected_entries:
            return ToolResult(content="No files found.")

        output_lines = [entry[1] for entry in selected_entries]

        if len(entries) > arguments.limit:
            output_lines.append(
                "(Results are truncated. Use a narrower path or higher limit.)"
            )

        return ToolResult(content="\n".join(output_lines))
