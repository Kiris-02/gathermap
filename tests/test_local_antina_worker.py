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
            # PR has 1 review round (within limit)
            mock_gh.return_value = {
                "state": "OPEN",
                "baseRefName": "main",
                "headRefName": "agent/gat-smoke-001",
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
                "comments": [{"body": "## 🔍 GRUM_REVIEW: REVISION_REQUIRED\nFix timeout constant."}],
            }
            task = worker.parse_task_from_issue(issue)
            self.assertTrue(task.is_revision)
            self.assertEqual(task.revision_pr, 22)
            self.assertEqual(task.branch, "agent/gat-smoke-001")
            self.assertEqual(task.review_findings, "## 🔍 GRUM_REVIEW: REVISION_REQUIRED\nFix timeout constant.")

            # Exceeding revision limit (more than 4 GRUM_REVIEW rounds)
            mock_gh.return_value = {
                "state": "OPEN",
                "baseRefName": "main",
                "headRefName": "agent/gat-smoke-001",
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
                "comments": [{"body": f"## 🔍 GRUM_REVIEW round {i}"} for i in range(5)],
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

    def test_interruption_recovery_resumes_waiting_ci(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=["src/config/constants.js"],
        )
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-TEST",
            "stage": "WAITING_CI",
            "pr_number": 22,
            "head_sha": "8712aa66",
        })

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "acquire_lock"), \
             patch.object(worker, "release_lock"), \
             patch.object(worker, "wait_for_pr_checks", return_value=[{"name": "CI", "conclusion": "SUCCESS"}]) as mock_wait, \
             patch.object(worker, "publish_handoff", return_value={"status": "success", "task_id": "GAT-TEST"}) as mock_handoff:
            res = worker.execute_task(self.temp_dir, task)
            self.assertEqual(res["status"], "success")
            mock_wait.assert_called_once_with(22, "8712aa66")
            mock_handoff.assert_called_once()

    def test_local_only_mode_skips_push_and_handoff(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=["src/config/constants.js"],
        )
        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "acquire_lock"), \
             patch.object(worker, "release_lock"), \
             patch.object(worker, "create_isolated_worktree", return_value=self.temp_dir), \
             patch.object(worker, "start_agent_conversation", return_value="conv-123"), \
             patch.object(worker, "monitor_agent_execution", return_value={"total_steps": 1, "summary": "Done"}), \
             patch.object(worker, "assert_clean_git_diff", return_value=["src/config/constants.js"]), \
             patch.object(worker, "run_local_tests", return_value="PASS"), \
             patch.object(worker, "remove_isolated_worktree"), \
             patch.object(worker, "run_cmd") as mock_run:
            mock_run.side_effect = lambda *args, **kwargs: "8712aa66" if "rev-parse" in args else ""
            res = worker.execute_task(self.temp_dir, task, local_only=True)
            self.assertEqual(res["status"], "local_only_success")
            # Verify git push and gh commands were NEVER called
            for call in mock_run.call_args_list:
                args = call[0]
                self.assertNotIn("push", args)
                self.assertNotIn("create", args)
                if args and args[0] == "gh":
                    self.fail(f"gh command was called in local_only mode: {args}")

    def test_validate_github_remote_url_strictness(self) -> None:
        # Valid URLs
        valid_urls = [
            "https://github.com/Kiris-02/gathermap.git",
            "https://github.com/Kiris-02/gathermap",
            "https://x-access-token:ghp_12345@github.com/Kiris-02/gathermap.git",
            "git@github.com:Kiris-02/gathermap.git",
            "git@github.com:Kiris-02/gathermap",
            "ssh://git@github.com/Kiris-02/gathermap.git",
            "ssh://git@github.com:22/Kiris-02/gathermap.git",
        ]
        for url in valid_urls:
            self.assertTrue(worker.validate_github_remote_url(url), f"Expected valid: {url}")

        # Invalid or malicious lookalike URLs
        invalid_urls = [
            "https://attacker.com/Kiris-02/gathermap.git",
            "https://evil.github.com/Kiris-02/gathermap.git",
            "https://github.com.attacker.com/Kiris-02/gathermap.git",
            "https://github.com/evil-org/gathermap.git",
            "https://github.com/Kiris-02/other-project.git",
            "git@evil.com:Kiris-02/gathermap.git",
            "git@github.com:attacker/gathermap.git",
            "ssh://evil.com/Kiris-02/gathermap.git",
            "ssh://git@github.com/attacker/gathermap.git",
            "http://github.com/Kiris-02/gathermap.git",
        ]
        for url in invalid_urls:
            self.assertFalse(worker.validate_github_remote_url(url), f"Expected invalid: {url}")

    def test_verify_repo_remote_validates_both_fetch_and_push(self) -> None:
        # Both fetch and push valid
        with patch.object(worker, "run_cmd", side_effect=["https://github.com/Kiris-02/gathermap.git", "git@github.com:Kiris-02/gathermap.git"]):
            worker.verify_repo_remote(self.temp_dir)

        # Push remote pointing to malicious host
        with patch.object(worker, "run_cmd", side_effect=["https://github.com/Kiris-02/gathermap.git", "https://attacker.com/Kiris-02/gathermap.git"]):
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.verify_repo_remote(self.temp_dir)
            self.assertIn("Invalid git remote origin", str(ctx.exception))

    def test_parse_task_rejects_protected_revision_branches(self) -> None:
        base_issue = {
            "number": 22,
            "title": "Revision task",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:revision"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-REV`
- **revision_pr**: `22`
- **revision_head**: `8712aa66`
- **revision_branch**: `{branch}`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        # Reject revision_branch = main
        issue_main = dict(base_issue)
        issue_main["body"] = base_issue["body"].format(branch="main")
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.parse_task_from_issue(issue_main)
        self.assertIn("Protected branch 'main'", str(ctx.exception))

        # Reject revision_branch = master
        issue_master = dict(base_issue)
        issue_master["body"] = base_issue["body"].format(branch="master")
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.parse_task_from_issue(issue_master)
        self.assertIn("Protected branch 'master'", str(ctx.exception))

        # Reject when PR headRefName is main
        issue_ok = dict(base_issue)
        issue_ok["body"] = base_issue["body"].format(branch="agent/gat-smoke-001")
        with patch.object(worker, "gh_json") as mock_gh:
            mock_gh.return_value = {
                "state": "OPEN",
                "baseRefName": "main",
                "headRefName": "main",
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
            }
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.parse_task_from_issue(issue_ok)
            self.assertIn("is protected", str(ctx.exception))

        # Reject when PR baseRefName is not main
        with patch.object(worker, "gh_json") as mock_gh:
            mock_gh.return_value = {
                "state": "OPEN",
                "baseRefName": "feature-branch",
                "headRefName": "agent/gat-smoke-001",
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
            }
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.parse_task_from_issue(issue_ok)
            self.assertIn("must be 'main'", str(ctx.exception))

        # Reject when PR state is CLOSED
        with patch.object(worker, "gh_json") as mock_gh:
            mock_gh.return_value = {
                "state": "CLOSED",
                "baseRefName": "main",
                "headRefName": "agent/gat-smoke-001",
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
            }
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.parse_task_from_issue(issue_ok)
            self.assertIn("is not OPEN", str(ctx.exception))

        # Reject when PR head branch does not match revision_branch
        with patch.object(worker, "gh_json") as mock_gh:
            mock_gh.return_value = {
                "state": "OPEN",
                "baseRefName": "main",
                "headRefName": "agent/different-branch",
                "headRefOid": "8712aa66d5ba6adac24cf14c01c4ee9312e1383f",
            }
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.parse_task_from_issue(issue_ok)
            self.assertIn("does not match specified revision_branch", str(ctx.exception))

    def test_create_isolated_worktree_revalidates_pinned_head(self) -> None:
        task = worker.Task(
            issue_number=22,
            task_id="GAT-REV",
            title="Revision task",
            body="",
            state_label="state:revision",
            branch="agent/gat-smoke-001",
            allowed_paths=["src/config/constants.js"],
            is_revision=True,
            revision_pr=22,
            revision_head="8712aa66",
        )
        with patch.object(worker, "run_cmd") as mock_run:
            # rev-parse returns a diverged commit
            mock_run.side_effect = lambda *args, **kwargs: "99999999abcdef" if "rev-parse" in args else ""
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.create_isolated_worktree(self.temp_dir, task)
            self.assertIn("does not match pinned revision_head", str(ctx.exception))

    def test_execute_task_preserves_worktree_and_lock_on_timeout(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-TIMEOUT",
            title="Timeout Task",
            body="",
            state_label="state:ready",
            branch="agent/gat-timeout",
            allowed_paths=["src/config/constants.js"],
        )
        mock_worktree = self.temp_dir / ".worktrees" / "agent-gat-timeout"
        mock_worktree.mkdir(parents=True, exist_ok=True)

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "create_isolated_worktree", return_value=mock_worktree), \
             patch.object(worker, "start_agent_conversation", return_value="conv-timeout"), \
             patch.object(worker, "monitor_agent_execution", side_effect=worker.WorkerError("Agent execution timed out after 600 seconds")), \
             patch.object(worker, "remove_isolated_worktree") as mock_remove_wt, \
             patch.object(worker, "release_lock") as mock_release_lock, \
             patch.object(worker, "run_cmd"):
            with self.assertRaises(worker.WorkerError):
                worker.execute_task(self.temp_dir, task)

            # Assert worktree removal was NOT called
            mock_remove_wt.assert_not_called()
            # Assert lock release was NOT called
            mock_release_lock.assert_not_called()

            # Assert checkpoint stage is AGENT_TIMED_OUT and records conversation ID
            ckpt = worker.load_checkpoint(self.temp_dir)
            self.assertIsNotNone(ckpt)
            self.assertEqual(ckpt["stage"], "AGENT_TIMED_OUT")
            self.assertEqual(ckpt["conversation_id"], "conv-timeout")

            # Assert another task cannot steal/reclaim lock while interrupted task is preserved
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.acquire_lock(self.temp_dir, "GAT-OTHER")
            self.assertIn("Cannot acquire lock: an interrupted task", str(ctx.exception))

    def test_local_only_mode_zero_remote_mutations_on_failure_path(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-FAIL",
            title="Fail Task",
            body="",
            state_label="state:ready",
            branch="agent/gat-fail",
            allowed_paths=["src/config/constants.js"],
        )
        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "acquire_lock"), \
             patch.object(worker, "create_isolated_worktree", side_effect=worker.WorkerError("Worktree setup failed")), \
             patch.object(worker, "run_cmd") as mock_run:
            with self.assertRaises(worker.WorkerError):
                worker.execute_task(self.temp_dir, task, local_only=True)

            # Assert NO gh commands were executed
            for call in mock_run.call_args_list:
                args = call[0]
                if args and args[0] == "gh":
                    self.fail(f"gh command was called in local_only error handler: {args}")

    def test_recovery_admits_state_working_for_owned_checkpoint_only(self) -> None:
        issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }
        # Without matching checkpoint: ignored
        with self.assertRaises(worker.IgnoreTask):
            worker.parse_task_from_issue(issue, matching_checkpoint_issue=None)

        with self.assertRaises(worker.IgnoreTask):
            worker.parse_task_from_issue(issue, matching_checkpoint_issue=999)

        # With matching checkpoint issue: admitted!
        task = worker.parse_task_from_issue(issue, matching_checkpoint_issue=19)
        self.assertEqual(task.issue_number, 19)
        self.assertEqual(task.state_label, "state:working")

    def test_cmd_unlock_preserves_checkpoint_by_default(self) -> None:
        # Setup lock and checkpoint
        lock_path = self.temp_dir / worker.LOCK_FILE
        lock_path.write_text(json.dumps({"pid": 99999999, "task_id": "GAT-PRESERVED"}), encoding="utf-8")
        worker.save_checkpoint(self.temp_dir, {"task_id": "GAT-PRESERVED", "stage": "INTERRUPTED"})

        with patch.object(worker, "is_process_running", return_value=False):
            # Normal unlock clears lock but preserves checkpoint
            worker.cmd_unlock(self.temp_dir, force=False, clear_ckpt=False)
            self.assertFalse(lock_path.exists())
            self.assertIsNotNone(worker.load_checkpoint(self.temp_dir))

            # Unlock with clear_ckpt clears checkpoint
            worker.cmd_unlock(self.temp_dir, force=False, clear_ckpt=True)
            self.assertIsNone(worker.load_checkpoint(self.temp_dir))

    def test_publish_handoff_idempotency_prevents_duplicate_comments(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-TEST",
            title="Test",
            body="",
            state_label="state:ready",
            branch="agent/gat-test",
            allowed_paths=["src/config/constants.js"],
        )
        head_sha = "8712aa66d5ba6adac24cf14c01c4ee9312e1383f"
        # Mock PR and Issue already having the report and handoff comments
        mock_pr_info = {
            "number": 22,
            "url": "https://github.com/Kiris-02/gathermap/pull/22",
            "labels": [{"name": "to:grum"}, {"name": "state:review"}],
            "comments": [
                {"body": f"## 📤 ANTINA_REPORT\n- **commit**: `{head_sha}`"},
                {"body": f"## 🤝 ANTINA_HANDOFF\n- **commit**: `{head_sha}`"},
            ],
        }
        mock_issue_info = {
            "number": 19,
            "labels": [{"name": "to:grum"}, {"name": "state:review"}],
            "comments": [
                {"body": f"## 🤝 ANTINA_HANDOFF\n- **commit**: `{head_sha}`"},
            ],
        }

        with patch.object(worker, "gh_json", side_effect=[mock_pr_info, mock_issue_info]), \
             patch.object(worker, "run_cmd") as mock_run:
            res = worker.publish_handoff(
                self.temp_dir,
                task,
                pr_number=22,
                head_sha=head_sha,
                checks_rollup=[{"name": "CI", "conclusion": "SUCCESS"}],
            )
            self.assertEqual(res["status"], "success")

            # Assert no comments were added to PR or Issue
            for call in mock_run.call_args_list:
                args = call[0]
                if args and args[0] == "gh" and len(args) >= 3 and args[2] == "comment":
                    self.fail(f"Duplicate comment posted: {args}")

    def test_create_isolated_worktree_never_removes_or_overwrites_with_preserved_checkpoint(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-PRESERVE-WT",
            title="Preserve Worktree Task",
            body="",
            state_label="state:ready",
            branch="agent/gat-preserve-wt",
            allowed_paths=["src/config/constants.js"],
        )
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-preserve-wt"
        wt_dir.mkdir(parents=True)
        canary_file = wt_dir / "canary.txt"
        canary_file.write_text("precious agent progress", encoding="utf-8")

        for stage in ("AGENT_TIMED_OUT", "INTERRUPTED"):
            worker.save_checkpoint(self.temp_dir, {
                "task_id": "GAT-PRESERVE-WT",
                "issue": 19,
                "stage": stage,
                "worktree": str(wt_dir),
            })
            with patch.object(worker, "remove_isolated_worktree") as mock_remove:
                returned_dir = worker.create_isolated_worktree(self.temp_dir, task)
                self.assertEqual(returned_dir, wt_dir)
                self.assertTrue(canary_file.exists())
                self.assertEqual(canary_file.read_text(encoding="utf-8"), "precious agent progress")
                mock_remove.assert_not_called()

    def test_create_isolated_worktree_fails_closed_without_authorized_checkpoint(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-UNAUTHORIZED",
            title="Unauthorized Task",
            body="",
            state_label="state:ready",
            branch="agent/gat-unauthorized",
            allowed_paths=["src/config/constants.js"],
        )
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-unauthorized"
        wt_dir.mkdir(parents=True)
        canary = wt_dir / "important.txt"
        canary.write_text("do not delete me", encoding="utf-8")

        # Case A: No checkpoint at all
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.create_isolated_worktree(self.temp_dir, task)
        self.assertIn("Refusing to overwrite existing worktree", str(ctx.exception))
        self.assertTrue(canary.exists())

        # Case B: Checkpoint for different task
        worker.save_checkpoint(self.temp_dir, {"task_id": "GAT-OTHER", "stage": "INTERRUPTED"})
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.create_isolated_worktree(self.temp_dir, task)
        self.assertIn("Refusing to overwrite existing worktree", str(ctx.exception))
        self.assertTrue(canary.exists())

    def test_recovery_fails_closed_when_prior_agent_is_still_active(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-ACTIVE-AGENT",
            title="Active Agent Task",
            body="",
            state_label="state:ready",
            branch="agent/gat-active-agent",
            allowed_paths=["src/config/constants.js"],
        )
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-active-agent"
        wt_dir.mkdir(parents=True)
        canary = wt_dir / "unfinished.txt"
        canary.write_text("unfinished work", encoding="utf-8")

        ckpt_initial = {
            "task_id": "GAT-ACTIVE-AGENT",
            "issue": 19,
            "stage": "AGENT_TIMED_OUT",
            "conversation_id": "conv-still-running",
            "worktree": str(wt_dir),
            "error": "Agent execution timed out after 600 seconds",
        }
        worker.save_checkpoint(self.temp_dir, ckpt_initial)

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=True), \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.execute_task(self.temp_dir, task, local_only=True)
            self.assertIn("conv-still-running", str(ctx.exception))
            self.assertIn("still actively running", str(ctx.exception))
            # Worktree and files must be preserved intact
            mock_remove.assert_not_called()
            self.assertTrue(canary.exists())
            # Checkpoint on disk must NOT be mutated or overwritten
            loaded_ckpt = worker.load_checkpoint(self.temp_dir)
            self.assertEqual(loaded_ckpt["stage"], "AGENT_TIMED_OUT")
            self.assertEqual(loaded_ckpt["conversation_id"], "conv-still-running")

    def test_recovery_fails_closed_when_worktree_has_no_modifications_or_commit(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-EMPTY-WT",
            title="Empty Worktree Task",
            body="",
            state_label="state:ready",
            branch="agent/gat-empty-wt",
            allowed_paths=["src/config/constants.js"],
        )
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-empty-wt"
        wt_dir.mkdir(parents=True)

        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-EMPTY-WT",
            "issue": 19,
            "stage": "INTERRUPTED",
            "conversation_id": "conv-idle",
            "worktree": str(wt_dir),
        })

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "run_cmd", side_effect=lambda *args, **kwargs: "" if "--porcelain" in args else "sha123"), \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.execute_task(self.temp_dir, task, local_only=True)
            self.assertIn("has no unfinished modifications or commits to resume", str(ctx.exception))
            mock_remove.assert_not_called()
            self.assertTrue(wt_dir.exists())

    def test_cmd_poll_recovery_fails_closed_when_agent_active_and_preserves_worktree(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        constants_file = wt_dir / "src" / "config" / "constants.js"
        constants_file.parent.mkdir(parents=True, exist_ok=True)
        constants_file.write_text("export const CLIENT_CONFIG = { timeout: 30000 };\n", encoding="utf-8")

        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_TIMED_OUT",
            "conversation_id": "conv-still-running",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=True), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            success = worker.cmd_poll(self.temp_dir, local_only=True)
            self.assertFalse(success)
            mock_remove.assert_not_called()
            self.assertTrue(constants_file.exists())
            self.assertEqual(constants_file.read_text(encoding="utf-8"), "export const CLIENT_CONFIG = { timeout: 30000 };\n")
            ckpt = worker.load_checkpoint(self.temp_dir)
            self.assertEqual(ckpt["stage"], "AGENT_TIMED_OUT")

    def test_cmd_run_task_recovery_fails_closed_when_agent_active_and_preserves_worktree(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        constants_file = wt_dir / "src" / "config" / "constants.js"
        constants_file.parent.mkdir(parents=True, exist_ok=True)
        constants_file.write_text("export const CLIENT_CONFIG = { timeout: 30000 };\n", encoding="utf-8")

        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "INTERRUPTED",
            "conversation_id": "conv-still-running",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=True), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            with self.assertRaises(worker.WorkerError):
                worker.cmd_run_task(self.temp_dir, issue_number=19, local_only=True)
            mock_remove.assert_not_called()
            self.assertTrue(constants_file.exists())
            self.assertEqual(constants_file.read_text(encoding="utf-8"), "export const CLIENT_CONFIG = { timeout: 30000 };\n")
            ckpt = worker.load_checkpoint(self.temp_dir)
            self.assertEqual(ckpt["stage"], "INTERRUPTED")

    def test_recovery_fails_closed_when_resumed_tests_fail(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        constants_file = wt_dir / "src" / "config" / "constants.js"
        constants_file.parent.mkdir(parents=True, exist_ok=True)
        constants_file.write_text("export const CLIENT_CONFIG = { timeout: 30000 };\n", encoding="utf-8")

        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_TIMED_OUT",
            "conversation_id": "conv-stopped",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_cmd", side_effect=lambda *args, **kwargs: " M src/config/constants.js\n" if "--porcelain" in args else ""), \
             patch.object(worker, "run_local_tests", side_effect=worker.WorkerError("npm test failed")), \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            with self.assertRaises(worker.WorkerError):
                worker.cmd_run_task(self.temp_dir, issue_number=19, local_only=True)
            mock_remove.assert_not_called()
            self.assertTrue(constants_file.exists())

    def test_recovery_via_cmd_poll_preserves_and_resumes_worktree(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        constants_file = wt_dir / "src" / "config" / "constants.js"
        constants_file.parent.mkdir(parents=True, exist_ok=True)
        constants_file.write_text("export const CLIENT_CONFIG = { timeout: 30000 };\n", encoding="utf-8")

        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_TIMED_OUT",
            "conversation_id": "conv-dead",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return " M src/config/constants.js\n"
            if "diff --check" in cmd_str:
                return ""
            if "diff" in cmd_str and "--cached" not in cmd_str:
                return "+export const CLIENT_CONFIG = { timeout: 30000 };\n"
            if "npm test" in cmd_str:
                return "All 22 tests passing\n"
            if "rev-parse" in cmd_str:
                return "8712aa66d5ba6adac24cf14c01c4ee9312e1383f"
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd), \
             patch.object(worker, "remove_isolated_worktree"):
            success = worker.cmd_poll(self.temp_dir, local_only=True)
            self.assertTrue(success)
            # Assert checkpoint cleared after successful completion
            self.assertIsNone(worker.load_checkpoint(self.temp_dir))

    def test_recovery_via_cmd_run_task_preserves_and_resumes_worktree(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        constants_file = wt_dir / "src" / "config" / "constants.js"
        constants_file.parent.mkdir(parents=True, exist_ok=True)
        constants_file.write_text("export const CLIENT_CONFIG = { timeout: 30000 };\n", encoding="utf-8")

        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "INTERRUPTED",
            "conversation_id": "conv-stopped",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return " M src/config/constants.js\n"
            if "diff --check" in cmd_str:
                return ""
            if "diff" in cmd_str and "--cached" not in cmd_str:
                return "+export const CLIENT_CONFIG = { timeout: 30000 };\n"
            if "npm test" in cmd_str:
                return "PASS\n"
            if "rev-parse" in cmd_str:
                return "8712aa66d5ba6adac24cf14c01c4ee9312e1383f"
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd), \
             patch.object(worker, "remove_isolated_worktree"):
            worker.cmd_run_task(self.temp_dir, issue_number=19, local_only=True)
            self.assertIsNone(worker.load_checkpoint(self.temp_dir))

    def test_recovery_waiting_ci_does_not_duplicate_commits_or_prs(self) -> None:
        task = worker.Task(
            issue_number=19,
            task_id="GAT-TEST-CI",
            title="CI Wait Task",
            body="",
            state_label="state:working",
            branch="agent/gat-test-ci",
            allowed_paths=["src/config/constants.js"],
        )
        head_sha = "8712aa66d5ba6adac24cf14c01c4ee9312e1383f"
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-TEST-CI",
            "issue": 19,
            "stage": "WAITING_CI",
            "pr_number": 21,
            "head_sha": head_sha,
        })

        # Test local_only: skips waiting for CI and remote handoff
        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "wait_for_pr_checks") as mock_wait, \
             patch.object(worker, "publish_handoff") as mock_handoff:
            res = worker.execute_task(self.temp_dir, task, local_only=True)
            self.assertEqual(res["status"], "local_only_success")
            self.assertEqual(res["commit"], head_sha)
            mock_wait.assert_not_called()
            mock_handoff.assert_not_called()
            self.assertIsNone(worker.load_checkpoint(self.temp_dir))

    def test_recovery_committed_clean_divergent_tree_succeeds(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_RUNNING",
            "conversation_id": "conv-idle",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return ""  # Clean worktree (committed tree recovery)
            if "rev-parse --abbrev-ref" in cmd_str:
                return "agent/gat-smoke-001"
            if "rev-parse origin/main" in cmd_str:
                return "1111111111111111111111111111111111111111"
            if "rev-parse HEAD" in cmd_str:
                return "2222222222222222222222222222222222222222"
            if "merge-base --is-ancestor" in cmd_str:
                return ""  # base is ancestor
            if "diff --name-status" in cmd_str:
                return "M\tsrc/config/constants.js\n"
            if "diff --check" in cmd_str:
                return ""
            if "diff" in cmd_str:
                return "+export const CLIENT_CONFIG = {};\n"
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_local_tests") as mock_local_tests, \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd), \
             patch.object(worker, "remove_isolated_worktree"):
            success = worker.cmd_poll(self.temp_dir, local_only=True)
            self.assertTrue(success)
            # Assert local tests were explicitly run on the recovered commit
            mock_local_tests.assert_called_once()
            self.assertIsNone(worker.load_checkpoint(self.temp_dir))

    def test_recovery_committed_out_of_scope_fails_closed_no_push_or_handoff(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_RUNNING",
            "conversation_id": "conv-idle",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return ""
            if "rev-parse --abbrev-ref" in cmd_str:
                return "agent/gat-smoke-001"
            if "rev-parse origin/main" in cmd_str:
                return "1111111111111111111111111111111111111111"
            if "rev-parse HEAD" in cmd_str:
                return "2222222222222222222222222222222222222222"
            if "merge-base --is-ancestor" in cmd_str:
                return ""
            if "diff --name-status" in cmd_str:
                return "M\tsrc/server.js\n"  # OUT OF SCOPE!
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_local_tests") as mock_local_tests, \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd) as mock_cmd, \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            success = worker.cmd_poll(self.temp_dir, local_only=False)
            self.assertFalse(success)
            # Local tests must NOT be run when scope check fails
            mock_local_tests.assert_not_called()
            # Assert NO git push or gh handoff commands were called
            for call in mock_cmd.call_args_list:
                args = call[0]
                self.assertNotIn("push", args)
                if args and args[0] == "gh" and len(args) >= 3 and args[2] == "comment":
                    self.fail(f"Handoff comment was posted on out-of-scope commit: {args}")
            # Destructive cleanup must not be called
            mock_remove.assert_not_called()
            # Checkpoint remains intact on disk
            ckpt = worker.load_checkpoint(self.temp_dir)
            self.assertIsNotNone(ckpt)
            self.assertEqual(ckpt["stage"], "AGENT_RUNNING")

    def test_recovery_committed_protected_file_fails_closed_no_push_or_handoff(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_MONITORING",
            "conversation_id": "conv-idle",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return ""
            if "rev-parse --abbrev-ref" in cmd_str:
                return "agent/gat-smoke-001"
            if "rev-parse origin/main" in cmd_str:
                return "1111111111111111111111111111111111111111"
            if "rev-parse HEAD" in cmd_str:
                return "2222222222222222222222222222222222222222"
            if "merge-base --is-ancestor" in cmd_str:
                return ""
            if "diff --name-status" in cmd_str:
                return "M\tscripts/local_antina_worker.py\n"  # PROTECTED FILE!
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd) as mock_cmd, \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            success = worker.cmd_poll(self.temp_dir, local_only=False)
            self.assertFalse(success)
            for call in mock_cmd.call_args_list:
                args = call[0]
                self.assertNotIn("push", args)
                if args and args[0] == "gh" and len(args) >= 3 and args[2] == "comment":
                    self.fail(f"Handoff comment posted on protected-file commit: {args}")
            mock_remove.assert_not_called()
            ckpt = worker.load_checkpoint(self.temp_dir)
            self.assertIsNotNone(ckpt)
            self.assertEqual(ckpt["stage"], "AGENT_MONITORING")

    def test_recovery_committed_failing_tests_fails_closed_no_push_or_handoff(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_RUNNING",
            "conversation_id": "conv-idle",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return ""
            if "rev-parse --abbrev-ref" in cmd_str:
                return "agent/gat-smoke-001"
            if "rev-parse origin/main" in cmd_str:
                return "1111111111111111111111111111111111111111"
            if "rev-parse HEAD" in cmd_str:
                return "2222222222222222222222222222222222222222"
            if "merge-base --is-ancestor" in cmd_str:
                return ""
            if "diff --name-status" in cmd_str:
                return "M\tsrc/config/constants.js\n"
            if "diff --check" in cmd_str:
                return ""
            if "diff" in cmd_str:
                return "+export const CLIENT_CONFIG = {};\n"
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_local_tests", side_effect=worker.WorkerError("npm test failed")), \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd) as mock_cmd, \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            success = worker.cmd_poll(self.temp_dir, local_only=False)
            self.assertFalse(success)
            for call in mock_cmd.call_args_list:
                args = call[0]
                self.assertNotIn("push", args)
            mock_remove.assert_not_called()
            self.assertIsNotNone(worker.load_checkpoint(self.temp_dir))

    def test_recovery_committed_non_ancestor_baseline_fails_closed(self) -> None:
        wt_dir = self.temp_dir / ".worktrees" / "agent-gat-smoke-001"
        wt_dir.mkdir(parents=True)
        worker.save_checkpoint(self.temp_dir, {
            "task_id": "GAT-SMOKE-001",
            "issue": 19,
            "stage": "AGENT_RUNNING",
            "conversation_id": "conv-idle",
            "worktree": str(wt_dir),
        })

        mock_issue = {
            "number": 19,
            "title": "[GAT-SMOKE-001] Export CLIENT_CONFIG",
            "state": "OPEN",
            "labels": [{"name": "to:antina"}, {"name": "state:working"}],
            "body": """## 📋 GRUM_TASK
- **task_id**: `GAT-SMOKE-001`
### 📁 Files of Interest
- `src/config/constants.js`
""",
        }

        def fake_run_cmd(*args, **kwargs):
            cmd_str = " ".join(args)
            if "status --porcelain" in cmd_str:
                return ""
            if "rev-parse --abbrev-ref" in cmd_str:
                return "agent/gat-smoke-001"
            if "rev-parse origin/main" in cmd_str:
                return "1111111111111111111111111111111111111111"
            if "rev-parse HEAD" in cmd_str:
                return "2222222222222222222222222222222222222222"
            if "merge-base --is-ancestor" in cmd_str:
                raise worker.WorkerError("Not an ancestor")
            return ""

        with patch.object(worker, "verify_repo_remote"), \
             patch.object(worker, "is_agent_conversation_active", return_value=False), \
             patch.object(worker, "gh_json", return_value=mock_issue), \
             patch.object(worker, "run_cmd", side_effect=fake_run_cmd) as mock_cmd, \
             patch.object(worker, "remove_isolated_worktree") as mock_remove:
            success = worker.cmd_poll(self.temp_dir, local_only=False)
            self.assertFalse(success)
            for call in mock_cmd.call_args_list:
                args = call[0]
                self.assertNotIn("push", args)
            mock_remove.assert_not_called()
            self.assertIsNotNone(worker.load_checkpoint(self.temp_dir))


if __name__ == "__main__":
    unittest.main()
