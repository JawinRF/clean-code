"""persist tool approvals and interrupted runs

Revision ID: 1800be07591d
Revises: 60cab443f97a
Create Date: 2026-09-06 03:17:21.399530

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '1800be07591d'
down_revision: Union[str, Sequence[str], None] = '60cab443f97a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint('ck_runs_status', 'runs', type_='check')
    op.create_check_constraint(
        'ck_runs_status', 'runs',
        "status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')",
    )
    op.create_table('tool_approvals',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('run_id', sa.Uuid(), nullable=False),
    sa.Column('call_id', sa.String(length=200), nullable=False),
    sa.Column('tool_name', sa.String(length=120), nullable=False),
    sa.Column('reason', sa.Text(), nullable=False),
    sa.Column('arguments', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=32), server_default=sa.text("'pending'"), nullable=False),
    sa.Column('requested_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("(status = 'pending' AND resolved_at IS NULL) OR (status <> 'pending' AND resolved_at IS NOT NULL)", name='ck_tool_approvals_resolution'),
    sa.CheckConstraint("status IN ('pending', 'approved', 'rejected', 'cancelled', 'interrupted')", name='ck_tool_approvals_status'),
    sa.ForeignKeyConstraint(['run_id'], ['runs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('run_id', 'call_id', name='uq_tool_approvals_run_call')
    )
    op.create_index('ix_tool_approvals_run_status', 'tool_approvals', ['run_id', 'status'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_tool_approvals_run_status', table_name='tool_approvals')
    op.drop_table('tool_approvals')
    op.execute("UPDATE runs SET status = 'failed' WHERE status = 'interrupted'")
    op.drop_constraint('ck_runs_status', 'runs', type_='check')
    op.create_check_constraint(
        'ck_runs_status', 'runs',
        "status IN ('queued', 'running', 'completed', 'failed', 'cancelled')",
    )
