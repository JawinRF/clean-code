from pydantic import BaseModel, Field

from app.tools.base import ToolResult


class EchoInput(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=2_000,
    )


class EchoTool:
    name = "echo"
    description = "Return the supplied text without changing it."
    input_model = EchoInput
    requires_approval = False

    async def execute(self, arguments: BaseModel) -> ToolResult:
        if not isinstance(arguments, EchoInput):
            raise TypeError("EchoTool requires EchoInput arguments.")

        return ToolResult(content=arguments.text)
