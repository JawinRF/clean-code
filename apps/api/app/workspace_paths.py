from pathlib import Path


class InvalidWorkspaceRootError(ValueError):
    pass


class InvalidWorkspacePathError(ValueError):
    pass


def resolve_workspace_root(raw_path: str) -> str:
    candidate = raw_path.strip()

    if not candidate:
        raise InvalidWorkspaceRootError(
            "Workspace root must not be empty."
        )

    if candidate.startswith("\\\\") or candidate.startswith("//"):
        raise InvalidWorkspaceRootError(
            "UNC network paths cannot be workspace roots."
        )

    path = Path(candidate).expanduser()

    if not path.is_absolute():
        raise InvalidWorkspaceRootError(
            "Workspace root must be an absolute path."
        )

    try:
        resolved_path = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise InvalidWorkspaceRootError(
            "Workspace root does not exist or cannot be resolved."
        ) from error

    if not resolved_path.is_dir():
        raise InvalidWorkspaceRootError(
            "Workspace root must be a directory."
        )

    if resolved_path == Path(resolved_path.anchor):
        raise InvalidWorkspaceRootError(
            "A filesystem root cannot be a workspace root."
        )

    return str(resolved_path)


def resolve_workspace_path(
    workspace_root: str | Path,
    relative_path: str,
) -> Path:
    candidate = relative_path.strip()

    if not candidate:
        raise InvalidWorkspacePathError(
            "Workspace path must not be empty."
        )

    untrusted_path = Path(candidate)

    if untrusted_path.is_absolute() or untrusted_path.drive:
        raise InvalidWorkspacePathError(
            "Workspace path must be relative."
        )

    try:
        resolved_root = Path(workspace_root).resolve(strict=True)
        resolved_path = (resolved_root / untrusted_path).resolve(
            strict=True
        )
        resolved_path.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError) as error:
        raise InvalidWorkspacePathError(
            "Workspace path does not exist inside the workspace."
        ) from error

    return resolved_path
