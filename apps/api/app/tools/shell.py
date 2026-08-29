import asyncio
from asyncio import CancelledError
from dataclasses import dataclass, field
import os
from pathlib import Path
import shutil
import signal
import subprocess
from time import monotonic

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.tools.base import ToolResult
from app.workspace_paths import (
    InvalidWorkspacePathError,
    resolve_workspace_path,
)


DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 600
MAX_STREAM_OUTPUT_BYTES = 32_000
READ_CHUNK_BYTES = 8_192
PROCESS_EXIT_GRACE_SECONDS = 3

_SAFE_ENVIRONMENT_NAMES = frozenset(
    {
        "APPDATA",
        "CARGO_HOME",
        "CI",
        "COMMONPROGRAMFILES",
        "COMMONPROGRAMFILES(X86)",
        "COMSPEC",
        "DOTNET_ROOT",
        "GOPATH",
        "HOMEDRIVE",
        "HOMEPATH",
        "JAVA_HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "NO_COLOR",
        "NUMBER_OF_PROCESSORS",
        "NVM_HOME",
        "NVM_SYMLINK",
        "PATH",
        "PATHEXT",
        "PNPM_HOME",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PSMODULEPATH",
        "RUSTUP_HOME",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "VIRTUAL_ENV",
        "WINDIR",
    }
)


class ShellInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command: str = Field(
        min_length=1,
        max_length=20_000,
        description="The shell command to execute.",
    )
    description: str = Field(
        min_length=1,
        max_length=160,
        description=(
            "A short description of the command for the approval dialog."
        ),
    )
    workdir: str = Field(
        default=".",
        min_length=1,
        max_length=1_000,
        description=(
            "An existing workspace-relative directory. Defaults to the "
            "workspace root."
        ),
    )
    timeout_seconds: int = Field(
        default=DEFAULT_TIMEOUT_SECONDS,
        ge=1,
        le=MAX_TIMEOUT_SECONDS,
        description=(
            "Maximum foreground execution time in seconds."
        ),
    )

    @field_validator("command", "description")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Value must contain non-whitespace text.")

        return value


@dataclass(slots=True)
class _TailCapture:
    maximum_bytes: int
    total_bytes: int = 0
    data: bytearray = field(default_factory=bytearray)

    @property
    def truncated(self) -> bool:
        return self.total_bytes > len(self.data)

    def append(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        self.data.extend(chunk)

        overflow = len(self.data) - self.maximum_bytes

        if overflow > 0:
            del self.data[:overflow]

    def text(self) -> str:
        data = bytes(self.data)

        while data and data[0] & 0b1100_0000 == 0b1000_0000:
            data = data[1:]

        return data.decode("utf-8", errors="replace").rstrip()


@dataclass(frozen=True, slots=True)
class _ShellCommand:
    executable: str
    arguments: tuple[str, ...]
    display_name: str


@dataclass(frozen=True, slots=True)
class _ShellOutcome:
    exit_code: int | None
    stdout: _TailCapture
    stderr: _TailCapture
    timed_out: bool
    duration_seconds: float


def _safe_environment() -> dict[str, str]:
    environment = {
        name: value
        for name, value in os.environ.items()
        if name.upper() in _SAFE_ENVIRONMENT_NAMES
        or name.upper().startswith("LC_")
    }
    environment["NO_COLOR"] = "1"
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUNBUFFERED"] = "1"
    return environment


def _resolve_shell(command: str) -> _ShellCommand | None:
    if os.name == "nt":
        executable = shutil.which("pwsh") or shutil.which("powershell")

        if executable is None:
            return None

        display_name = (
            "PowerShell 7+"
            if Path(executable).stem.casefold() == "pwsh"
            else "Windows PowerShell"
        )
        wrapped_command = (
            f"& {{ {command} }}\n"
            "$__clean_code_succeeded = $?\n"
            "$__clean_code_exit = $LASTEXITCODE\n"
            "if ($null -ne $__clean_code_exit -and "
            "$__clean_code_exit -ne 0) { exit $__clean_code_exit }\n"
            "if (-not $__clean_code_succeeded) { exit 1 }\n"
            "exit 0"
        )
        return _ShellCommand(
            executable=executable,
            arguments=(
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                wrapped_command,
            ),
            display_name=display_name,
        )

    executable = shutil.which("bash") or shutil.which("sh")

    if executable is None:
        return None

    return _ShellCommand(
        executable=executable,
        arguments=("-c", command),
        display_name=Path(executable).name,
    )


async def _capture_stream(
    stream: asyncio.StreamReader,
    capture: _TailCapture,
) -> None:
    while chunk := await stream.read(READ_CHUNK_BYTES):
        capture.append(chunk)


async def _finish_output_tasks(
    *tasks: asyncio.Task[None],
) -> None:
    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks),
            timeout=PROCESS_EXIT_GRACE_SECONDS,
        )
    except TimeoutError:
        for task in tasks:
            task.cancel()

        await asyncio.gather(*tasks, return_exceptions=True)


async def _wait_for_exit(
    process: asyncio.subprocess.Process,
    timeout_seconds: float,
) -> bool:
    try:
        await asyncio.wait_for(
            process.wait(),
            timeout=timeout_seconds,
        )
    except TimeoutError:
        return False

    return True


async def _terminate_process_tree(
    process: asyncio.subprocess.Process,
) -> None:
    if process.returncode is not None:
        return

    if os.name == "nt":
        taskkill = shutil.which("taskkill")

        if taskkill is not None:
            try:
                killer = await asyncio.create_subprocess_exec(
                    taskkill,
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(
                    killer.wait(),
                    timeout=PROCESS_EXIT_GRACE_SECONDS,
                )
            except (OSError, TimeoutError):
                pass
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return

    if await _wait_for_exit(process, PROCESS_EXIT_GRACE_SECONDS):
        return

    try:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return

    await process.wait()


async def _run_shell_command(
    shell: _ShellCommand,
    *,
    workdir: Path,
    timeout_seconds: int,
) -> _ShellOutcome:
    process_arguments = (shell.executable, *shell.arguments)
    process_options = {
        "cwd": str(workdir),
        "env": _safe_environment(),
        "stdin": asyncio.subprocess.DEVNULL,
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
    }

    if os.name == "nt":
        process = await asyncio.create_subprocess_exec(
            *process_arguments,
            **process_options,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    else:
        process = await asyncio.create_subprocess_exec(
            *process_arguments,
            **process_options,
            start_new_session=True,
        )

    if process.stdout is None or process.stderr is None:
        await _terminate_process_tree(process)
        raise RuntimeError("Shell output streams are not available.")

    stdout = _TailCapture(MAX_STREAM_OUTPUT_BYTES)
    stderr = _TailCapture(MAX_STREAM_OUTPUT_BYTES)
    stdout_task = asyncio.create_task(
        _capture_stream(process.stdout, stdout)
    )
    stderr_task = asyncio.create_task(
        _capture_stream(process.stderr, stderr)
    )
    started_at = monotonic()
    timed_out = False

    try:
        try:
            await asyncio.wait_for(
                process.wait(),
                timeout=timeout_seconds,
            )
        except TimeoutError:
            timed_out = True
            await _terminate_process_tree(process)
    except CancelledError:
        await _terminate_process_tree(process)
        await _finish_output_tasks(stdout_task, stderr_task)
        raise

    await _finish_output_tasks(stdout_task, stderr_task)
    return _ShellOutcome(
        exit_code=process.returncode,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
        duration_seconds=monotonic() - started_at,
    )


def _render_stream(name: str, capture: _TailCapture) -> str:
    text = capture.text() or "(no output)"

    if not capture.truncated:
        return f"<{name}>\n{text}\n</{name}>"

    kept_bytes = len(capture.data)
    return (
        f"<{name} truncated=\"true\" "
        f"kept_bytes=\"{kept_bytes}\" "
        f"total_bytes=\"{capture.total_bytes}\">\n"
        f"{text}\n"
        f"</{name}>"
    )


class ShellTool:
    name = "shell"
    input_model = ShellInput
    requires_approval = True

    def __init__(self, *, workspace_root: str | Path) -> None:
        self._workspace_root = Path(workspace_root).resolve(strict=True)
        shell = _resolve_shell("")
        shell_name = shell.display_name if shell is not None else "shell"
        self.description = (
            f"Execute one non-interactive {shell_name} command in a fresh "
            "process inside the active workspace. Each call requires user "
            "approval. Use workdir instead of changing directory. Commands "
            "time out, stop when the agent run is cancelled, and return "
            "bounded stdout, stderr, exit code, and duration. Shell state "
            "does not persist between calls."
        )

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, ShellInput):
            raise TypeError("ShellTool requires ShellInput arguments.")

        try:
            workdir = resolve_workspace_path(
                self._workspace_root,
                arguments.workdir,
            )
        except InvalidWorkspacePathError as error:
            return ToolResult(content=str(error), is_error=True)

        if not workdir.is_dir():
            return ToolResult(
                content=(
                    "Shell workdir must be an existing directory inside "
                    "the workspace."
                ),
                is_error=True,
            )

        shell = _resolve_shell(arguments.command)

        if shell is None:
            return ToolResult(
                content="No supported local shell is available.",
                is_error=True,
            )

        try:
            outcome = await _run_shell_command(
                shell,
                workdir=workdir,
                timeout_seconds=arguments.timeout_seconds,
            )
        except OSError:
            return ToolResult(
                content="The shell process could not be started.",
                is_error=True,
            )

        relative_workdir = workdir.relative_to(
            self._workspace_root
        ).as_posix()
        display_workdir = relative_workdir or "."
        exit_code = (
            "unavailable"
            if outcome.exit_code is None
            else str(outcome.exit_code)
        )
        summary = [
            f"Shell: {shell.display_name}",
            f"Workdir: {display_workdir}",
            f"Exit code: {exit_code}",
            f"Duration: {outcome.duration_seconds:.3f} seconds",
            f"Timed out: {'yes' if outcome.timed_out else 'no'}",
            _render_stream("stdout", outcome.stdout),
            _render_stream("stderr", outcome.stderr),
        ]
        return ToolResult(
            content="\n".join(summary),
            is_error=(
                outcome.timed_out
                or outcome.exit_code is None
                or outcome.exit_code != 0
            ),
        )
