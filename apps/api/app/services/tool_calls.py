from dataclasses import dataclass, field

from app.providers import ToolCallDelta


class ToolCallAssemblyError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class AssembledToolCall:
    call_id: str
    name: str
    arguments_json: str


@dataclass(slots=True)
class _PendingToolCall:
    call_id: str
    name: str
    argument_fragments: list[str] = field(default_factory=list)


class ToolCallAssembler:
    def __init__(self) -> None:
        self._calls: dict[str, _PendingToolCall] = {}

    def add(self, event: ToolCallDelta) -> None:
        pending_call = self._calls.get(event.call_id)

        if pending_call is None:
            if event.name is None:
                raise ToolCallAssemblyError(
                    "The first tool-call event must include a name."
                )

            pending_call = _PendingToolCall(
                call_id=event.call_id,
                name=event.name,
            )
            self._calls[event.call_id] = pending_call
        elif event.name is not None and event.name != pending_call.name:
            raise ToolCallAssemblyError(
                "A tool call cannot change its name while streaming."
            )

        pending_call.argument_fragments.append(event.arguments_delta)

    def finish(self) -> tuple[AssembledToolCall, ...]:
        return tuple(
            AssembledToolCall(
                call_id=pending_call.call_id,
                name=pending_call.name,
                arguments_json="".join(
                    pending_call.argument_fragments
                ),
            )
            for pending_call in self._calls.values()
        )
