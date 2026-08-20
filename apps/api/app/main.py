import psycopg
from fastapi import FastAPI, HTTPException, status

from app.database import connect_to_database


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
            detail=f"PostgreSQL is not available.",
        ) from error

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database connection error: No result returned",
        )
    database_name, user_name = result

    return{
        "status": "ready",
        "database": database_name,
        "user": user_name,
    }