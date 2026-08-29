from __future__ import annotations

import fnmatch
import os
import re
from dataclasses import dataclass
from pathlib import Path


VCS_DIRECTORIES_TO_EXCLUDE = frozenset(
    {".git", ".svn", ".hg", ".bzr", ".jj", ".sl"}
)

# Ripgrep-inspired defaults from References/claude-code/src/tools/GrepTool/GrepTool.ts
DEFAULT_HEAD_LIMIT = 250
MAX_MATCHES_PER_FILE = 10
MAX_TOTAL_MATCHES = 500
MAX_COLUMNS = 500

# Binary detection: NUL byte in first 8KB
_BINARY_CHECK_BYTES = 8000


@dataclass(frozen=True, slots=True)
class SearchMatch:
    file: str  # relative POSIX path
    line: int  # 1-indexed
    text: str  # line content truncated to MAX_COLUMNS


def _is_binary(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            chunk = f.read(_BINARY_CHECK_BYTES)
            return b"\x00" in chunk
    except OSError:
        return True


def _parse_glob_patterns(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return []
    patterns: list[str] = []
    # Split on whitespace first, preserve brace groups
    for token in raw.split():
        if "{" in token and "}" in token:
            patterns.append(token)
        else:
            for part in token.split(","):
                p = part.strip()
                if p:
                    patterns.append(p)
    return patterns


def _expand_brace_pattern(pattern: str) -> list[str]:
    # Expand single brace like "*.{ts,tsx}" -> ["*.ts", "*.tsx"]
    # Only expand one level; recursive not needed for common cases
    start = pattern.find("{")
    end = pattern.find("}", start + 1) if start != -1 else -1
    if start == -1 or end == -1:
        return [pattern]
    prefix = pattern[:start]
    suffix = pattern[end + 1 :]
    inner = pattern[start + 1 : end]
    parts = [p.strip() for p in inner.split(",") if p.strip()]
    if not parts:
        return [pattern]
    return [f"{prefix}{part}{suffix}" for part in parts]


def _glob_match(relative_posix: str, patterns: list[str]) -> bool:
    if not patterns:
        return True
    # ripgrep --glob is positive filter (only files matching glob are searched)
    # Expand brace patterns then test with fnmatch against full relative path and basename
    expanded: list[str] = []
    for pat in patterns:
        expanded.extend(_expand_brace_pattern(pat))
    basename = relative_posix.rsplit("/", 1)[-1]
    for pat in expanded:
        # Normalize: ripgrep glob without slash matches anywhere
        if "/" not in pat:
            if fnmatch.fnmatch(basename, pat) or fnmatch.fnmatch(
                basename.lower(), pat.lower()
            ):
                return True
        # With slash, match against relative path
        if fnmatch.fnmatch(relative_posix, pat) or fnmatch.fnmatch(
            relative_posix, f"**/{pat}"
        ):
            return True
        # Also try fnmatch on basename for convenience
        if fnmatch.fnmatch(basename, pat):
            return True
    return False


def _compile_pattern(
    pattern: str, *, regex: bool, case_insensitive: bool
) -> re.Pattern[str]:
    flags = 0
    if case_insensitive:
        flags |= re.IGNORECASE
    if not regex:
        pattern = re.escape(pattern)
    try:
        return re.compile(pattern, flags)
    except re.error as exc:
        raise ValueError(f"Invalid search pattern: {exc}") from exc


def search_workspace(
    workspace_root: Path,
    pattern: str,
    *,
    regex: bool = False,
    case_insensitive: bool = True,
    glob: str | None = None,
    max_matches_per_file: int = MAX_MATCHES_PER_FILE,
    max_total_matches: int = MAX_TOTAL_MATCHES,
    max_columns: int = MAX_COLUMNS,
    offset: int = 0,
    limit: int | None = None,
) -> tuple[list[SearchMatch], bool]:
    """
    Ripgrep-inspired workspace file search.

    Mirrors claude-code GrepTool/GrepTool.ts and GlobalSearchDialog.tsx:
    - VCS directories excluded
    - Binary files skipped
    - Max columns truncation
    - Per-file and total match caps
    - Glob filtering
    - Pagination via offset/limit (head_limit) – None means DEFAULT_HEAD_LIMIT for API compat,
      pass 0 for unlimited (like GrepTool).

    Returns (matches, truncated) where truncated signals MAX_TOTAL_MATCHES was hit
    or head_limit caused slicing (same semantics as GlobalSearchDialog's `truncated`).
    """
    if not pattern:
        return [], False

    resolved_root = workspace_root.resolve(strict=True)
    if not resolved_root.is_dir():
        raise ValueError("Workspace root is not a directory.")

    glob_patterns = _parse_glob_patterns(glob)
    compiled = _compile_pattern(
        pattern, regex=regex, case_insensitive=case_insensitive
    )

    # Head limit semantics: like GrepTool – 0 = unlimited, None -> DEFAULT_HEAD_LIMIT
    # For search API, callers can pass limit=0 for unlimited; endpoint will translate.
    effective_limit: int | None
    if limit == 0:
        effective_limit = None
    elif limit is None:
        effective_limit = DEFAULT_HEAD_LIMIT
    else:
        effective_limit = limit

    matches: list[SearchMatch] = []
    truncated = False
    total_collected = 0

    # Walk workspace – do not follow symlinks to avoid escapes
    for dirpath, dirnames, filenames in os.walk(
        resolved_root, topdown=True, followlinks=False
    ):
        # Prune VCS directories in-place (ripgrep behaviour)
        dirnames[:] = [d for d in dirnames if d not in VCS_DIRECTORIES_TO_EXCLUDE]
        # Also prune hidden-dir symlink escapes? We include hidden files (like --hidden)
        # but still need to ensure symlink dirs don't escape workspace_root.
        # os.walk with followlinks=False already prevents that; but filter entries that are symlinks outside.
        current_dir = Path(dirpath)
        # Prune directories that are symlinks pointing outside workspace
        safe_dirnames: list[str] = []
        for d in dirnames:
            try:
                candidate = (current_dir / d).resolve(strict=False)
                candidate.relative_to(resolved_root)
                safe_dirnames.append(d)
            except (ValueError, OSError, RuntimeError):
                continue
        dirnames[:] = safe_dirnames

        for filename in filenames:
            if total_collected >= max_total_matches:
                truncated = True
                break
            file_path = current_dir / filename
            try:
                # Ensure file still inside workspace (symlink file check)
                resolved_file = file_path.resolve(strict=False)
                # Use strict=False to handle broken symlinks; then check relative_to
                try:
                    relative = resolved_file.relative_to(resolved_root)
                except ValueError:
                    continue
                # Also handle case where file_path is symlink – ensure resolved still inside
                # If file doesn't exist, skip
                if not file_path.is_file():
                    continue
                # For symlink files, ensure target inside workspace
                if file_path.is_symlink():
                    try:
                        target = file_path.resolve(strict=True)
                        target.relative_to(resolved_root)
                    except (ValueError, OSError, RuntimeError):
                        continue
                relative_posix = relative.as_posix()
            except (OSError, RuntimeError, ValueError):
                continue

            # Glob filtering
            if not _glob_match(relative_posix, glob_patterns):
                continue

            # Skip binary files quickly
            if _is_binary(file_path):
                continue

            # Per-file matching
            try:
                text = file_path.read_text(encoding="utf-8", errors="strict")
            except (UnicodeDecodeError, OSError):
                # Skip unreadable/binary or permission-denied
                continue

            # Split into lines preserving line numbers
            lines = text.splitlines()
            file_matches: list[SearchMatch] = []
            for idx, line in enumerate(lines, start=1):
                if len(file_matches) >= max_matches_per_file:
                    break
                if total_collected >= max_total_matches:
                    truncated = True
                    break
                # Truncate column for output like --max-columns 500
                display_line = line[:max_columns] if len(line) > max_columns else line
                if compiled.search(line):
                    # Use truncated display_line for output but search used full line (already matched)
                    file_matches.append(
                        SearchMatch(
                            file=relative_posix, line=idx, text=display_line
                        )
                    )
                    total_collected += 1
            if file_matches:
                matches.extend(file_matches)
        if truncated:
            break

    # Apply pagination (head_limit/offset) like GrepTool's applyHeadLimit
    # Matches are already ordered by os.walk (filesystem order). For determinism
    # sort by file then line? GrepTool sorts files_with_matches by mtime; for content
    # mode it preserves ripgrep order (which is filesystem + parallelism). We'll
    # keep walk order but provide stable sorting for tests: sort by file,line.
    # However to respect "recent file" UX, we keep collection order; API callers
    # that need sorted can sort client-side. We apply slicing after collection
    # to mimic GrepTool pagination.
    total_before_pagination = len(matches)
    if offset < 0:
        offset = 0
    paginated = matches[offset:]
    if effective_limit is not None:
        if len(paginated) > effective_limit:
            truncated = True
            paginated = paginated[:effective_limit]
        elif total_before_pagination - offset > effective_limit:
            truncated = True
    elif offset > 0 and total_before_pagination > len(paginated):
        # offset caused truncation but not head-limit – not signaled as truncated in GrepTool?
        pass

    # Global cap: if we hit MAX_TOTAL_MATCHES earlier, ensure truncated true
    if total_collected >= max_total_matches and len(matches) >= max_total_matches:
        truncated = True

    return paginated, truncated


def read_file_range(
    workspace_root: Path, relative_path: str, start_line: int, line_count: int
) -> tuple[str, int]:
    """
    Read a range of lines from a workspace file for preview.
    Mirrors GlobalSearchDialog's readFileInRange(absolute, start, PREVIEW_CONTEXT_LINES*2+1).

    start_line is 0-indexed (like JS). Returns (content, total_lines).
    """
    from app.workspace_paths import resolve_workspace_path

    target = resolve_workspace_path(workspace_root, relative_path)
    text = target.read_text(encoding="utf-8", errors="strict")
    lines = text.splitlines()
    total = len(lines)
    # Clamp start
    start = max(0, start_line)
    end = min(total, start + line_count)
    selected = lines[start:end]
    return "\n".join(selected), total
