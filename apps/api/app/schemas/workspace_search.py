from pydantic import BaseModel, Field


class WorkspaceSearchMatch(BaseModel):
    file: str = Field(description="Relative POSIX path inside workspace.")
    line: int = Field(ge=1, description="1-indexed line number.")
    text: str = Field(description="Line content truncated to 500 columns.")


class WorkspaceSearchResponse(BaseModel):
    query: str = Field(description="Original search query.")
    matches: list[WorkspaceSearchMatch] = Field(
        description="Matching lines. Ordered by filesystem walk; at most 500 total."
    )
    truncated: bool = Field(
        description="True when more matches exist but were capped (per-file 10, total 500, or head_limit)."
    )
    total: int = Field(description="Number of matches returned (after pagination).")


class WorkspaceFilePreviewResponse(BaseModel):
    file: str = Field(description="Relative POSIX path.")
    content: str = Field(description="Selected lines joined by \\n.")
    start_line: int = Field(description="0-indexed start line requested.")
    total_lines: int = Field(description="Total lines in file.")
