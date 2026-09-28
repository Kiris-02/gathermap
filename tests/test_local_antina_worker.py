#!/usr/bin/env python3
"""Unit tests and regression tests for scripts/local_antina_worker.py."""

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

    def test_acquire_and_release_lock_atomic(self) -> None:
        lock_path = worker.acquire_lock(self.temp_dir, "GAT-TEST-001")
        self.assertTrue(lock_path.exists())
        data = json.loads(lock_path.read_text(encoding="utf-8"))
        self.assertEqual(data["task_id"], "GAT-TEST-001")
        self.assertEqual(data["pid"], os.getpid())

        # Second acquire in same process (which is running) raises WorkerError
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.acquire_lock(self.temp_dir, "GAT-TEST-002")
        self.assertIn("Worker lock active by live PID", str(ctx.exception))

        worker.release_lock(self.temp_dir)
        self.assertFalse(lock_path.exists())

    def test_acquire_lock_reclaims_dead_pid(self) -> None:
        lock_path = self.temp_dir / worker.LOCK_FILE
        # Write lock with an impossible/dead PID
        lock_path.write_text(json.dumps({"pid": 99999999, "task_id": "GAT-DEAD"}), encoding="utf-8")

        with patch.object(worker, "is_process_running", return_value=False):
            acquired = worker.acquire_lock(self.temp_dir, "GAT-RECLAIM")
            self.assertTrue(acquired.exists())
            data = json.loads(acquired.read_text(encoding="utf-8"))
            self.assertEqual(data["task_id"], "GAT-RECLAIM")
            self.assertEqual(data["pid"], os.getpid())

    def test_cmd_unlock_rejects_live_worker(self) -> None:
        lock_path = self.temp_dir / worker.LOCK_FILE
        lock_path.write_text(json.dumps({"pid": os.getpid(), "task_id": "GAT-LIVE"}), encoding="utf-8")

        with patch.object(worker, "is_process_running", return_value=True):
            # Unconditional unlock without force must fail on active worker
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.cmd_unlock(self.temp_dir, force=False)
            self.assertIn("Refusing to unlock a live worker", str(ctx.exception))

            # Forced unlock succeeds
            worker.cmd_unlock(self.temp_dir, force=True)
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
        self.assertFalse(task.is_revision)

    def test_parse_task_rejects_missing_allowed_paths(self) -> None:
        issue = {
            "number": 20,
            "title": "Unbounded task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-UNBOUNDED`
- **goal**: Do anything anywhere.
""",
        }
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.parse_task_from_issue(issue)
        self.assertIn("missing explicit allowed_paths whitelist", str(ctx.exception))

    def test_parse_task_rejects_wildcard_allowed_paths(self) -> None:
        issue = {
            "number": 21,
            "title": "Wildcard task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-WILDCARD`
### 📁 Files of Interest
- `src/**/*.js`
""",
        }
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.parse_task_from_issue(issue)
        self.assertIn("wildcards rejected", str(ctx.exception))

    def test_parse_task_handles_revision_and_enforces_limit(self) -> None:
        issue = {
            "number": 22,
            "title": "Revision task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:revision"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-REV`
- **revision_pr**: `22`
- **revision_head**: `8712aa66`
- **revision_branch**: `agent/gat-smoke-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }
        with patch.object(worker, "gh_json") as mock_gh:
            # PR has 2 commits (initial + 1 revision) -> within limit
            mock_gh.return_value = {
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
                "commits": [{"oid": "c1"}, {"oid": "c2"}],
            }
            task = worker.parse_task_from_issue(issue)
            self.assertTrue(task.is_revision)
            self.assertEqual(task.revision_pr, 22)
            self.assertEqual(task.branch, "agent/gat-smoke-001")

            # Exceeding revision limit (more than 4 rounds)
            mock_gh.return_value = {
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
                "commits": [{"oid": f"c{i}"} for i in range(7)],
            }
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.parse_task_from_issue(issue)
            self.assertIn("exceeded maximum revision limit", str(ctx.exception))

    def test_assert_clean_git_diff_validates_allowed_paths_and_whitespace(self) -> None:
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
                "",                            # git diff (conflict check)
                "",                            # git diff --check (whitespace check)
            ]
            changed = worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertEqual(changed, ["src/config/constants.js"])

    def test_assert_clean_git_diff_rejects_git_diff_check_failure(self) -> None:
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
                "",                            # git diff
                worker.WorkerError("Command failed (git diff --check...): trailing whitespace"),
            ]
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertIn("trailing whitespace", str(ctx.exception))

    def test_assert_clean_git_diff_rejects_renames_outside_allowed(self) -> None:
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
            # Rename from protected path or to unallowed path
            mock_run.return_value = "R  scripts/agent_cycle.py -> src/config/constants.js"
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertIn("modified protected file", str(ctx.exception))

    def test_assert_clean_git_diff_rejects_conflict_markers(self) -> None:
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
                " M src/config/constants.js",
                "diff --git a/file b/file\n+<<<<<<< HEAD\n+conflict\n+=======",
            ]
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.assert_clean_git_diff(self.temp_dir, task)
            self.assertIn("merge conflict marker", str(ctx.exception))

    def test_run_local_tests_preserves_new_test_files(self) -> None:
        task = worker.Task(
            issue_number=1,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=["tests/new_feature.test.js"],
        )
        tests_dir = self.temp_dir / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)

        new_test = tests_dir / "new_feature.test.js"
        new_test.write_text("// genuine new test", encoding="utf-8")

        temp_db = tests_dir / "e2e-playwright-temp.db"
        temp_db.write_text("temp db", encoding="utf-8")

        with patch.object(worker, "run_cmd", return_value="PASS"):
            worker.run_local_tests(self.temp_dir, task)

        # Temp DB artifact must be deleted
        self.assertFalse(temp_db.exists())
        # Newly authored test must NOT be deleted
        self.assertTrue(new_test.exists())

    def test_verify_repo_remote_validation(self) -> None:
        with patch.object(worker, "run_cmd", return_value="https://github.com/Kiris-02/gathermap.git"):
            worker.verify_repo_remote(self.temp_dir)

        with patch.object(worker, "run_cmd", return_value="https://github.com/attacker/malicious.git"):
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.verify_repo_remote(self.temp_dir)
            self.assertIn("Invalid git remote origin", str(ctx.exception))

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


if __name__ == "__main__":
    unittest.main()
