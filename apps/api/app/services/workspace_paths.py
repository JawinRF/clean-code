from pathlib import Path


class InvalidWorkspaceRootError(ValueError):
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
