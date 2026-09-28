"""Offline safety tests for the automatic Antina runner."""

import asyncio
import builtins
import importlib.util
from dataclasses import replace
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
        self.assertIn("github.event.label.name == 'to:antina'", workflow)
        self.assertNotIn("github.event.label.name == 'state:revision'", workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertNotIn("npm ci", workflow)
        self.assertNotIn("npm test", workflow)
        self.assertIn("name: Antina required validation", validation)
        self.assertIn("github.head_ref == 'refactor/ui-map-architecture'", validation)
        self.assertIn("git diff --check", validation)
        self.assertIn("contents: read", validation)
        self.assertIn("persist-credentials: false", validation)
        self.assertIn("npm ci", validation)
        self.assertIn("npm test", validation)
        self.assertIn("image: postgres:16", validation)
        self.assertIn("POSTGRES_DB: gathermap_test", validation)
        self.assertIn("postgresql://postgres:postgrespassword@localhost:5432/gathermap_test", validation)
        self.assertIn("npx playwright install --with-deps chromium", validation)
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
        self.assertEqual(runner.validate_event(event(trigger="to:antina"))[0], 8)
        with self.assertRaises(runner.IgnoreEvent):
            runner.validate_event(event(trigger="state:revision"))
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
            ("to:antina", "state:ready", "needs:kiris"),
            ("state:ready",),
        ]:
            with self.assertRaises(runner.IgnoreEvent):
                runner.task_from_issue(issue(*labels), "OWNER")

    def test_product_pr_two_requires_exact_owner_pin_and_revision(self):
        body = "## GRUM_TASK\n\n- **task_id**: `GAT-002`\n- goal: revise PR #2\n"
        with self.assertRaisesRegex(runner.RunnerError, "requires an explicit"):
            runner.task_from_issue(issue("to:antina", "state:ready", body=body), "OWNER")
        pinned = body + ("- **revision_pr**: `2`\n"
                         "- **revision_branch**: `refactor/ui-map-architecture`\n"
                         f"- **revision_head**: `{'a' * 40}`\n")
        with self.assertRaisesRegex(runner.RunnerError, "only for a pinned revision"):
            runner.task_from_issue(issue("to:antina", "state:ready", body=pinned), "OWNER")
        task = runner.task_from_issue(issue("to:antina", "state:revision", body=pinned), "OWNER")
        self.assertEqual((task.branch, task.revision_pr, task.revision_head),
                         ("refactor/ui-map-architecture", 2, "a" * 40))
        with self.assertRaises(runner.IgnoreEvent):
            runner.task_from_issue(issue("to:antina", "state:revision", body=pinned), "CONTRIBUTOR")
        for altered in (pinned.replace("`2`", "`3`"),
                        pinned.replace("`a" + "a" * 39 + "`", "`bad`"),
                        pinned + "- **revision_pr**: `2`\n"):
            with self.assertRaises(runner.RunnerError):
                runner.task_from_issue(issue("to:antina", "state:revision", body=altered), "OWNER")

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

    def test_product_revision_requires_live_pr_owner_branch_and_exact_head(self):
        task = replace(runner.task_from_issue(issue("to:antina", "state:revision"), "OWNER"),
                       branch="refactor/ui-map-architecture", revision_pr=2,
                       revision_head="a" * 40)
        good = {"number": 2, "url": "https://github.com/Kiris-02/gathermap/pull/2",
                "state": "OPEN", "headRefName": task.branch, "baseRefName": "main",
                "headRefOid": task.revision_head,
                "headRepositoryOwner": {"login": "Kiris-02"}, "isCrossRepository": False}
        with patch.object(runner, "gh_json", return_value=good):
            self.assertEqual(runner.find_revision_pr(task)["number"], 2)
        for changed in ({"headRefOid": "b" * 40}, {"isCrossRepository": True},
                        {"headRefName": "agent/other"}, {"baseRefName": "other"},
                        {"state": "CLOSED"}, {"headRepositoryOwner": {"login": "other"}}):
            with patch.object(runner, "gh_json", return_value=good | changed), \
                 self.assertRaisesRegex(runner.RunnerError, "revision pin"):
                runner.find_revision_pr(task)

    def test_product_revision_refuses_moved_remote_before_fetch_or_claim(self):
        task = replace(runner.task_from_issue(issue("to:antina", "state:revision"), "OWNER"),
                       branch="refactor/ui-map-architecture", revision_pr=2,
                       revision_head="a" * 40)
        with patch.object(runner, "run", side_effect=["", "https://github.com/Kiris-02/gathermap.git", "b" * 40 + "\trefs/heads/refactor/ui-map-architecture"]) as run, \
             patch.object(runner, "find_revision_pr", return_value={"number": 2}), \
             self.assertRaisesRegex(runner.RunnerError, "moved"):
            runner.prepare_branch(task, Path("."))
        self.assertFalse(any(call.args[1] == "fetch" for call in run.call_args_list))

    def test_product_revision_preflights_protected_baseline_whitespace(self):
        task = replace(runner.task_from_issue(issue("to:antina", "state:revision"), "OWNER"),
                       branch="refactor/ui-map-architecture", revision_pr=2,
                       revision_head="a" * 40)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outputs = ["", "b" * 40,
                       "src/app.js:4: trailing whitespace.\n"
                       "supabase/migrations/001.sql:9: trailing whitespace."]
            with patch.object(runner, "run", side_effect=outputs), \
                 self.assertRaisesRegex(runner.RunnerError, "protected paths"):
                runner.ensure_product_revision_fixable(task, root)

    def test_check_rollup_distinguishes_pending_failure_and_success(self):
        req = frozenset({"Antina required validation"})
        self.assertEqual(runner.checks_state([], required=req), "pending")
        self.assertEqual(runner.checks_state([
            {"name": "unrelated", "status": "COMPLETED", "conclusion": "SUCCESS"}
        ], required=req), "pending")
        self.assertEqual(runner.checks_state([{
            "name": "Antina required validation", "status": "IN_PROGRESS"
        }], required=req), "pending")
        for conclusion in ["FAILURE", "CANCELLED", "TIMED_OUT", "NEUTRAL"]:
            self.assertEqual(runner.checks_state([{
                "name": "Antina required validation",
                "status": "COMPLETED",
                "conclusion": conclusion,
            }], required=req), "failed")
        self.assertEqual(runner.checks_state([{
            "name": "Antina required validation",
            "status": "COMPLETED",
            "conclusion": "SUCCESS",
        }], required=req), "success")

    def test_check_state_distinguishes_approval_required_stale_and_skipped(self):
        self.assertEqual(runner.check_state({"status": "ACTION_REQUIRED"}), "approval_required")
        self.assertEqual(runner.check_state({"status": "WAITING", "conclusion": "ACTION_REQUIRED"}), "approval_required")
        self.assertEqual(runner.check_state({"status": "COMPLETED", "conclusion": "ACTION_REQUIRED"}), "approval_required")
        self.assertEqual(runner.check_state({"status": "COMPLETED", "conclusion": "STALE"}), "stale")
        self.assertEqual(runner.check_state({"status": "COMPLETED", "conclusion": "SKIPPED"}), "skipped")
        self.assertEqual(runner.check_state({"status": "QUEUED"}), "pending")
        self.assertEqual(runner.check_state({"status": "COMPLETED", "conclusion": "SUCCESS"}), "success")

    def test_checks_state_requires_all_configured_checks(self):
        # When only one of the required checks is present, status is pending
        rollup_one = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"}
        ]
        self.assertEqual(runner.checks_state(rollup_one), "pending")

        # When both required checks are present and successful, status is success
        rollup_both = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "Test Suite & Browser E2E", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        self.assertEqual(runner.checks_state(rollup_both), "success")

        # Any check requiring approval halts with approval_required
        rollup_approval = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "Test Suite & Browser E2E", "status": "ACTION_REQUIRED", "conclusion": ""},
        ]
        self.assertEqual(runner.checks_state(rollup_approval), "approval_required")

        # Any check skipped halts with skipped
        rollup_skipped = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"name": "Test Suite & Browser E2E", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        self.assertEqual(runner.checks_state(rollup_skipped), "skipped")

    def test_checks_state_and_wait_for_checks_detect_stale_head(self):
        rollup = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "Test Suite & Browser E2E", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        self.assertEqual(runner.checks_state(rollup, expected_head="head1", pr_head="head2"), "stale")
        self.assertEqual(runner.checks_state(rollup, expected_head="head1", pr_head="head1"), "success")

        # wait_for_checks raises on stale head
        with patch.object(runner, "gh_json", return_value={"headRefOid": "head2", "statusCheckRollup": rollup}), \
             self.assertRaisesRegex(runner.RunnerError, "does not match expected commit"):
            runner.wait_for_checks(9, expected_head="head1", timeout=1)

        # wait_for_checks raises on approval required
        approval_rollup = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "Test Suite & Browser E2E", "status": "ACTION_REQUIRED"},
        ]
        with patch.object(runner, "gh_json", return_value={"headRefOid": "head1", "statusCheckRollup": approval_rollup}), \
             self.assertRaisesRegex(runner.RunnerError, "human approval"):
            runner.wait_for_checks(9, expected_head="head1", timeout=1)

        # wait_for_checks raises on skipped
        skipped_rollup = [
            {"name": "Antina required validation", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"name": "Test Suite & Browser E2E", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        with patch.object(runner, "gh_json", return_value={"headRefOid": "head1", "statusCheckRollup": skipped_rollup}), \
             self.assertRaisesRegex(runner.RunnerError, "skipped"):
            runner.wait_for_checks(9, expected_head="head1", timeout=1)

    def test_is_rate_limit_error_and_delay_parsing(self):
        err_429 = Exception("Error 429: Rate limit exceeded. Please retry in 406.75ms.")
        self.assertTrue(runner.is_rate_limit_error(err_429))
        self.assertAlmostEqual(runner.parse_retry_delay(err_429, default_delay=5.0), 5.0)

        err_long = Exception("RESOURCE_EXHAUSTED: Please retry in 25s.")
        self.assertTrue(runner.is_rate_limit_error(err_long))
        self.assertEqual(runner.parse_retry_delay(err_long, default_delay=5.0), 25.0)

        err_other = ValueError("Some syntax error")
        self.assertFalse(runner.is_rate_limit_error(err_other))

    def test_run_antigravity_retries_on_rate_limit_and_fails_safely_without_key_leak(self):
        task = runner.task_from_issue(issue("to:antina", "state:ready"), "OWNER")
        attempts = 0

        class FakeChatResponse:
            async def text(self):
                return "Agent completed work."

        class FlakyAgent:
            def __init__(self, *args, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass
            async def chat(self, prompt):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise Exception("Error 429: Quota exceeded for metric generate_content_free_tier_requests")
                return FakeChatResponse()

        class MockAntigravity:
            Agent = FlakyAgent
            LocalAgentConfig = lambda **kwargs: kwargs
            types = type("Types", (), {
                "CapabilitiesConfig": lambda **kwargs: kwargs,
                "BuiltinTools": type("Tools", (), {
                    "LIST_DIR": "list", "SEARCH_DIR": "search", "FIND_FILE": "find",
                    "VIEW_FILE": "view", "CREATE_FILE": "create", "EDIT_FILE": "edit",
                    "FINISH": "finish"
                })
            })
            hooks = type("Hooks", (), {
                "policy": type("Policy", (), {
                    "allow": lambda *a, **kw: None,
                    "deny": lambda *a, **kw: None,
                })
            })

        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(runner.os.environ, {"GEMINI_API_KEY": "secret-key-12345", "GH_TOKEN": "gh-token"}), \
             patch.dict("sys.modules", {"google.antigravity": MockAntigravity, "google.antigravity.hooks": MockAntigravity.hooks}), \
             patch("asyncio.sleep", return_value=None):
            result = asyncio.run(runner.run_antigravity(task, Path(temp)))
            self.assertEqual(result, "Agent completed work.")
            self.assertEqual(attempts, 2)

    def test_run_antigravity_persistent_rate_limit_raises_sanitized_runner_error(self):
        task = runner.task_from_issue(issue("to:antina", "state:ready"), "OWNER")

        class AlwaysExhaustedAgent:
            def __init__(self, *args, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass
            async def chat(self, prompt):
                raise Exception("Error 429: RESOURCE_EXHAUSTED: generate_content_free_tier_requests limit: 5")

        class MockAntigravity:
            Agent = AlwaysExhaustedAgent
            LocalAgentConfig = lambda **kwargs: kwargs
            types = type("Types", (), {
                "CapabilitiesConfig": lambda **kwargs: kwargs,
                "BuiltinTools": type("Tools", (), {
                    "LIST_DIR": "list", "SEARCH_DIR": "search", "FIND_FILE": "find",
                    "VIEW_FILE": "view", "CREATE_FILE": "create", "EDIT_FILE": "edit",
                    "FINISH": "finish"
                })
            })
            hooks = type("Hooks", (), {
                "policy": type("Policy", (), {
                    "allow": lambda *a, **kw: None,
                    "deny": lambda *a, **kw: None,
                })
            })

        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(runner.os.environ, {"GEMINI_API_KEY": "my-ultra-secret-key-999", "GH_TOKEN": "gh-token"}), \
             patch.dict("sys.modules", {"google.antigravity": MockAntigravity, "google.antigravity.hooks": MockAntigravity.hooks}), \
             patch("asyncio.sleep", return_value=None):
            with self.assertRaises(runner.RunnerError) as ctx:
                asyncio.run(runner.run_antigravity(task, Path(temp)))

            msg = str(ctx.exception)
            self.assertIn("Gemini rate limit exceeded", msg)
            self.assertIn("Free Tier", msg)
            self.assertNotIn("my-ultra-secret-key-999", msg)
            self.assertNotIn("API_KEY", msg)


    def test_changed_protected_path_fails_before_publish(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(runner, "changed_paths", return_value={"server.js", ".agents/SAFETY.md"}), \
             self.assertRaisesRegex(runner.RunnerError, "Protected paths"):
            runner.validate_changes(Path(temp))

    def test_missing_key_routes_to_kiris_without_starting_agent(self):
        payload = event("to:antina", "state:ready", trigger="to:antina")
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

    def test_unpinned_product_issue_routes_to_kiris_before_sdk(self):
        payload = event("to:antina", "state:revision", trigger="to:antina")
        live = issue("to:antina", "state:revision",
                     body="## GRUM_TASK\n\n- **task_id**: `GAT-008`\n- goal: revise PR #2\n")
        with tempfile.TemporaryDirectory() as temp:
            event_path = Path(temp) / "event.json"
            event_path.write_text(__import__("json").dumps(payload), encoding="utf-8")
            with patch.object(runner.agent_cycle, "issue_view", return_value=live), \
                 patch.object(runner, "route_needs_kiris") as route, \
                 patch.object(runner, "prepare_branch") as prepare, \
                 self.assertRaisesRegex(runner.RunnerError, "explicit owner Issue"):
                runner.execute(event_path, Path(temp))
            route.assert_called_once()
            prepare.assert_not_called()

    def test_escalation_adds_existing_blocker_before_removing_work_state(self):
        snapshots = [issue("to:antina", "state:working"),
                     issue("to:antina", "state:working", "needs:kiris"),
                     issue("needs:kiris")]
        with patch.object(runner.agent_cycle, "issue_view", side_effect=snapshots), \
             patch.object(runner, "run") as run:
            runner.route_needs_kiris(8, "GAT-008", "provider 503")
        actions = [call.args for call in run.call_args_list]
        self.assertEqual(actions[0][-2:], ("--add-label", "needs:kiris"))
        self.assertEqual(actions[1][-2:], ("--remove-label", "state:working,to:antina"))
        self.assertIn("NEEDS_KIRIS", actions[2][-1])
        self.assertIn("provider 503", actions[2][-1])

    def test_escalation_preserves_work_state_if_blocker_cannot_be_added(self):
        with patch.object(runner.agent_cycle, "issue_view", return_value=issue(
                "to:antina", "state:working")), \
             patch.object(runner, "run", side_effect=runner.RunnerError("label failed")) as run:
            with self.assertRaisesRegex(runner.RunnerError, "label failed"):
                runner.route_needs_kiris(8, "GAT-008", "provider 503")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[-2:], ("--add-label", "needs:kiris"))

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
