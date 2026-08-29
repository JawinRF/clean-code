import asyncio
from asyncio import CancelledError
from dataclasses import dataclass, field
import os
from pathlib import Path
import shutil
import signal
import subprocess
from threading import Event, Thread
from time import monotonic, sleep
from typing import BinaryIO


DEFAULT_MAX_STREAM_BYTES = 32_000
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


@dataclass(frozen=True, slots=True)
class SubprocessSpec:
    argv: tuple[str, ...]
    cwd: Path
    timeout_seconds: float
    stdout_max_bytes: int = DEFAULT_MAX_STREAM_BYTES
    stderr_max_bytes: int = DEFAULT_MAX_STREAM_BYTES

    def __post_init__(self) -> None:
        if not self.argv or not self.argv[0]:
            raise ValueError("Subprocess argv must contain an executable.")

        if self.timeout_seconds <= 0:
            raise ValueError("Subprocess timeout must be positive.")

        if self.stdout_max_bytes <= 0 or self.stderr_max_bytes <= 0:
            raise ValueError("Subprocess output limits must be positive.")


@dataclass(frozen=True, slots=True)
class SubprocessOutput:
    data: bytes
    total_bytes: int

    @property
    def kept_bytes(self) -> int:
        return len(self.data)

    @property
    def truncated(self) -> bool:
        return self.total_bytes > self.kept_bytes

    def text(self) -> str:
        data = self.data

        while data and data[0] & 0b1100_0000 == 0b1000_0000:
            data = data[1:]

        return data.decode("utf-8", errors="replace").rstrip()


@dataclass(frozen=True, slots=True)
class SubprocessOutcome:
    exit_code: int | None
    stdout: SubprocessOutput
    stderr: SubprocessOutput
    timed_out: bool
    duration_seconds: float


@dataclass(slots=True)
class _TailCapture:
    maximum_bytes: int
    total_bytes: int = 0
    data: bytearray = field(default_factory=bytearray)

    def append(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        self.data.extend(chunk)
        overflow = len(self.data) - self.maximum_bytes

        if overflow > 0:
            del self.data[:overflow]

    def output(self) -> SubprocessOutput:
        return SubprocessOutput(
            data=bytes(self.data),
            total_bytes=self.total_bytes,
        )


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


def _capture_stream(stream: BinaryIO, capture: _TailCapture) -> None:
    try:
        while chunk := stream.read(READ_CHUNK_BYTES):
            capture.append(chunk)
    except (OSError, ValueError):
        return


def _finish_output_threads(
    process: subprocess.Popen[bytes],
    *threads: Thread,
) -> None:
    deadline = monotonic() + PROCESS_EXIT_GRACE_SECONDS

    for thread in threads:
        remaining = max(0.0, deadline - monotonic())
        thread.join(remaining)

    if any(thread.is_alive() for thread in threads):
        if process.stdout is not None:
            process.stdout.close()

        if process.stderr is not None:
            process.stderr.close()

        for thread in threads:
            thread.join(0.25)


def _wait_for_exit(
    process: subprocess.Popen[bytes],
    timeout_seconds: float,
) -> bool:
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return False

    return True


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.returncode is not None:
        return

    if os.name == "nt":
        taskkill = shutil.which("taskkill")

        if taskkill is not None:
            try:
                subprocess.run(
                    [
                        taskkill,
                        "/PID",
                        str(process.pid),
                        "/T",
                        "/F",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=PROCESS_EXIT_GRACE_SECONDS,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return

    if _wait_for_exit(process, PROCESS_EXIT_GRACE_SECONDS):
        return

    try:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return

    process.wait()


def _run_blocking(
    spec: SubprocessSpec,
    cancel_event: Event,
) -> SubprocessOutcome:
    process_options = {
        "cwd": str(spec.cwd),
        "env": _safe_environment(),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "bufsize": 0,
    }

    if os.name == "nt":
        process = subprocess.Popen(
            spec.argv,
            **process_options,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    else:
        process = subprocess.Popen(
            spec.argv,
            **process_options,
            start_new_session=True,
        )

    if process.stdout is None or process.stderr is None:
        _terminate_process_tree(process)
        raise RuntimeError("Subprocess output streams are not available.")

    stdout = _TailCapture(spec.stdout_max_bytes)
    stderr = _TailCapture(spec.stderr_max_bytes)
    stdout_thread = Thread(
        target=_capture_stream,
        args=(process.stdout, stdout),
        name=f"subprocess-stdout:{process.pid}",
        daemon=True,
    )
    stderr_thread = Thread(
        target=_capture_stream,
        args=(process.stderr, stderr),
        name=f"subprocess-stderr:{process.pid}",
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    started_at = monotonic()
    timed_out = False

    while process.poll() is None:
        if cancel_event.is_set():
            _terminate_process_tree(process)
            break

        if monotonic() - started_at >= spec.timeout_seconds:
            timed_out = True
            _terminate_process_tree(process)
            break

        sleep(0.02)

    _finish_output_threads(process, stdout_thread, stderr_thread)
    return SubprocessOutcome(
        exit_code=process.returncode,
        stdout=stdout.output(),
        stderr=stderr.output(),
        timed_out=timed_out,
        duration_seconds=monotonic() - started_at,
    )


class LocalSubprocessRuntime:
    async def run(self, spec: SubprocessSpec) -> SubprocessOutcome:
        cancel_event = Event()
        worker = asyncio.create_task(
            asyncio.to_thread(_run_blocking, spec, cancel_event)
        )

        try:
            return await asyncio.shield(worker)
        except CancelledError:
            cancel_event.set()

            try:
                await asyncio.shield(worker)
            except Exception:
                pass

            raise
