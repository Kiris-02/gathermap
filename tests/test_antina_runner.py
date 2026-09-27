"""Offline safety tests for the automatic Antina runner."""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "antina_runner.py"
WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "antina-runner.yml"
spec = importlib.util.spec_from_file_location("antina_runner", SCRIPT)
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)


def issue(*labels, body=None):
    return {
        "number": 8,
        "title": "Task",
        "body": body or "## GRUM_TASK\n\n- **task_id**: `GAT-008`\n",
        "state": "OPEN",
        "labels": [{"name": name} for name in labels],
    }


def event(*labels, association="OWNER", action="labeled", trigger="state:ready"):
    return {
        "action": action,
        "label": {"name": trigger},
        "repository": {"full_name": runner.REPO},
        "issue": {
            "number": 8,
            "state": "open",
            "author_association": association,
            "labels": [{"name": name} for name in labels],
        },
    }


class RunnerTests(unittest.TestCase):
    def test_workflow_is_owner_scoped_serial_and_does_not_persist_credentials(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("github.event.issue.author_association == 'OWNER'", workflow)
        self.assertIn("group: antina-issue-${{ github.event.issue.number }}", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("timeout-minutes: 45", workflow)
        self.assertNotIn("pull_request_target", workflow)

    def test_event_requires_owner_issue_label_event(self):
        self.assertEqual(runner.validate_event(event())[0], 8)
        with self.assertRaises(runner.IgnoreEvent):
            runner.validate_event(event(association="CONTRIBUTOR"))
        with self.assertRaises(runner.IgnoreEvent):
            runner.validate_event(event(action="edited"))
        payload = event()
        payload["issue"]["pull_request"] = {"url": "x"}
        with self.assertRaises(runner.IgnoreEvent):
            runner.validate_event(payload)

    def test_exact_task_state_and_duplicate_are_enforced(self):
        task = runner.task_from_issue(issue("to:antina", "state:ready"), "OWNER")
        self.assertEqual(task.branch, "agent/gat-008")
        for labels in [
            ("to:antina", "state:ready", "state:revision"),
            ("to:antina", "state:ready", "state:working"),
            ("to:antina", "state:ready", "state:needs-kiris"),
            ("state:ready",),
        ]:
            with self.assertRaises(runner.IgnoreEvent):
                runner.task_from_issue(issue(*labels), "OWNER")

    def test_product_pr_two_is_never_automated(self):
        body = "## GRUM_TASK\n\n- **task_id**: `GAT-002`\n- goal: revise PR #2\n"
        with self.assertRaisesRegex(runner.RunnerError, "Product PR #2"):
            runner.task_from_issue(issue("to:antina", "state:ready", body=body), "OWNER")

    def test_paths_must_stay_in_workspace_and_avoid_control_surfaces(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertTrue(runner.path_allowed("server.js", root))
            self.assertFalse(runner.path_allowed("../escape.txt", root))
            self.assertFalse(runner.path_allowed(".agents/SAFETY.md", root))
            self.assertFalse(runner.path_allowed(".github/workflows/pwn.yml", root))
            self.assertFalse(runner.path_allowed(".git/config", root))
            self.assertFalse(runner.path_allowed("config/.env.production", root))
            self.assertFalse(runner.path_allowed("supabase/migrations/001.sql", root))
            self.assertFalse(runner.path_allowed("scripts/antina_runner.py", root))
            self.assertFalse(runner.path_allowed("requirements-antina.txt", root))

    def test_read_tools_cannot_inspect_git_or_leave_workspace(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertTrue(runner.read_args_allowed({"file_path": "README.md"}, root))
            self.assertTrue(runner.read_args_allowed({"file_path": ".agents/SAFETY.md"}, root))
            self.assertFalse(runner.read_args_allowed({"file_path": ".git/config"}, root))
            self.assertFalse(runner.read_args_allowed({"file_path": ".npmrc"}, root))
            self.assertFalse(runner.read_args_allowed({"file_path": ".env.production"}, root))
            self.assertFalse(runner.read_args_allowed({"directory_path": "../"}, root))

    def test_only_read_only_or_test_commands_are_allowed(self):
        allowed = [
            "git diff --check",
            "npm test",
            "npm run lint",
            "python -m unittest discover -s tests",
            "node tests/pipeline.test.js",
        ]
        denied = [
            "git push origin main",
            "git reset --hard",
            "npm publish",
            "npm run deploy",
            "python -c 'import os'",
            "node test.js && rm -rf .",
            "npx anything",
            "rg --pre python task_id .",
            "supabase db push",
        ]
        for command in allowed:
            self.assertTrue(runner.command_allowed({"CommandLine": command}), command)
        for command in denied:
            self.assertFalse(runner.command_allowed({"CommandLine": command}), command)

    def test_ready_task_refuses_preexisting_remote_branch(self):
        task = runner.task_from_issue(issue("to:antina", "state:ready"), "OWNER")
        with patch.object(runner, "run", side_effect=["", "https://github.com/Kiris-02/gathermap.git"]), \
             patch.object(runner, "remote_branch_exists", return_value=True), \
             self.assertRaisesRegex(runner.RunnerError, "already exists"):
            runner.prepare_branch(task, Path("."))

    def test_revision_requires_exactly_one_non_product_pr(self):
        task = runner.task_from_issue(issue("to:antina", "state:revision"), "OWNER")
        with patch.object(runner, "gh_json", return_value=[]), \
             self.assertRaisesRegex(runner.RunnerError, "exactly one"):
            runner.find_revision_pr(task)
        with patch.object(runner, "gh_json", return_value=[{
            "number": 9, "url": "https://github.com/Kiris-02/gathermap/pull/9",
            "headRefName": task.branch, "baseRefName": "main",
        }]):
            self.assertEqual(runner.find_revision_pr(task)["number"], 9)

    def test_check_rollup_distinguishes_pending_failure_and_success(self):
        self.assertEqual(runner.checks_state([]), "pending")
        self.assertEqual(runner.checks_state([{"status": "IN_PROGRESS"}]), "pending")
        self.assertEqual(runner.checks_state([{"conclusion": "FAILURE"}]), "failed")
        self.assertEqual(runner.checks_state([
            {"conclusion": "SUCCESS"}, {"conclusion": "SKIPPED"}
        ]), "success")

    def test_changed_protected_path_fails_before_publish(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(runner, "changed_paths", return_value={"server.js", ".agents/SAFETY.md"}), \
             self.assertRaisesRegex(runner.RunnerError, "Protected paths"):
            runner.validate_changes(Path(temp))

    def test_missing_key_routes_to_kiris_without_starting_agent(self):
        payload = event("to:antina", "state:ready")
        with tempfile.TemporaryDirectory() as temp:
            event_path = Path(temp) / "event.json"
            event_path.write_text(__import__("json").dumps(payload), encoding="utf-8")
            live = issue("to:antina", "state:ready")
            with patch.object(runner.agent_cycle, "issue_view", return_value=live), \
                 patch.dict(runner.os.environ, {}, clear=True), \
                 patch.object(runner, "route_needs_kiris") as route, \
                 patch.object(runner, "prepare_branch") as prepare:
                with self.assertRaisesRegex(runner.RunnerError, "GEMINI_API_KEY"):
                    runner.execute(event_path, Path(temp))
                route.assert_called_once()
                prepare.assert_not_called()

    def test_sensitive_environment_is_removed(self):
        with patch.dict(runner.os.environ, {
            "PATH": "/bin", "GEMINI_API_KEY": "gemini", "GH_TOKEN": "github",
            "UNRELATED_SECRET": "hidden",
        }, clear=True):
            removed = runner.pop_sensitive_environment()
            self.assertEqual(removed["GEMINI_API_KEY"], "gemini")
            self.assertNotIn("GH_TOKEN", runner.os.environ)
            self.assertNotIn("UNRELATED_SECRET", runner.os.environ)
            self.assertEqual(runner.os.environ["PATH"], "/bin")


if __name__ == "__main__":
    unittest.main()
