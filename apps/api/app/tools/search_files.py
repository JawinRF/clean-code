from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from app.tools.base import ToolResult

# Lazily imported to avoid circular import with app.services
# (app.services imports app.tools during its __init__). Import inside execute.
# Constants duplicated here for module-level use; search_workspace provides defaults at call time.


class SearchFilesInput(BaseModel):
    pattern: str = Field(
        min_length=1,
        max_length=2_000,
        description="Regular expression pattern to search for in file contents.",
    )
    path: str | None = Field(
        default=None,
        max_length=1_000,
        description=(
            "Relative file or directory to search in. Defaults to workspace root. "
            "Must stay inside the workspace."
        ),
    )
    glob: str | None = Field(
        default=None,
        max_length=1_000,
        description='Glob pattern to filter files, e.g. "*.js" or "*.{ts,tsx}" – maps to ripgrep --glob.',
    )
    output_mode: str = Field(
        default="content",
        description='Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "content".',
    )
    case_insensitive: bool = Field(
        default=False,
        description="Case-insensitive search (ripgrep -i).",
    )
    head_limit: int | None = Field(
        default=None,
        description=(
            "Limit output to first N lines/entries. Defaults to 250 when unspecified. Pass 0 for unlimited."
        ),
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Skip first N entries before applying head_limit.",
    )
    regex: bool = Field(
        default=True,
        description=(
            "When false, pattern is treated as fixed string (ripgrep -F). Default true for tool use; UI uses false."
        ),
    )


class SearchFilesTool:
    name = "search_files"
    description = (
        "Search file contents inside the workspace with regex (ripgrep-inspired). "
        "Supports content, files_with_matches, and count modes, glob filtering, "
        "case-insensitive search, and pagination via head_limit/offset. "
        "Skips .git and binary files, truncates long lines to 500 columns."
    )
    input_model = SearchFilesInput
    requires_approval = False

    def __init__(self, *, workspace_root: str | Path) -> None:
        self._workspace_root = Path(workspace_root).resolve(strict=True)

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, SearchFilesInput):
            raise TypeError("SearchFilesTool requires SearchFilesInput arguments.")

        pattern = arguments.pattern
        if not pattern.strip():
            return ToolResult(content="Search pattern must not be empty.", is_error=True)

        if arguments.output_mode not in {"content", "files_with_matches", "count"}:
            return ToolResult(
                content='output_mode must be one of "content", "files_with_matches", "count".',
                is_error=True,
            )

        # Resolve optional sub-path inside workspace
        search_root = self._workspace_root
        if arguments.path:
            from app.workspace_paths import InvalidWorkspacePathError, resolve_workspace_path

            try:
                candidate = resolve_workspace_path(
                    self._workspace_root, arguments.path
                )
                # If it's a file, search only that file's parent directory with filename filter
                # For simplicity, if path points to a file, set glob to filename and root to parent
                if candidate.is_file():
                    search_root = candidate.parent
                    # Override glob to match single file if no glob already
                    file_name = candidate.name
                    if arguments.glob:
                        # Combine: keep provided glob and also restrict by filename? Use exact filename glob
                        # We'll search with provided glob inside parent; safest is to just search file directly
                        pass
                    # Direct file search: read file and match
                    return await self._search_single_file(
                        candidate, pattern, arguments
                    )
                elif candidate.is_dir():
                    search_root = candidate
                else:
                    return ToolResult(
                        content="Workspace path is not a file or directory.",
                        is_error=True,
                    )
            except InvalidWorkspacePathError as error:
                return ToolResult(content=str(error), is_error=True)

        # Validate head_limit
        head_limit = arguments.head_limit
        if head_limit is not None and head_limit < 0:
            return ToolResult(content="head_limit must be >= 0.", is_error=True)

        try:
            # Lazy import to avoid circular import at module load time
            from app.services.workspace_search import (
                DEFAULT_HEAD_LIMIT as _DEFAULT_HEAD_LIMIT,
                MAX_MATCHES_PER_FILE as _MAX_PER_FILE,
                MAX_TOTAL_MATCHES as _MAX_TOTAL,
                search_workspace as _search_workspace,
            )

            # For files_with_matches we don't need per-line content, but we reuse same search
            # and then transform output.
            matches, truncated = _search_workspace(
                search_root,
                pattern,
                regex=arguments.regex,
                case_insensitive=arguments.case_insensitive,
                glob=arguments.glob,
                max_matches_per_file=_MAX_PER_FILE,
                max_total_matches=_MAX_TOTAL,
                offset=arguments.offset,
                limit=head_limit,
            )
        except ValueError as exc:
            return ToolResult(content=str(exc), is_error=True)
        except OSError as exc:
            return ToolResult(content=f"Search failed: {exc}", is_error=True)

        output_mode = arguments.output_mode
        if output_mode == "content":
            if not matches:
                return ToolResult(content="No matches found.")
            lines = [f"{m.file}:{m.line}:{m.text}" for m in matches]
            content = "\n".join(lines)
            if truncated:
                # Mirror GrepTool's pagination hint
                applied = head_limit if head_limit not in (None, 0) else _DEFAULT_HEAD_LIMIT
                content += f"\n\n[Showing results with pagination = limit: {applied}" + (
                    f", offset: {arguments.offset}" if arguments.offset else ""
                ) + "]"
            return ToolResult(content=content)

        if output_mode == "files_with_matches":
            # Deduplicate files, sorted by most recent? For simplicity sorted alphabetically
            files = sorted({m.file for m in matches})
            if not files:
                return ToolResult(content="No files found.")
            # Apply pagination already done on matches, but files list is derived;
            # reapply head_limit semantics on files count.
            # matches already limited, so files count reflects limited set.
            content = f"Found {len(files)} file{'s' if len(files)!=1 else ''}\n" + "\n".join(files)
            if truncated:
                applied = head_limit if head_limit not in (None, 0) else _DEFAULT_HEAD_LIMIT
                content += f" limit: {applied}"
                if arguments.offset:
                    content += f", offset: {arguments.offset}"
            return ToolResult(content=content)

        # count mode
        if not matches:
            return ToolResult(content="No matches found\n\nFound 0 total occurrences across 0 files.")
        # Count per file
        from collections import Counter

        counts = Counter(m.file for m in matches)
        lines = [f"{fname}:{count}" for fname, count in sorted(counts.items())]
        total = len(matches)
        file_count = len(counts)
        content = "\n".join(lines)
        content += f"\n\nFound {total} total occurrence{'s' if total!=1 else ''} across {file_count} file{'s' if file_count!=1 else ''}."
        if truncated:
            applied = head_limit if head_limit not in (None, 0) else _DEFAULT_HEAD_LIMIT
            content += f" with pagination = limit: {applied}"
            if arguments.offset:
                content += f", offset: {arguments.offset}"
        return ToolResult(content=content)

    async def _search_single_file(
        self, file_path: Path, pattern: str, arguments: SearchFilesInput
    ) -> ToolResult:
        import re

        try:
            text = file_path.read_text(encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return ToolResult(content="Workspace file is not valid UTF-8 text.", is_error=True)
        except OSError as exc:
            return ToolResult(content=f"File could not be read: {exc}", is_error=True)

        flags = re.IGNORECASE if arguments.case_insensitive else 0
        pat = re.escape(pattern) if not arguments.regex else pattern
        try:
            compiled = re.compile(pat, flags)
        except re.error as exc:
            return ToolResult(content=f"Invalid search pattern: {exc}", is_error=True)

        lines = text.splitlines()
        matches: list[tuple[int, str]] = []
        # Import constants lazily as well
        from app.services.workspace_search import (
            DEFAULT_HEAD_LIMIT as _DL_DEF,
            MAX_MATCHES_PER_FILE as _MAX_PF,
        )

        for idx, line in enumerate(lines, start=1):
            if compiled.search(line):
                display = line[:500] if len(line) > 500 else line
                matches.append((idx, display))
                if len(matches) >= _MAX_PF and arguments.output_mode == "content":
                    break

        # Apply offset/limit
        offset = arguments.offset or 0
        limit = arguments.head_limit
        effective = None if limit == 0 else (limit if limit is not None else _DL_DEF)
        sliced = matches[offset:]
        truncated = False
        if effective is not None and len(sliced) > effective:
            truncated = True
            sliced = sliced[:effective]
        elif effective is not None and len(matches) - offset > effective:
            truncated = True

        relative = file_path.relative_to(self._workspace_root).as_posix()
        if arguments.output_mode == "content":
            if not sliced:
                return ToolResult(content="No matches found.")
            content = "\n".join(f"{relative}:{ln}:{txt}" for ln, txt in sliced)
            if truncated:
                applied = effective if effective is not None else _DL_DEF
                content += f"\n\n[Showing results with pagination = limit: {applied}" + (
                    f", offset: {offset}" if offset else ""
                ) + "]"
            return ToolResult(content=content)
        if arguments.output_mode == "files_with_matches":
            if not sliced:
                return ToolResult(content="No files found.")
            return ToolResult(content=f"Found 1 file\n{relative}")
        # count
        total = len(sliced)
        if total == 0:
            return ToolResult(content="No matches found\n\nFound 0 total occurrences across 0 files.")
        return ToolResult(
            content=f"{relative}:{total}\n\nFound {total} total occurrence{'s' if total!=1 else ''} across 1 file."
        )
