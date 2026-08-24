from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import connect_to_database, get_database_session
from app.models import Project
from app.schemas import ProjectCreate, ProjectResponse


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
