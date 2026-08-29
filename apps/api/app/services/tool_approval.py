import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4


ToolApprovalDecision = Literal["approved", "rejected"]


class ToolApprovalNotFoundError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class ToolApprovalRequest:
    id: UUID
    run_id: UUID
    call_id: str
    tool_name: str
    reason: str
    arguments: dict[str, object]
    requested_at: datetime


@dataclass(slots=True)
class _PendingToolApproval:
    request: ToolApprovalRequest
    future: asyncio.Future[ToolApprovalDecision]


class ToolApprovalCoordinator:
    def __init__(self) -> None:
        self._pending: dict[UUID, _PendingToolApproval] = {}

    def open(
        self,
        *,
        run_id: UUID,
        call_id: str,
        tool_name: str,
        reason: str,
        arguments: dict[str, object],
    ) -> ToolApprovalRequest:
        request = ToolApprovalRequest(
            id=uuid4(),
            run_id=run_id,
            call_id=call_id,
            tool_name=tool_name,
            reason=reason,
            arguments=arguments,
            requested_at=datetime.now(UTC),
        )
        self._pending[request.id] = _PendingToolApproval(
            request=request,
            future=asyncio.get_running_loop().create_future(),
        )
        return request

    async def wait(
        self,
        approval_id: UUID,
    ) -> ToolApprovalDecision:
        pending = self._pending.get(approval_id)

        if pending is None:
            raise ToolApprovalNotFoundError

        try:
            return await pending.future
        finally:
            self._pending.pop(approval_id, None)

    def decide(
        self,
        *,
        run_id: UUID,
        approval_id: UUID,
        decision: ToolApprovalDecision,
    ) -> ToolApprovalRequest:
        pending = self._pending.get(approval_id)

        if pending is None or pending.request.run_id != run_id:
            raise ToolApprovalNotFoundError

        if pending.future.done():
            del self._pending[approval_id]
            raise ToolApprovalNotFoundError

        pending.future.set_result(decision)
        del self._pending[approval_id]
        return pending.request

    def withdraw(self, approval_id: UUID) -> bool:
        pending = self._pending.pop(approval_id, None)

        if pending is None:
            return False

        if not pending.future.done():
            pending.future.cancel()

        return True

    def pending_for_run(
        self,
        run_id: UUID,
    ) -> tuple[ToolApprovalRequest, ...]:
        return tuple(
            pending.request
            for pending in self._pending.values()
            if pending.request.run_id == run_id
        )
