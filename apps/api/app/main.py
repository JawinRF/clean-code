from typing import Annotated
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import connect_to_database, get_database_session
from app.models import Project, Workspace
from app.schemas import (
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
