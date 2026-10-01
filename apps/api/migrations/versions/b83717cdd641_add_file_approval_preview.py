"""Persist the exact file diff shown before approval.

Revision ID: b83717cdd641
Revises: 72d104a98bce
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "b83717cdd641"
down_revision = "72d104a98bce"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tool_approvals", sa.Column("file_preview", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("tool_approvals", "file_preview")
