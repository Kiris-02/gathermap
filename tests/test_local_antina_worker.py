#!/usr/bin/env python3
"""Unit tests for scripts/local_antina_worker.py."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts import local_antina_worker as worker


class LocalAntinaWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_antina_worker_"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_acquire_and_release_lock(self) -> None:
        lock_path = worker.acquire_lock(self.temp_dir, "GAT-TEST-001")
        self.assertTrue(lock_path.exists())
        data = json.loads(lock_path.read_text(encoding="utf-8"))
        self.assertEqual(data["task_id"], "GAT-TEST-001")
        self.assertEqual(data["pid"], os.getpid())

        # Second acquire in same process raises WorkerError
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.acquire_lock(self.temp_dir, "GAT-TEST-002")
        self.assertIn("Worker lock active", str(ctx.exception))

        worker.release_lock(self.temp_dir)
        self.assertFalse(lock_path.exists())

    def test_checkpoint_lifecycle(self) -> None:
        self.assertIsNone(worker.load_checkpoint(self.temp_dir))

        ckpt_data = {"task_id": "GAT-TEST-001", "stage": "AGENT_RUNNING"}
        worker.save_checkpoint(self.temp_dir, ckpt_data)

        loaded = worker.load_checkpoint(self.temp_dir)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["task_id"], "GAT-TEST-001")
        self.assertEqual(loaded["stage"], "AGENT_RUNNING")
        self.assertIn("updated_at", loaded)

        worker.clear_checkpoint(self.temp_dir)
        self.assertIsNone(worker.load_checkpoint(self.temp_dir))

    def test_parse_task_from_issue_success(self) -> None:
        issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": """## 📋 GRUM_TASK

- **task_id**: `GAT-SMOKE-001`
- **goal**: Export CLIENT_CONFIG with default timeout in src/config/constants.js.

### 🎯 Acceptance Criteria
- [ ] In `src/config/constants.js`, define and export CLIENT_CONFIG.

### ⚠️ Constraints
- Only edit `src/config/constants.js`.
- Do not modify any protected paths.
""",
        }
        task = worker.parse_task_from_issue(issue)
        self.assertEqual(task.issue_number, 19)
        self.assertEqual(task.task_id, "GAT-SMOKE-001")
        self.assertEqual(task.state_label, "state:ready")
        self.assertEqual(task.branch, "agent/gat-smoke-001")
        self.assertEqual(task.allowed_paths, ["src/config/constants.js"])

    def test_parse_task_from_issue_rejects_missing_task_id(self) -> None:
        issue = {
            "number": 20,
            "title": "Invalid task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": "## 📋 GRUM_TASK\nMissing task_id field",
        }
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.parse_task_from_issue(issue)
        self.assertIn("missing structured task_id", str(ctx.exception))

    def test_parse_task_from_issue_rejects_blocking_labels(self) -> None:
        issue = {
            "number": 21,
            "title": "Blocked task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}, {"name": "needs:kiris"}],
            "body": "## 📋 GRUM_TASK\n- **task_id**: `GAT-BLOCKED`\n",
        }
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.parse_task_from_issue(issue)
        self.assertIn("has blocking labels", str(ctx.exception))

    def test_parse_task_from_issue_ignores_unready(self) -> None:
        issue = {
            "number": 22,
            "title": "Unready task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}],
            "body": "## 📋 GRUM_TASK\n- **task_id**: `GAT-WAIT`\n",
        }
        with self.assertRaises(worker.IgnoreTask):
            worker.parse_task_from_issue(issue)

    def test_assert_clean_git_diff_validates_allowed_paths(self) -> None:
        task = worker.Task(
            issue_number=1,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=["src/config/constants.js"],
        )

        with patch.object(worker, "run_cmd") as mock_run:
            mock_run.side_effect = [
                " M src/config/constants.js",  # git status --porcelain
                "",                            # git diff --check
            ]
            changed = worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertEqual(changed, ["src/config/constants.js"])

    def test_assert_clean_git_diff_rejects_protected_prefix(self) -> None:
        task = worker.Task(
            issue_number=1,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=None,
        )

        with patch.object(worker, "run_cmd") as mock_run:
            mock_run.return_value = " M .github/workflows/ci.yml"
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertIn("modified protected file", str(ctx.exception))

    def test_assert_clean_git_diff_rejects_unallowed_path(self) -> None:
        task = worker.Task(
            issue_number=1,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=["src/config/constants.js"],
        )

        with patch.object(worker, "run_cmd") as mock_run:
            mock_run.return_value = " M src/other_file.js"
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertIn("outside allowed paths", str(ctx.exception))

    def test_checks_state_logic(self) -> None:
        required = frozenset({"Antina required validation", "Test Suite & Browser E2E"})

        # Empty rollup -> pending
        self.assertEqual(worker.checks_state([], required), "pending")

        # Incomplete rollup -> pending
        partial = [{"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"}]
        self.assertEqual(worker.checks_state(partial, required), "pending")

        # Full green rollup -> success
        full_green = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "Test Suite & Browser E2E", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        self.assertEqual(worker.checks_state(full_green, required), "success")

        # One failing -> failed
        one_failed = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "FAILURE"},
            {"name": "Test Suite & Browser E2E", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        self.assertEqual(worker.checks_state(one_failed, required), "failed")

        # Stale head Ref OID
        self.assertEqual(
            worker.checks_state(full_green, required, expected_head="abc", pr_head="def"),
            "stale",
        )

    def test_monitor_agent_execution_completion(self) -> None:
        conv_id = "test-conv-123"
        fake_log_dir = self.temp_dir / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs"
        fake_log_dir.mkdir(parents=True, exist_ok=True)
        transcript = fake_log_dir / "transcript.jsonl"

        steps = [
            {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "content": "Start"},
            {"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{"name": "view_file"}]},
            {"step_index": 2, "source": "MODEL", "type": "GENERIC", "status": "DONE", "content": "File viewed"},
            {"step_index": 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": "Task completed successfully", "tool_calls": []},
        ]
        transcript.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")

        with patch.object(worker, "get_conversation_transcript_path", return_value=transcript):
            result = worker.monitor_agent_execution(conv_id, timeout_seconds=5)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["total_steps"], 4)
            self.assertIn("view_file", result["tools_executed"])
            self.assertEqual(result["summary"], "Task completed successfully")


if __name__ == "__main__":
    unittest.main()
