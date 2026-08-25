from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AgentRun(Base):
    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint(
            (
                "status IN ("
                "'queued', "
                "'running', "
                "'completed', "
                "'failed', "
                "'cancelled'"
                ")"
            ),
            name="ck_runs_status",
        ),
        Index(
            "ix_runs_session_id_created_at",
            "session_id",
            "created_at",
        ),
        Index(
            "ix_runs_status_created_at",
            "status",
            "created_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid,
        primary_key=True,
        default=uuid4,
    )
    session_id: Mapped[UUID] = mapped_column(
        Uuid,
        ForeignKey(
            "agent_sessions.id",
            ondelete="CASCADE",
        ),
        nullable=False,
    )
    trigger_message_id: Mapped[UUID | None] = mapped_column(
        Uuid,
        ForeignKey(
            "messages.id",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(32),
        server_default=text("'queued'"),
        nullable=False,
    )
    model_provider: Mapped[str] = mapped_column(
        String(80),
        nullable=False,
    )
    model_name: Mapped[str] = mapped_column(
        String(160),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    error_code: Mapped[str | None] = mapped_column(
        String(120),
        nullable=True,
    )
    error_message: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )
