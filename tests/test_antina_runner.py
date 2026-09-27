"""Offline safety tests for the automatic Antina runner."""

import asyncio
import builtins
import importlib.util
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "antina_runner.py"
WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "antina-runner.yml"
VALIDATION_WORKFLOW = (
    Path(__file__).resolve().parents[1] / ".github" / "workflows" / "antina-validation.yml"
)
GUARDRAIL_WORKFLOW = (
    Path(__file__).resolve().parents[1] / ".github" / "workflows" / "platform-guardrails.yml"
)
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
        validation = VALIDATION_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("github.event.issue.author_association == 'OWNER'", workflow)
        self.assertIn("group: antina-issue-${{ github.event.issue.number }}", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("timeout-minutes: 45", workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertNotIn("npm ci", workflow)
        self.assertNotIn("npm test", workflow)
        self.assertIn("name: Antina required validation", validation)
        self.assertIn("if: startsWith(github.head_ref, 'agent/')", validation)
        self.assertIn("contents: read", validation)
        self.assertIn("persist-credentials: false", validation)
        self.assertIn("npm ci", validation)
        self.assertIn("npm test", validation)
        self.assertNotIn("contents: write", validation)
        self.assertNotIn("git push", validation)

    def test_all_platform_actions_are_pinned_to_full_commit_shas(self):
        for path in (WORKFLOW, VALIDATION_WORKFLOW, GUARDRAIL_WORKFLOW):
            source = path.read_text(encoding="utf-8")
            action_refs = re.findall(r"uses:\s+actions/[^@\s]+@([^\s]+)", source)
            self.assertTrue(action_refs, path)
            for ref in action_refs:
                self.assertRegex(ref, r"^[0-9a-f]{40}$", f"{path}: {ref}")

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

    def test_sdk_cannot_execute_repository_controlled_commands(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn('policy.allow("run_command"', source)
        self.assertNotIn("types.BuiltinTools.RUN_COMMAND", source)
        self.assertIn("enable_subagents=False", source)
        self.assertFalse(hasattr(runner, "command_allowed"))
        self.assertNotIn('("npm", "test")', source)
        self.assertTrue(Path(runner.TRUSTED_GIT).is_absolute())

    def test_git_boundary_rejects_hooks_config_remote_and_head_changes(self):
        task = runner.task_from_issue(issue("to:antina", "state:ready"), "OWNER")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "-b", task.branch], cwd=root, check=True,
                           capture_output=True, text=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"],
                           cwd=root, check=True)
            (root / "README.md").write_text("safe\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=root, check=True,
                           capture_output=True, text=True)
            subprocess.run([
                "git", "remote", "add", "origin",
                "https://github.com/Kiris-02/gathermap.git",
            ], cwd=root, check=True)
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            runner.assert_git_boundary(task, root, head)

            hook = root / ".git" / "hooks" / "pre-commit"
            hook.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            with self.assertRaisesRegex(runner.RunnerError, "hooks"):
                runner.assert_git_boundary(task, root, head)
            hook.unlink()

            subprocess.run(["git", "config", "core.hooksPath", ".hooks"],
                           cwd=root, check=True)
            with self.assertRaisesRegex(runner.RunnerError, "configuration"):
                runner.assert_git_boundary(task, root, head)
            subprocess.run(["git", "config", "--unset", "core.hooksPath"],
                           cwd=root, check=True)

            subprocess.run(["git", "remote", "set-url", "origin", "https://evil.invalid/x"],
                           cwd=root, check=True)
            with self.assertRaisesRegex(runner.RunnerError, "origin"):
                runner.assert_git_boundary(task, root, head)
            subprocess.run([
                "git", "remote", "set-url", "origin",
                "https://github.com/Kiris-02/gathermap.git",
            ], cwd=root, check=True)

            (root / "README.md").write_text("changed\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "unexpected"], cwd=root, check=True,
                           capture_output=True, text=True)
            with self.assertRaisesRegex(runner.RunnerError, "HEAD"):
                runner.assert_git_boundary(task, root, head)

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
        self.assertEqual(runner.checks_state([
            {"name": "unrelated", "status": "COMPLETED", "conclusion": "SUCCESS"}
        ]), "pending")
        self.assertEqual(runner.checks_state([{
            "name": "Antina required validation", "status": "IN_PROGRESS"
        }]), "pending")
        for conclusion in ["FAILURE", "CANCELLED", "SKIPPED", "NEUTRAL"]:
            self.assertEqual(runner.checks_state([{
                "name": "Antina required validation",
                "status": "COMPLETED",
                "conclusion": conclusion,
            }]), "failed")
        self.assertEqual(runner.checks_state([{
            "name": "Antina required validation",
            "status": "COMPLETED",
            "conclusion": "SUCCESS",
        }]), "success")

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
            api_key, transport = runner.scrub_sensitive_environment()
            self.assertEqual(api_key, "gemini")
            self.assertEqual(transport, {"GH_TOKEN": "github"})
            self.assertNotIn("GH_TOKEN", runner.os.environ)
            self.assertNotIn("UNRELATED_SECRET", runner.os.environ)
            self.assertEqual(runner.os.environ["PATH"], "/bin")

    def test_sdk_import_cannot_observe_sensitive_environment(self):
        task = runner.task_from_issue(issue("to:antina", "state:ready"), "OWNER")
        observed = {}
        real_import = builtins.__import__

        def import_probe(name, *args, **kwargs):
            if name.startswith("google.antigravity"):
                observed.update({
                    key: runner.os.environ.get(key)
                    for key in (
                        "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY",
                        "ACTIONS_RUNTIME_TOKEN",
                    )
                })
                raise ImportError("import probe")
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp, patch.dict(runner.os.environ, {
            "PATH": "/bin",
            "GH_TOKEN": "gh-token",
            "GITHUB_TOKEN": "github-token",
            "GEMINI_API_KEY": "gemini-key",
            "ACTIONS_RUNTIME_TOKEN": "runtime-secret",
        }, clear=True), patch("builtins.__import__", side_effect=import_probe):
            with self.assertRaisesRegex(runner.RunnerError, "not installed"):
                asyncio.run(runner.run_antigravity(task, Path(temp)))

            self.assertEqual(observed, {
                "GH_TOKEN": None,
                "GITHUB_TOKEN": None,
                "GEMINI_API_KEY": None,
                "ACTIONS_RUNTIME_TOKEN": None,
            })
            self.assertEqual(runner.os.environ["GH_TOKEN"], "gh-token")
            self.assertEqual(runner.os.environ["GITHUB_TOKEN"], "github-token")
            self.assertNotIn("GEMINI_API_KEY", runner.os.environ)
            self.assertNotIn("ACTIONS_RUNTIME_TOKEN", runner.os.environ)


if __name__ == "__main__":
    unittest.main()
