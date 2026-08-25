from datetime import UTC, datetime

from app.models import AgentRun


class RunAlreadyFinishedError(Exception):
    pass


def request_run_cancellation(run: AgentRun) -> None:
    if run.status == "cancelled":
        return

    if run.status in {"completed", "failed"}:
        raise RunAlreadyFinishedError

    requested_at = run.cancel_requested_at or datetime.now(UTC)
    run.cancel_requested_at = requested_at

    if run.status == "queued":
        run.status = "cancelled"
        run.finished_at = requested_at
