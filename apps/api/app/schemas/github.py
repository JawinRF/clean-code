from pydantic import BaseModel, Field


class GitHubPushRequest(BaseModel):
    repository: str = Field(min_length=3, max_length=160)
    branch: str = Field(min_length=1, max_length=240)
    expected_head: str = Field(pattern=r"^[0-9a-f]{40,64}$")
    confirmed: bool


class GitHubPullRequest(GitHubPushRequest):
    base: str = Field(min_length=1, max_length=240)
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(max_length=50000)
    draft: bool = True


class GitHubCloneRequest(BaseModel):
    repository: str = Field(min_length=3, max_length=160)
    directory: str = Field(min_length=1, max_length=80)
    confirmed: bool
