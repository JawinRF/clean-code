"""Build a complete file-change preview without writing to the workspace."""
from dataclasses import asdict, dataclass
from difflib import unified_diff
from hashlib import sha256
from pathlib import Path

from app.tools.edit_file import EditFileInput
from app.tools.write_file import WriteFileInput
from app.workspace_paths import resolve_workspace_path, resolve_workspace_write_path


class FilePreviewError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class FileApprovalPreview:
    path: str
    unified_diff: str
    additions: int
    deletions: int
    before_line_endings: str
    after_line_endings: str
    original_sha256: str | None

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _line_endings(content: str) -> str:
    crlf = content.count("\r\n")
    lf = content.count("\n") - crlf
    cr = content.count("\r") - crlf
    kinds = [name for name, count in [("CRLF", crlf), ("LF", lf), ("CR", cr)] if count]
    return "/".join(kinds) or "none"


def prepare_file_preview(
    workspace_root: Path, arguments: EditFileInput | WriteFileInput,
) -> FileApprovalPreview:
    before = ""
    original_sha256 = None
    if isinstance(arguments, WriteFileInput):
        target = resolve_workspace_write_path(workspace_root, arguments.path)
        if target.exists():
            raise FilePreviewError("Workspace file already exists. Use edit_file to modify it.")
        after = arguments.content
        from_file = "/dev/null"
    else:
        if arguments.old_content == arguments.new_content:
            raise FilePreviewError("old_content and new_content must differ.")
        target = resolve_workspace_path(workspace_root, arguments.path)
        if not target.is_file():
            raise FilePreviewError("Workspace path is not a file.")
        if target.stat().st_size > 1_000_000:
            raise FilePreviewError("File is too large for a complete approval preview (1 MB limit).")
        raw = target.read_bytes()
        before = raw.decode("utf-8")
        original_sha256 = sha256(raw).hexdigest()
        # Match EditFileTool's universal-newline read semantics exactly.
        normalized = before.replace("\r\n", "\n").replace("\r", "\n")
        matches = normalized.count(arguments.old_content)
        if not matches:
            raise FilePreviewError("old_content was not found in the workspace file.")
        if matches > 1 and not arguments.replace_all:
            raise FilePreviewError(
                f"old_content matched {matches} times. Provide more specific text or set replace_all to true."
            )
        after = normalized.replace(arguments.old_content, arguments.new_content,
                                   matches if arguments.replace_all else 1)
        from_file = f"a/{arguments.path}"
    if len(before.encode("utf-8")) > 1_000_000 or len(after.encode("utf-8")) > 1_000_000:
        raise FilePreviewError("Change is too large for a complete approval preview (1 MB limit).")

    lines = list(unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=from_file, tofile=f"b/{arguments.path}", n=3,
    ))
    additions = sum(line.startswith("+") for line in lines[2:])
    deletions = sum(line.startswith("-") for line in lines[2:])
    rendered: list[str] = []
    for line in lines:
        rendered.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    # An empty new file still needs a visible creation preview.
    diff = "".join(rendered) or f"--- {from_file}\n+++ b/{arguments.path}\n(empty file)\n"
    return FileApprovalPreview(
        path=target.relative_to(workspace_root).as_posix(), unified_diff=diff,
        additions=additions, deletions=deletions,
        before_line_endings=_line_endings(before), after_line_endings=_line_endings(after),
        original_sha256=original_sha256,
    )
