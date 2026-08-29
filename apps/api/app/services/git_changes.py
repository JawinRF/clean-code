from __future__ import annotations

import difflib
import os
import subprocess
from pathlib import Path, PurePosixPath

from app.schemas.git_changes import (
    GitChangedFile,
    GitChangesResponse,
    GitDiffLine,
)


MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
MAX_CHANGED_FILES = 200


class GitRepositoryError(RuntimeError):
    pass


class GitOperationError(RuntimeError):
    pass


class GitPathError(ValueError):
    pass


def _git(
    repository_root: Path,
    *arguments: str,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    environment = os.environ.copy()
    environment["GIT_TERMINAL_PROMPT"] = "0"

    try:
        result = subprocess.run(
            ["git", "-c", "core.quotepath=false", *arguments],
            cwd=repository_root,
            env=environment,
            capture_output=True,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GitOperationError("Git could not complete the operation.") from error

    if check and result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise GitOperationError(detail or "Git could not complete the operation.")

    return result


def _repository_root(workspace_root: str) -> Path:
    workspace_path = Path(workspace_root).resolve(strict=True)
    result = _git(workspace_path, "rev-parse", "--show-toplevel", check=False)

    if result.returncode != 0:
        raise GitRepositoryError("The selected workspace is not a Git repository.")

    reported_root = Path(
        result.stdout.decode("utf-8", errors="replace").strip()
    ).resolve(strict=True)

    if reported_root != workspace_path:
        raise GitRepositoryError(
            "The workspace root must be the Git repository root."
        )

    return reported_root


def _decode_path(value: bytes) -> str:
    return value.decode("utf-8", errors="replace").replace("\\", "/")


def _safe_path(repository_root: Path, relative_path: str) -> Path:
    pure_path = PurePosixPath(relative_path)

    if pure_path.is_absolute() or ".." in pure_path.parts:
        raise GitPathError("Git path must stay inside the workspace.")

    try:
        resolved_path = (repository_root / Path(*pure_path.parts)).resolve(
            strict=False
        )
        resolved_path.relative_to(repository_root)
    except (OSError, RuntimeError, ValueError) as error:
        raise GitPathError("Git path must stay inside the workspace.") from error

    return resolved_path


def _tracked_changes(repository_root: Path) -> list[tuple[str, str, str | None]]:
    result = _git(
        repository_root,
        "diff",
        "--name-status",
        "--find-renames",
        "-z",
        "HEAD",
        "--",
    )
    tokens = [token for token in result.stdout.split(b"\0") if token]
    changes: list[tuple[str, str, str | None]] = []
    index = 0

    while index < len(tokens):
        status_token = _decode_path(tokens[index])
        index += 1
        status_code = status_token[0]

        if status_code in {"R", "C"}:
            previous_path = _decode_path(tokens[index])
            path = _decode_path(tokens[index + 1])
            index += 2
            changes.append(("renamed", path, previous_path))
            continue

        path = _decode_path(tokens[index])
        index += 1
        status = {
            "A": "added",
            "D": "deleted",
            "M": "modified",
            "T": "modified",
        }.get(status_code, "modified")
        changes.append((status, path, None))

    return changes


def _untracked_changes(repository_root: Path) -> list[tuple[str, str, None]]:
    result = _git(
        repository_root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    )
    return [
        ("untracked", _decode_path(token), None)
        for token in result.stdout.split(b"\0")
        if token
    ]


def _head_bytes(repository_root: Path, path: str) -> bytes:
    result = _git(repository_root, "show", f"HEAD:{path}", check=False)
    return result.stdout if result.returncode == 0 else b""


def _working_bytes(repository_root: Path, path: str) -> bytes:
    file_path = _safe_path(repository_root, path)

    if not file_path.exists():
        return b""

    if not file_path.is_file():
        raise GitPathError("Git changes can only display files.")

    try:
        return file_path.read_bytes()
    except OSError as error:
        raise GitOperationError(f"Could not read changed file: {path}") from error


def _language(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    return {
        ".css": "css",
        ".html": "html",
        ".js": "javascript",
        ".json": "json",
        ".jsx": "javascript",
        ".md": "markdown",
        ".py": "python",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".yaml": "yaml",
        ".yml": "yaml",
    }.get(suffix, "text")


def _diff_lines(old_bytes: bytes, new_bytes: bytes) -> tuple[list[GitDiffLine], bool]:
    is_binary = b"\0" in old_bytes or b"\0" in new_bytes
    is_too_large = max(len(old_bytes), len(new_bytes)) > MAX_DIFF_FILE_BYTES

    if is_binary or is_too_large:
        return [], is_binary

    old_lines = old_bytes.decode("utf-8", errors="replace").splitlines()
    new_lines = new_bytes.decode("utf-8", errors="replace").splitlines()
    matcher = difflib.SequenceMatcher(
        None,
        old_lines,
        new_lines,
        autojunk=False,
    )
    lines: list[GitDiffLine] = []

    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag == "equal":
            for offset, content in enumerate(old_lines[old_start:old_end]):
                lines.append(
                    GitDiffLine(
                        old_line_number=old_start + offset + 1,
                        new_line_number=new_start + offset + 1,
                        type="context",
                        content=content,
                    )
                )
            continue

        if tag in {"delete", "replace"}:
            for offset, content in enumerate(old_lines[old_start:old_end]):
                lines.append(
                    GitDiffLine(
                        old_line_number=old_start + offset + 1,
                        type="deletion",
                        content=content,
                    )
                )

        if tag in {"insert", "replace"}:
            for offset, content in enumerate(new_lines[new_start:new_end]):
                lines.append(
                    GitDiffLine(
                        new_line_number=new_start + offset + 1,
                        type="addition",
                        content=content,
                    )
                )

    return lines, False


def collect_git_changes(workspace_root: str) -> GitChangesResponse:
    repository_root = _repository_root(workspace_root)
    changes = _tracked_changes(repository_root) + _untracked_changes(
        repository_root
    )

    if len(changes) > MAX_CHANGED_FILES:
        raise GitOperationError(
            f"The repository has more than {MAX_CHANGED_FILES} changed files."
        )

    files: list[GitChangedFile] = []

    for status, path, previous_path in changes:
        _safe_path(repository_root, path)
        base_path = previous_path or path
        old_bytes = b"" if status in {"added", "untracked"} else _head_bytes(
            repository_root,
            base_path,
        )
        new_bytes = b"" if status == "deleted" else _working_bytes(
            repository_root,
            path,
        )
        lines, is_binary = _diff_lines(old_bytes, new_bytes)
        additions = sum(line.type == "addition" for line in lines)
        deletions = sum(line.type == "deletion" for line in lines)
        files.append(
            GitChangedFile(
                path=path,
                previous_path=previous_path,
                status=status,
                language=_language(path),
                additions=additions,
                deletions=deletions,
                is_binary=is_binary,
                lines=lines,
            )
        )

    files.sort(key=lambda changed_file: changed_file.path.lower())
    branch_result = _git(repository_root, "branch", "--show-current")
    branch = branch_result.stdout.decode("utf-8", errors="replace").strip()

    if not branch:
        branch = _git(repository_root, "rev-parse", "--short", "HEAD").stdout.decode(
            "utf-8",
            errors="replace",
        ).strip()

    return GitChangesResponse(
        branch=branch,
        additions=sum(changed_file.additions for changed_file in files),
        deletions=sum(changed_file.deletions for changed_file in files),
        files=files,
    )


def revert_git_file(workspace_root: str, path: str) -> GitChangesResponse:
    repository_root = _repository_root(workspace_root)
    snapshot = collect_git_changes(workspace_root)
    changed_file = next(
        (candidate for candidate in snapshot.files if candidate.path == path),
        None,
    )

    if changed_file is None:
        raise GitPathError("The file is not in the current Git change set.")

    file_path = _safe_path(repository_root, changed_file.path)

    if changed_file.status == "untracked":
        try:
            file_path.unlink()
        except OSError as error:
            raise GitOperationError("Could not remove the untracked file.") from error
    elif changed_file.previous_path is not None:
        _git(
            repository_root,
            "restore",
            "--staged",
            "--",
            changed_file.previous_path,
            changed_file.path,
        )
        _git(
            repository_root,
            "restore",
            "--source=HEAD",
            "--worktree",
            "--",
            changed_file.previous_path,
        )
        if file_path.exists():
            file_path.unlink()
    else:
        _git(
            repository_root,
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            changed_file.path,
        )

    return collect_git_changes(workspace_root)


def commit_git_files(
    workspace_root: str,
    *,
    paths: list[str],
    message: str,
    branch_name: str | None,
) -> GitChangesResponse:
    repository_root = _repository_root(workspace_root)
    snapshot = collect_git_changes(workspace_root)
    changed_files = {
        changed_file.path: changed_file for changed_file in snapshot.files
    }
    selected_paths = list(dict.fromkeys(paths))

    if any(path not in changed_files for path in selected_paths):
        raise GitPathError("A selected file is not in the current Git change set.")

    command_paths = list(
        dict.fromkeys(
            path
            for selected_path in selected_paths
            for path in (
                changed_files[selected_path].previous_path,
                selected_path,
            )
            if path is not None
        )
    )

    for path in command_paths:
        _safe_path(repository_root, path)

    clean_message = message.strip()
    if not clean_message:
        raise GitOperationError("Commit message must not be empty.")

    clean_branch_name = branch_name.strip() if branch_name is not None else None
    original_branch = _git(
        repository_root,
        "branch",
        "--show-current",
    ).stdout.decode("utf-8", errors="replace").strip()
    original_head = _git(repository_root, "rev-parse", "HEAD").stdout.decode(
        "utf-8",
        errors="replace",
    ).strip()
    created_branch = False

    if clean_branch_name:
        _git(repository_root, "check-ref-format", "--branch", clean_branch_name)
        _git(repository_root, "switch", "-c", clean_branch_name)
        created_branch = True

    try:
        _git(repository_root, "add", "-A", "--", *command_paths)
        _git(
            repository_root,
            "commit",
            "--only",
            "-m",
            clean_message,
            "--",
            *command_paths,
        )
    except GitOperationError:
        if created_branch and clean_branch_name is not None:
            if original_branch:
                _git(repository_root, "switch", original_branch, check=False)
            else:
                _git(repository_root, "switch", "--detach", original_head, check=False)
            _git(repository_root, "branch", "-D", clean_branch_name, check=False)
        raise

    return collect_git_changes(workspace_root)
