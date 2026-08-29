from typing import Literal

from pydantic import BaseModel, Field


GitDiffLineType = Literal["context", "addition", "deletion"]
GitFileStatus = Literal[
    "added",
    "deleted",
    "modified",
    "renamed",
    "untracked",
]


class GitDiffLine(BaseModel):
    old_line_number: int | None = None
    new_line_number: int | None = None
    type: GitDiffLineType
    content: str


class GitChangedFile(BaseModel):
    path: str
    previous_path: str | None = None
    status: GitFileStatus
    language: str
    additions: int
    deletions: int
    is_binary: bool
    lines: list[GitDiffLine]


class GitChangesResponse(BaseModel):
    branch: str
    additions: int
    deletions: int
    files: list[GitChangedFile]


class GitRevertRequest(BaseModel):
    path: str = Field(min_length=1)


class GitCommitRequest(BaseModel):
    paths: list[str] = Field(min_length=1)
    message: str = Field(min_length=1, max_length=200)
    branch_name: str | None = Field(default=None, min_length=1, max_length=120)
