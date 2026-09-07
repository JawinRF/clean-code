from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.database import get_database_session
from app.models import Workspace
from app.schemas.github import GitHubCloneRequest, GitHubPullRequest, GitHubPushRequest
from app.services import github
from app.services.git_changes import GitOperationError, GitRepositoryError


def local_request(request: Request) -> None:
    if request.client is None or request.client.host not in {'127.0.0.1', '::1'}:
        raise HTTPException(403, 'GitHub actions require the local runtime.')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site GitHub requests are not allowed.')
    origin = request.headers.get('origin')
    if origin:
        try:
            parsed = urlsplit(origin)
            allowed = parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'} and parsed.port in {5173, 4173, 8000}
        except ValueError:
            allowed = False
        if not allowed:
            raise HTTPException(403, 'This browser origin cannot use local GitHub actions.')


router = APIRouter(prefix='/api/v1', tags=['GitHub'], dependencies=[Depends(local_request)])
DatabaseSession = Annotated[Session, Depends(get_database_session)]


def workspace_root(workspace_id: UUID, session: Session) -> str:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(404, 'Workspace not found.')
    return workspace.root_path


def perform(operation, *args) -> dict:
    try:
        return operation(*args)
    except (github.GitHubError, GitOperationError, GitRepositoryError, OSError) as error:
        detail = str(error) if isinstance(error, github.GitHubError) else 'The workspace repository could not be read. Check its local path and Git configuration.'
        raise HTTPException(409, detail) from error


@router.get('/github/connection')
def connection() -> dict:
    return github.connection_status()


@router.get('/github/repositories')
def repositories(page: Annotated[int, Query(ge=1, le=1000)] = 1) -> dict:
    return perform(github.list_repositories, page)


@router.get('/workspaces/{workspace_id}/github')
def repository(workspace_id: UUID, session: DatabaseSession) -> dict:
    return perform(github.repository_status, workspace_root(workspace_id, session))


@router.post('/workspaces/{workspace_id}/github/push')
def push(workspace_id: UUID, payload: GitHubPushRequest, session: DatabaseSession) -> dict:
    return perform(github.push_branch, workspace_root(workspace_id, session), payload)


@router.post('/workspaces/{workspace_id}/github/pull-requests')
def pull_request(workspace_id: UUID, payload: GitHubPullRequest, session: DatabaseSession) -> dict:
    return perform(github.create_pull_request, workspace_root(workspace_id, session), payload)


@router.post('/workspaces/{workspace_id}/github/fetch')
def fetch(workspace_id: UUID, payload: GitHubPushRequest, session: DatabaseSession) -> dict:
    return perform(github.fetch_branches, workspace_root(workspace_id, session), payload)


@router.post('/workspaces/{workspace_id}/github/clone')
def clone(workspace_id: UUID, payload: GitHubCloneRequest, session: DatabaseSession) -> dict:
    return perform(github.clone_repository, workspace_root(workspace_id, session), payload)
