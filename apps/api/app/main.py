from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import connect_to_database, get_database_session
from app.models import (
    AgentRun,
    AgentSession,
    Message,
    Project,
    RunEvent,
    Workspace,
)
from app.schemas import (
    AgentRunCreate,
    AgentRunExecute,
    AgentRunResponse,
    AgentSessionCreate,
    AgentSessionResponse,
    AgentSessionUpdate,
    GitChangesResponse,
    GitCommitRequest,
    GitRevertRequest,
    WorkspaceFilePreviewResponse,
    WorkspaceSearchMatch,
    WorkspaceSearchResponse,
    MessageCreate,
    MessageResponse,
    ModelCatalogResponse,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    RunEventResponse,
    ToolApprovalDecisionRequest,
    ToolApprovalResponse,
    WorkspaceCreate,
    WorkspaceResponse,
)
from app.services import (
    AgentRunNotFoundError,
    GitOperationError,
    GitPathError,
    GitRepositoryError,
    InvalidWorkspaceRootError,
    RunAlreadyFinishedError,
    RunTaskAlreadyActiveError,
    RunTaskSupervisor,
    RunTaskSupervisorClosedError,
    ToolApprovalCoordinator,
    ToolApprovalNotFoundError,
    ToolApprovalRequest,
    append_run_event,
    collect_git_changes,
    commit_git_files,
    load_model_catalog,
    model_is_configured,
    request_run_cancellation,
    revert_git_file,
    resolve_workspace_root,
)


DatabaseSession = Annotated[Session, Depends(get_database_session)]


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    load_model_catalog()
    approval_coordinator = ToolApprovalCoordinator()
    run_task_supervisor = RunTaskSupervisor(
        approval_coordinator=approval_coordinator,
    )
    application.state.approval_coordinator = approval_coordinator
    application.state.run_task_supervisor = run_task_supervisor

    try:
        yield
    finally:
        await run_task_supervisor.close()


def get_run_task_supervisor(request: Request) -> RunTaskSupervisor:
    return request.app.state.run_task_supervisor


def get_tool_approval_coordinator(
    request: Request,
) -> ToolApprovalCoordinator:
    return request.app.state.approval_coordinator


RunTasks = Annotated[
    RunTaskSupervisor,
    Depends(get_run_task_supervisor),
]
ToolApprovals = Annotated[
    ToolApprovalCoordinator,
    Depends(get_tool_approval_coordinator),
]

app = FastAPI(
    title="Clean Code API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "Clean Code API",
    }


@app.get("/api/v1/ready")
def ready() -> dict[str, str]:
    try:
        with connect_to_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT current_database(), current_user"
                )
                result = cursor.fetchone()

    except psycopg.Error as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PostgreSQL is not available.",
        ) from error

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database connection error: No result returned",
        )

    database_name, user_name = result

    return {
        "status": "ready",
        "database": database_name,
        "user": user_name,
    }


@app.get(
    "/api/v1/projects",
    response_model=list[ProjectResponse],
)
def list_projects(
    session: DatabaseSession,
) -> list[Project]:
    statement = select(Project).order_by(
        Project.created_at.desc()
    )

    return list(session.scalars(statement))


@app.post(
    "/api/v1/projects",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_project(
    payload: ProjectCreate,
    session: DatabaseSession,
) -> Project:
    project = Project(
        name=payload.name,
        description=payload.description,
    )

    session.add(project)

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A project with this name already exists.",
        ) from error

    session.refresh(project)

    return project


@app.patch(
    "/api/v1/projects/{project_id}",
    response_model=ProjectResponse,
)
def update_project(
    project_id: UUID,
    payload: ProjectUpdate,
    session: DatabaseSession,
) -> Project:
    project = session.get(Project, project_id)

    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found.",
        )

    project.name = payload.name

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A project with this name already exists.",
        ) from error

    session.refresh(project)

    return project


@app.delete(
    "/api/v1/projects/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_project(
    project_id: UUID,
    session: DatabaseSession,
) -> Response:
    project = session.get(Project, project_id)

    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found.",
        )

    session.delete(project)
    session.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get(
    "/api/v1/models",
    response_model=ModelCatalogResponse,
)
def list_models() -> ModelCatalogResponse:
    return load_model_catalog()


@app.get(
    "/api/v1/projects/{project_id}/workspaces",
    response_model=list[WorkspaceResponse],
)
def list_workspaces(
    project_id: UUID,
    session: DatabaseSession,
) -> list[Workspace]:
    project = session.get(Project, project_id)

    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found.",
        )

    statement = (
        select(Workspace)
        .where(Workspace.project_id == project_id)
        .order_by(Workspace.created_at.desc())
    )

    return list(session.scalars(statement))


@app.post(
    "/api/v1/projects/{project_id}/workspaces",
    response_model=WorkspaceResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_workspace(
    project_id: UUID,
    payload: WorkspaceCreate,
    session: DatabaseSession,
) -> Workspace:
    project = session.get(Project, project_id)

    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found.",
        )

    try:
        root_path = resolve_workspace_root(payload.root_path)
    except InvalidWorkspaceRootError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(error),
        ) from error

    workspace = Workspace(
        project_id=project_id,
        name=payload.name,
        root_path=root_path,
    )

    session.add(workspace)

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "A workspace with this name or root path already exists."
            ),
        ) from error

    session.refresh(workspace)

    return workspace


def _workspace_or_404(workspace_id: UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)

    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found.",
        )

    return workspace


def _git_http_error(error: Exception) -> HTTPException:
    if isinstance(error, GitRepositoryError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(error),
        )

    if isinstance(error, GitPathError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(error),
        )

    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=str(error),
    )


@app.get(
    "/api/v1/workspaces/{workspace_id}/search",
    response_model=WorkspaceSearchResponse,
)
def search_workspace_files(
    workspace_id: UUID,
    session: DatabaseSession,
    q: str = "",
    glob: str | None = None,
    regex: bool = False,
    case_insensitive: bool = True,
    offset: int = 0,
    limit: int | None = None,
) -> WorkspaceSearchResponse:
    """
    Ripgrep-inspired workspace content search.

    Mirrors claude-code GlobalSearchDialog (debounced, -F fixed string, -i case-insensitive,
    -m 10 per file, MAX_TOTAL 500, truncated flag) and GrepTool pagination.
    `regex=False` treats `q` as fixed string (like GlobalSearchDialog -F); true treats as regex.
    """
    workspace = _workspace_or_404(workspace_id, session)

    if not q or not q.strip():
        return WorkspaceSearchResponse(
            query=q, matches=[], truncated=False, total=0
        )

    # GrepTool head_limit semantics: None -> default 250, 0 -> unlimited
    # For UI we want larger default when called without explicit limit (like GlobalSearchDialog's 500)
    # but keep tool-compat: default 250 unless frontend passes limit
    # Frontend will pass limit=500 to get up to MAX_TOTAL_MATCHES
    from pathlib import Path

    from app.services.workspace_search import search_workspace

    try:
        root = Path(workspace.root_path)
        matches, truncated = search_workspace(
            root,
            q,
            regex=regex,
            case_insensitive=case_insensitive,
            glob=glob,
            offset=offset,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    return WorkspaceSearchResponse(
        query=q,
        matches=[
            WorkspaceSearchMatch(file=m.file, line=m.line, text=m.text)
            for m in matches
        ],
        truncated=truncated,
        total=len(matches),
    )


@app.get(
    "/api/v1/workspaces/{workspace_id}/file",
    response_model=WorkspaceFilePreviewResponse,
)
def read_workspace_file_preview(
    workspace_id: UUID,
    session: DatabaseSession,
    path: str = "",
    start_line: int = 0,
    line_count: int = 9,
) -> WorkspaceFilePreviewResponse:
    """
    Read a range of lines for preview, like GlobalSearchDialog's readFileInRange
    (PREVIEW_CONTEXT_LINES*2+1 = 9). 0-indexed start_line.
    """
    workspace = _workspace_or_404(workspace_id, session)

    if not path or not path.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Query parameter 'path' must be a relative workspace file path.",
        )

    # Clamp line_count to prevent large reads
    if line_count <= 0 or line_count > 100:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="line_count must be between 1 and 100.",
        )
    if start_line < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="start_line must be >= 0.",
        )

    from pathlib import Path

    from app.services.workspace_search import read_file_range
    from app.workspace_paths import InvalidWorkspacePathError

    try:
        root = Path(workspace.root_path)
        content, total = read_file_range(root, path, start_line, line_count)
    except InvalidWorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Workspace file is not valid UTF-8 text.",
        )
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc

    return WorkspaceFilePreviewResponse(
        file=path, content=content, start_line=start_line, total_lines=total
    )


@app.get(
    "/api/v1/workspaces/{workspace_id}/git/changes",
    response_model=GitChangesResponse,
)
def get_git_changes(
    workspace_id: UUID,
    session: DatabaseSession,
) -> GitChangesResponse:
    workspace = _workspace_or_404(workspace_id, session)

    try:
        return collect_git_changes(workspace.root_path)
    except (GitRepositoryError, GitPathError, GitOperationError) as error:
        raise _git_http_error(error) from error


@app.post(
    "/api/v1/workspaces/{workspace_id}/git/revert",
    response_model=GitChangesResponse,
)
def revert_workspace_git_file(
    workspace_id: UUID,
    payload: GitRevertRequest,
    session: DatabaseSession,
) -> GitChangesResponse:
    workspace = _workspace_or_404(workspace_id, session)

    try:
        return revert_git_file(workspace.root_path, payload.path)
    except (GitRepositoryError, GitPathError, GitOperationError) as error:
        raise _git_http_error(error) from error


@app.post(
    "/api/v1/workspaces/{workspace_id}/git/commit",
    response_model=GitChangesResponse,
)
def commit_workspace_git_files(
    workspace_id: UUID,
    payload: GitCommitRequest,
    session: DatabaseSession,
) -> GitChangesResponse:
    workspace = _workspace_or_404(workspace_id, session)

    try:
        return commit_git_files(
            workspace.root_path,
            paths=payload.paths,
            message=payload.message,
            branch_name=payload.branch_name,
        )
    except (GitRepositoryError, GitPathError, GitOperationError) as error:
        raise _git_http_error(error) from error


@app.get(
    "/api/v1/workspaces/{workspace_id}/sessions",
    response_model=list[AgentSessionResponse],
)
def list_agent_sessions(
    workspace_id: UUID,
    session: DatabaseSession,
) -> list[AgentSession]:
    workspace = session.get(Workspace, workspace_id)

    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found.",
        )

    statement = (
        select(AgentSession)
        .where(AgentSession.workspace_id == workspace_id)
        .order_by(AgentSession.created_at.desc())
    )

    return list(session.scalars(statement))


@app.post(
    "/api/v1/workspaces/{workspace_id}/sessions",
    response_model=AgentSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_agent_session(
    workspace_id: UUID,
    payload: AgentSessionCreate,
    session: DatabaseSession,
) -> AgentSession:
    workspace = session.get(Workspace, workspace_id)

    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found.",
        )

    agent_session = AgentSession(
        workspace_id=workspace_id,
        title=payload.title,
    )

    session.add(agent_session)
    session.commit()
    session.refresh(agent_session)

    return agent_session


@app.get(
    "/api/v1/sessions/{session_id}",
    response_model=AgentSessionResponse,
)
def get_agent_session(
    session_id: UUID,
    session: DatabaseSession,
) -> AgentSession:
    agent_session = session.get(AgentSession, session_id)

    if agent_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent session not found.",
        )

    return agent_session


@app.patch(
    "/api/v1/sessions/{session_id}",
    response_model=AgentSessionResponse,
)
def update_agent_session(
    session_id: UUID,
    payload: AgentSessionUpdate,
    session: DatabaseSession,
) -> AgentSession:
    agent_session = session.get(AgentSession, session_id)

    if agent_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent session not found.",
        )

    agent_session.title = payload.title
    session.commit()
    session.refresh(agent_session)

    return agent_session


@app.delete(
    "/api/v1/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_agent_session(
    session_id: UUID,
    session: DatabaseSession,
) -> Response:
    agent_session = session.get(AgentSession, session_id)

    if agent_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent session not found.",
        )

    session.delete(agent_session)
    session.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get(
    "/api/v1/sessions/{session_id}/messages",
    response_model=list[MessageResponse],
)
def list_messages(
    session_id: UUID,
    session: DatabaseSession,
) -> list[Message]:
    agent_session = session.get(AgentSession, session_id)

    if agent_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent session not found.",
        )

    statement = (
        select(Message)
        .where(Message.session_id == session_id)
        .order_by(Message.created_at.asc())
    )

    return list(session.scalars(statement))


@app.post(
    "/api/v1/sessions/{session_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_user_message(
    session_id: UUID,
    payload: MessageCreate,
    session: DatabaseSession,
) -> Message:
    agent_session = session.get(AgentSession, session_id)

    if agent_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent session not found.",
        )

    message = Message(
        session_id=session_id,
        role="user",
        content={
            "parts": [
                {
                    "type": "text",
                    "text": payload.text,
                },
            ],
        },
    )

    session.add(message)
    session.commit()
    session.refresh(message)

    return message


@app.post(
    "/api/v1/sessions/{session_id}/runs",
    response_model=AgentRunResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_agent_run(
    session_id: UUID,
    payload: AgentRunCreate,
    session: DatabaseSession,
) -> AgentRun:
    agent_session = session.get(AgentSession, session_id)

    if agent_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent session not found.",
        )

    if not model_is_configured(
        load_model_catalog(),
        provider_id=payload.model_provider,
        model_id=payload.model_name,
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="The selected model is not configured.",
        )

    if payload.trigger_message_id is not None:
        trigger_message = session.get(
            Message,
            payload.trigger_message_id,
        )

        if (
            trigger_message is None
            or trigger_message.session_id != session_id
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trigger message not found in this agent session.",
            )

        if trigger_message.role != "user":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Trigger message must have the user role.",
            )

    agent_run = AgentRun(
        session_id=session_id,
        trigger_message_id=payload.trigger_message_id,
        model_provider=payload.model_provider,
        model_name=payload.model_name,
    )

    session.add(agent_run)
    session.flush()

    append_run_event(
        session,
        run_id=agent_run.id,
        event_type="run.created",
        payload={
            "status": agent_run.status,
            "model_provider": agent_run.model_provider,
            "model_name": agent_run.model_name,
        },
    )

    session.commit()
    session.refresh(agent_run)

    return agent_run


@app.get(
    "/api/v1/runs/{run_id}",
    response_model=AgentRunResponse,
)
def get_agent_run(
    run_id: UUID,
    session: DatabaseSession,
) -> AgentRun:
    agent_run = session.get(AgentRun, run_id)

    if agent_run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found.",
        )

    return agent_run


@app.get(
    "/api/v1/runs/{run_id}/events",
    response_model=list[RunEventResponse],
)
def list_run_events(
    run_id: UUID,
    session: DatabaseSession,
) -> list[RunEvent]:
    agent_run = session.get(AgentRun, run_id)

    if agent_run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found.",
        )

    statement = (
        select(RunEvent)
        .where(RunEvent.run_id == run_id)
        .order_by(RunEvent.sequence.asc())
    )

    return list(session.scalars(statement))


@app.get(
    "/api/v1/runs/{run_id}/approvals",
    response_model=list[ToolApprovalResponse],
)
async def list_pending_tool_approvals(
    run_id: UUID,
    session: DatabaseSession,
    approvals: ToolApprovals,
) -> tuple[ToolApprovalRequest, ...]:
    agent_run = session.get(AgentRun, run_id)

    if agent_run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found.",
        )

    return approvals.pending_for_run(run_id)


@app.post(
    "/api/v1/runs/{run_id}/approvals/{approval_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def decide_tool_approval(
    run_id: UUID,
    approval_id: UUID,
    payload: ToolApprovalDecisionRequest,
    session: DatabaseSession,
    approvals: ToolApprovals,
) -> Response:
    agent_run = session.get(AgentRun, run_id)

    if agent_run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found.",
        )

    try:
        approvals.decide(
            run_id=run_id,
            approval_id=approval_id,
            decision=payload.decision,
        )
    except ToolApprovalNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pending tool approval not found.",
        ) from error

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post(
    "/api/v1/runs/{run_id}/execute",
    response_model=AgentRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def execute_agent_run(
    run_id: UUID,
    payload: AgentRunExecute,
    session: DatabaseSession,
    run_tasks: RunTasks,
) -> AgentRun:
    agent_run = session.get(AgentRun, run_id)

    if agent_run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found.",
        )

    if agent_run.status != "queued":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only a queued agent run can start execution.",
        )

    try:
        run_tasks.start(
            run_id=run_id,
            max_output_tokens=payload.max_output_tokens,
            max_steps=payload.max_steps,
        )
    except RunTaskAlreadyActiveError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Agent run already has an active execution task.",
        ) from error
    except RunTaskSupervisorClosedError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent run execution is not available.",
        ) from error

    return agent_run


@app.post(
    "/api/v1/runs/{run_id}/cancel",
    response_model=AgentRunResponse,
)
async def cancel_agent_run(
    run_id: UUID,
    session: DatabaseSession,
    run_tasks: RunTasks,
) -> AgentRun:
    try:
        agent_run = request_run_cancellation(
            session,
            run_id=run_id,
        )
    except AgentRunNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent run not found.",
        ) from error
    except RunAlreadyFinishedError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Agent run has already finished.",
        ) from error

    session.commit()
    run_tasks.cancel(run_id)

    return agent_run
