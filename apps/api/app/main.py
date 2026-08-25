from typing import Annotated
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import connect_to_database, get_database_session
from app.models import AgentSession, Message, Project, Workspace
from app.schemas import (
    AgentSessionCreate,
    AgentSessionResponse,
    MessageCreate,
    MessageResponse,
    ProjectCreate,
    ProjectResponse,
    WorkspaceCreate,
    WorkspaceResponse,
)
from app.services import (
    InvalidWorkspaceRootError,
    resolve_workspace_root,
)


DatabaseSession = Annotated[Session, Depends(get_database_session)]

app = FastAPI(
    title="Clean Code API",
    version="0.1.0",
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
