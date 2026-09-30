import json
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

from sqlalchemy import delete

from app.database import DATABASE_URL, SessionFactory
from app.models import AgentRun, AgentSession, Project, Workspace
from app.schemas.tool_approval import ToolApprovalResponse
from app.services.run_execution import start_agent_run
from app.services.text_run import _request_tool_approval
from app.services.tool_approval import ToolApprovalCoordinator

from app.services.tool_execution import execute_tool_call
from app.tools import create_default_tool_registry


class FileApprovalDiffTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix="approval-diff-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.registry = create_default_tool_registry(workspace_root=self.root)
        self.previews = []

    async def approve(self, name, arguments, preview):
        self.previews.append(preview)
        return True

    async def call(self, name, handler=None, **arguments):
        return await execute_tool_call(
            registry=self.registry, name=name, arguments_json=json.dumps(arguments),
            approval_handler=handler or self.approve,
        )

    async def test_creation_preview_before_write(self):
        async def approve(name, arguments, preview):
            self.assertFalse((self.root / "new.txt").exists())
            self.assertEqual(preview["path"], "new.txt")
            self.assertIn("--- /dev/null", preview["unified_diff"])
            self.assertIn("+hello", preview["unified_diff"])
            self.assertEqual(preview["additions"], 2)
            self.assertIn("\\ No newline at end of file", preview["unified_diff"])
            return True
        result = await self.call("write_file", approve, path="new.txt", content="hello\nworld")
        self.assertFalse(result.is_error)
        self.assertEqual((self.root / "new.txt").read_bytes(), b"hello\nworld")

    async def test_replacement_preview_uses_actual_file_context(self):
        path = self.root / "edit.txt"
        path.write_bytes(b"before\nold\nafter\n")
        async def approve(name, arguments, preview):
            self.assertEqual(path.read_bytes(), b"before\nold\nafter\n")
            self.assertIn(" before\n-old\n+new\n after", preview["unified_diff"])
            return True
        result = await self.call("edit_file", approve, path="edit.txt", old_content="old", new_content="new")
        self.assertFalse(result.is_error)
        self.assertEqual(path.read_bytes(), b"before\nnew\nafter\n")

    async def test_replace_all_and_deletion(self):
        path = self.root / "edit.txt"
        path.write_bytes(b"drop\nkeep\ndrop\n")
        result = await self.call("edit_file", path="edit.txt", old_content="drop\n", new_content="", replace_all=True)
        self.assertFalse(result.is_error)
        self.assertEqual(self.previews[0]["deletions"], 2)
        self.assertEqual(path.read_bytes(), b"keep\n")

    async def test_rejection_does_not_mutate(self):
        async def reject(*args): return False
        result = await self.call("write_file", reject, path="no.txt", content="no")
        self.assertTrue(result.is_error)
        self.assertFalse((self.root / "no.txt").exists())
        path = self.root / "old.txt"
        path.write_bytes(b"old")
        result = await self.call("edit_file", reject, path="old.txt", old_content="old", new_content="new")
        self.assertTrue(result.is_error)
        self.assertEqual(path.read_bytes(), b"old")

    async def test_stale_preview_refuses_edit_including_line_ending_changes(self):
        for initial, changed in [(b"old", b"old external"), (b"old\r\n", b"old\n")]:
            with self.subTest(initial=initial):
                path = self.root / "old.txt"
                path.write_bytes(initial)
                async def approve(*args):
                    path.write_bytes(changed)
                    return True
                result = await self.call("edit_file", approve, path="old.txt", old_content="old", new_content="new")
                self.assertTrue(result.is_error)
                self.assertIn("since the approval preview", result.content)
                self.assertEqual(path.read_bytes(), changed)

    async def test_creation_never_overwrites_file_created_during_approval(self):
        path = self.root / "new.txt"
        async def approve(*args):
            path.write_bytes(b"external")
            return True
        result = await self.call("write_file", approve, path="new.txt", content="proposed")
        self.assertTrue(result.is_error)
        self.assertEqual(path.read_bytes(), b"external")

    async def test_crlf_preview_matches_written_bytes(self):
        path = self.root / "edit.txt"
        path.write_bytes(b"old\r\nkeep\r\n")
        result = await self.call("edit_file", path="edit.txt", old_content="old", new_content="new")
        self.assertFalse(result.is_error)
        self.assertEqual(self.previews[0]["before_line_endings"], "CRLF")
        self.assertEqual(self.previews[0]["after_line_endings"], "LF")
        self.assertEqual(path.read_bytes(), b"new\nkeep\n")

    async def test_invalid_changes_never_request_approval(self):
        (self.root / "old.txt").write_bytes(b"old old")
        cases = [
            ("write_file", {"path": "../outside.txt", "content": "x"}),
            ("write_file", {"path": "old.txt", "content": "x"}),
            ("edit_file", {"path": "missing.txt", "old_content": "old", "new_content": "new"}),
            ("edit_file", {"path": "old.txt", "old_content": "missing", "new_content": "new"}),
            ("edit_file", {"path": "old.txt", "old_content": "old", "new_content": "new"}),
            ("edit_file", {"path": "old.txt", "old_content": "old", "new_content": "old"}),
            ("write_file", {"path": "large.txt", "content": "x" * 1_000_001}),
        ]
        for name, arguments in cases:
            with self.subTest(name=name, arguments=list(arguments)):
                self.assertTrue((await self.call(name, **arguments)).is_error)
        self.assertEqual(self.previews, [])

    async def test_empty_file_creation_and_full_deletion(self):
        result = await self.call("write_file", path="empty.txt", content="")
        self.assertFalse(result.is_error)
        self.assertIn("(empty file)", self.previews[-1]["unified_diff"])
        (self.root / "delete.txt").write_bytes(b"delete")
        result = await self.call("edit_file", path="delete.txt", old_content="delete", new_content="")
        self.assertFalse(result.is_error)
        self.assertEqual((self.root / "delete.txt").read_bytes(), b"")
        self.assertEqual(self.previews[-1]["deletions"], 1)

    async def test_binary_file_is_not_approvable(self):
        (self.root / "binary.txt").write_bytes(b"\xff")
        result = await self.call("edit_file", path="binary.txt", old_content="x", new_content="y")
        self.assertTrue(result.is_error)
        self.assertEqual(self.previews, [])

    async def test_non_file_approval_has_no_diff(self):
        async def reject(name, arguments, preview):
            self.assertIsNone(preview)
            return False
        result = await self.call("shell", reject, command="echo not executed")
        self.assertTrue(result.is_error)


class PersistedFileApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def test_preview_round_trip_approval_rejection_and_stale_snapshot(self):
        if DATABASE_URL.database != "clean_code_orchestration_test" or DATABASE_URL.host not in {"127.0.0.1", "localhost"}:
            self.skipTest("Requires an explicitly configured disposable local test database.")
        with TemporaryDirectory(prefix="persisted-file-diff-") as directory:
            root = Path(directory)
            registry = create_default_tool_registry(workspace_root=root)
            coordinator = ToolApprovalCoordinator(session_factory=SessionFactory)
            with SessionFactory() as db:
                project = Project(name=f"preview-{uuid4()}")
                db.add(project)
                db.flush()
                project_id = project.id
                workspace = Workspace(project_id=project_id, name="preview", root_path=directory)
                db.add(workspace)
                db.flush()
                session = AgentSession(workspace_id=workspace.id, title="preview")
                db.add(session)
                db.flush()
                run = AgentRun(session_id=session.id, model_provider="anthropic", model_name="claude-haiku-4-5-20251001")
                db.add(run)
                db.flush()
                run_id = run.id
                start_agent_run(db, run_id=run_id)
                db.commit()
            try:
                cases = [
                    ("write_file", {"path": "new.txt", "content": "old\n"}, "approved", False),
                    ("edit_file", {"path": "new.txt", "old_content": "old", "new_content": "new"}, "approved", False),
                    ("write_file", {"path": "rejected.txt", "content": "no"}, "rejected", False),
                    ("edit_file", {"path": "new.txt", "old_content": "new", "new_content": "changed"}, "approved", True),
                ]
                for index, (name, arguments, decision, stale) in enumerate(cases):
                    with self.subTest(name=name, decision=decision, stale=stale), SessionFactory() as request_db:
                        async def request_approval(tool_name, validated, preview):
                            return await _request_tool_approval(
                                request_db, approval_coordinator=coordinator, run_id=run_id,
                                call_id=f"call-{index}", tool_name=tool_name,
                                arguments=validated, file_preview=preview,
                            )
                        task = asyncio.create_task(execute_tool_call(
                            registry=registry, name=name, arguments_json=json.dumps(arguments),
                            approval_handler=request_approval,
                        ))
                        try:
                            async with asyncio.timeout(5):
                                while True:
                                    with SessionFactory() as db:
                                        pending = coordinator.pending_for_run(db, run_id)
                                        if pending:
                                            approval = pending[0]
                                            response = ToolApprovalResponse.model_validate(approval)
                                            break
                                    await asyncio.sleep(.01)
                            self.assertIsNotNone(response.file_preview)
                            self.assertIn("+++ b/", response.file_preview.unified_diff)
                            self.assertFalse(task.done())
                            if stale:
                                (root / "new.txt").write_bytes(b"external\n")
                            with SessionFactory() as db:
                                coordinator.decide(db, run_id=run_id, approval_id=approval.id, decision=decision)
                                db.commit()
                            coordinator.notify_decision(approval.id)
                            result = await asyncio.wait_for(task, 5)
                            self.assertEqual(result.is_error, decision == "rejected" or stale)
                            with SessionFactory() as db:
                                saved = coordinator.pending_for_run(db, run_id, include_resolved=True)
                                resolved = next(item for item in saved if item.id == approval.id)
                                self.assertEqual(resolved.file_preview, response.file_preview.model_dump())
                        finally:
                            if not task.done():
                                task.cancel()
                                await asyncio.gather(task, return_exceptions=True)
                self.assertFalse((root / "rejected.txt").exists())
                self.assertEqual((root / "new.txt").read_bytes(), b"external\n")
            finally:
                with SessionFactory() as db:
                    db.execute(delete(Project).where(Project.id == project_id))
                    db.commit()
