"""Add durable parent/child agent lineage.

Revision ID: 72d104a98bce
Revises: 1800be07591d
"""
from alembic import op
import sqlalchemy as sa

revision = "72d104a98bce"
down_revision = "1800be07591d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_sessions", sa.Column("parent_session_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_agent_sessions_parent_session_id", "agent_sessions", "agent_sessions",
        ["parent_session_id"], ["id"], ondelete="CASCADE",
    )
    op.create_index("ix_agent_sessions_parent_session_id", "agent_sessions", ["parent_session_id"])
    op.add_column("runs", sa.Column("parent_run_id", sa.Uuid(), nullable=True))
    op.add_column("runs", sa.Column("agent_label", sa.String(160), nullable=True))
    op.create_foreign_key(
        "fk_runs_parent_run_id", "runs", "runs", ["parent_run_id"], ["id"], ondelete="CASCADE",
    )
    op.create_index("ix_runs_parent_run_id", "runs", ["parent_run_id"])


def downgrade() -> None:
    # Preserve child transcripts as ordinary sessions when removing lineage.
    op.drop_index("ix_runs_parent_run_id", table_name="runs")
    op.drop_constraint("fk_runs_parent_run_id", "runs", type_="foreignkey")
    op.drop_column("runs", "agent_label")
    op.drop_column("runs", "parent_run_id")
    op.drop_index("ix_agent_sessions_parent_session_id", table_name="agent_sessions")
    op.drop_constraint("fk_agent_sessions_parent_session_id", "agent_sessions", type_="foreignkey")
    op.drop_column("agent_sessions", "parent_session_id")
