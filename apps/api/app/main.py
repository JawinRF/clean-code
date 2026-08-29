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
    InvalidWorkspaceRootError,
    RunAlreadyFinishedError,
    RunTaskAlreadyActiveError,
    RunTaskSupervisor,
    RunTaskSupervisorClosedError,
    ToolApprovalCoordinator,
    ToolApprovalNotFoundError,
    ToolApprovalRequest,
    append_run_event,
    load_model_catalog,
    model_is_configured,
    request_run_cancellation,
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
