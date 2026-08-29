from dataclasses import dataclass
import os
from pathlib import Path
import shutil

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.runtime.subprocess import (
    LocalSubprocessRuntime,
    SubprocessOutput,
    SubprocessSpec,
)
from app.tools.base import ToolResult
from app.workspace_paths import (
    InvalidWorkspacePathError,
    resolve_workspace_path,
)


DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 600
MAX_STREAM_OUTPUT_BYTES = 32_000


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


@dataclass(frozen=True, slots=True)
class _ShellCommand:
    executable: str
    arguments: tuple[str, ...]
    display_name: str


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


def _render_stream(name: str, capture: SubprocessOutput) -> str:
    text = capture.text() or "(no output)"

    if not capture.truncated:
        return f"<{name}>\n{text}\n</{name}>"

    return (
        f"<{name} truncated=\"true\" "
        f"kept_bytes=\"{capture.kept_bytes}\" "
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
        self._subprocess_runtime = LocalSubprocessRuntime()
        shell = _resolve_shell("")
        shell_name = shell.display_name if shell is not None else "shell"
        syntax_guidance = (
            " This host uses Windows PowerShell 5.1. Do not use && or ||; "
            "use semicolons and `if ($?) { ... }` for conditional chaining."
            if shell_name == "Windows PowerShell"
            else ""
        )
        self.description = (
            f"Execute one non-interactive {shell_name} command in a fresh "
            "process inside the active workspace. Each call requires user "
            "approval. Use workdir instead of changing directory. Commands "
            "time out, stop when the agent run is cancelled, and return "
            "bounded stdout, stderr, exit code, and duration. Shell state "
            "does not persist between calls. Do not change global "
            "configuration or credentials unless the user explicitly asks "
            f"for that change.{syntax_guidance}"
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
            outcome = await self._subprocess_runtime.run(
                SubprocessSpec(
                    argv=(shell.executable, *shell.arguments),
                    cwd=workdir,
                    timeout_seconds=arguments.timeout_seconds,
                    stdout_max_bytes=MAX_STREAM_OUTPUT_BYTES,
                    stderr_max_bytes=MAX_STREAM_OUTPUT_BYTES,
                )
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
