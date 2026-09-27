"""Offline safety tests for the GitHub handoff utility."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "agent_cycle.py"
spec = importlib.util.spec_from_file_location("agent_cycle", SCRIPT)
cycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cycle)
SHA = "a" * 40
URL = "https://github.com/Kiris-02/gathermap/pull/9"


def issue(*names):
    return {"number": 8, "title": "Task",
            "body": "## GRUM_TASK\n\n- **task_id**: `GAT-TEST-008`\n",
            "state": "OPEN", "labels": [{"name": name} for name in names]}


class CycleTests(unittest.TestCase):
    def test_pending_excludes_blocked_and_non_tasks(self):
        values = [issue("to:antina", "state:ready"),
                  issue("to:antina", "state:revision", "state:needs-kiris"),
                  issue("to:antina", "state:ready", "state:working"),
                  issue("to:antina", "state:working")]
        values[3]["body"] = "not a task"
        with patch.object(cycle, "gh_json", return_value=values):
            self.assertEqual(cycle.pending(), [{"number": 8, "title": "Task"}])

    def test_pending_handles_null_body_and_labels(self):
        candidate = issue("to:antina", "state:ready")
        candidate["body"] = None
        candidate["labels"] = None
        with patch.object(cycle, "gh_json", return_value=[candidate]):
            self.assertEqual(cycle.pending(), [])

    def test_claim_only_valid_state_and_verified_transition(self):
        with patch.object(cycle, "require_branch"), \
             patch.object(cycle, "issue_view", side_effect=[
                 issue("to:antina", "state:ready"),
                 issue("to:antina", "state:working")]), \
             patch.object(cycle, "run") as run:
            self.assertEqual(cycle.claim(8, "chore/task-8")["state"], "ANTINA_WORKING")
            run.assert_any_call("gh", "issue", "edit", "8", "--repo", cycle.REPO,
                                "--remove-label", "state:ready", "--add-label",
                                "state:working")
            status = next(call.args[-1] for call in run.call_args_list
                          if call.args[:3] == ("gh", "issue", "comment"))
            self.assertIn("**task_id**: `GAT-TEST-008`", status)

    def test_task_requires_structured_task_id(self):
        candidate = issue("to:antina", "state:ready")
        candidate["body"] = "## GRUM_TASK\n"
        with self.assertRaisesRegex(cycle.CycleError, "structured task_id"):
            cycle.require_task(candidate)

    def test_claim_refuses_blocked_without_mutation(self):
        with patch.object(cycle, "require_branch"), \
             patch.object(cycle, "issue_view", return_value=issue(
                 "to:antina", "state:ready", "state:needs-kiris")), \
             patch.object(cycle, "run") as run:
            with self.assertRaises(cycle.CycleError):
                cycle.claim(8, "chore/task-8")
            run.assert_not_called()

    def test_claim_refuses_conflicting_working_state(self):
        with patch.object(cycle, "require_branch"), \
             patch.object(cycle, "issue_view", return_value=issue(
                 "to:antina", "state:ready", "state:working")), \
             patch.object(cycle, "run") as run:
            with self.assertRaises(cycle.CycleError):
                cycle.claim(8, "chore/task-8")
            run.assert_not_called()

    def test_branch_refuses_product_and_dirty_checkout(self):
        with patch.object(cycle, "run", side_effect=["refactor/ui-map-architecture"]):
            with self.assertRaises(cycle.CycleError):
                cycle.require_branch("refactor/ui-map-architecture")
        with patch.object(cycle, "run", side_effect=["chore/task-8", " M app.js"]):
            with self.assertRaises(cycle.CycleError):
                cycle.require_branch("chore/task-8")

    def test_branch_refuses_lookalike_origin(self):
        with patch.object(cycle, "run", side_effect=[
                "chore/task-8", "", "https://evil.example/Kiris-02/gathermap.git"]):
            with self.assertRaises(cycle.CycleError):
                cycle.require_branch("chore/task-8")

    def test_run_never_invokes_shell(self):
        with patch.object(cycle.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, "ok", "")) as subprocess_run:
            cycle.run("gh", "pr", "edit", "--body", "$(echo unsafe)")
            self.assertEqual(subprocess_run.call_args.args[0],
                             ("gh", "pr", "edit", "--body", "$(echo unsafe)"))
            self.assertNotIn("shell", subprocess_run.call_args.kwargs)

    def test_handoff_rejects_wrong_remote_head_before_write(self):
        pr = {"state": "OPEN", "headRefName": "chore/task-8", "baseRefName": "main",
              "headRefOid": "b" * 40, "url": URL}
        with patch.object(cycle, "require_branch"), \
             patch.object(cycle, "issue_view", return_value=issue(
                 "to:antina", "state:working")), \
             patch.object(cycle, "gh_json", return_value=pr), \
             patch.object(cycle, "run", return_value=SHA) as run:
            with self.assertRaises(cycle.CycleError):
                cycle.handoff(8, "chore/task-8", 9, "report.md")
            self.assertEqual(run.call_count, 1)

    def test_handoff_requires_green_checks_before_label_changes(self):
        pr = {"state": "OPEN", "headRefName": "chore/task-8", "baseRefName": "main",
              "headRefOid": SHA, "url": URL}
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.md"
            report.write_text(f"ANTINA_REPORT {SHA} {URL}\n", encoding="utf-8")
            def command(*args):
                if args[:2] == ("git", "rev-parse"):
                    return SHA
                if args[:3] == ("gh", "pr", "checks"):
                    raise cycle.CycleError("CI pending")
                raise AssertionError(f"Unexpected mutation: {args}")
            with patch.object(cycle, "require_branch"), \
                 patch.object(cycle, "issue_view", return_value=issue(
                     "to:antina", "state:working")), \
                 patch.object(cycle, "gh_json", return_value=pr), \
                 patch.object(cycle, "run", side_effect=command):
                with self.assertRaisesRegex(cycle.CycleError, "CI pending"):
                    cycle.handoff(8, "chore/task-8", 9, report)

    def test_handoff_green_updates_pr_then_verified_issue(self):
        pr = {"state": "OPEN", "headRefName": "chore/task-8", "baseRefName": "main",
              "headRefOid": SHA, "url": URL}
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.md"
            report.write_text(f"## ANTINA_REPORT\n{SHA}\n{URL}\n", encoding="utf-8")
            events = []
            issue_results = iter([issue("to:antina", "state:working"),
                                  issue("to:grum", "state:review")])

            def view(_number):
                events.append("issue_view")
                return next(issue_results)

            def command(*args):
                events.append(args)
                return SHA if args[:2] == ("git", "rev-parse") else ""

            with patch.object(cycle, "require_branch"), \
                 patch.object(cycle, "issue_view", side_effect=view), \
                 patch.object(cycle, "gh_json", return_value=pr), \
                 patch.object(cycle, "run", side_effect=command) as run:
                self.assertEqual(cycle.handoff(8, "chore/task-8", 9, report)[
                    "state"], "PR_READY")
                calls = [call.args for call in run.call_args_list]
                checks = next(i for i, cmd in enumerate(calls) if cmd[:3] ==
                              ("gh", "pr", "checks"))
                issue_edit = next(i for i, cmd in enumerate(calls) if cmd[:3] ==
                                  ("gh", "issue", "edit"))
                pr_route = calls.index(("gh", "pr", "edit", "9", "--repo",
                                        cycle.REPO, "--add-label", "to:grum"))
                self.assertLess(checks, issue_edit)
                issue_edit_event = events.index(calls[issue_edit])
                verified_event = len(events) - 1 - events[::-1].index("issue_view")
                pr_route_event = events.index(calls[pr_route])
                self.assertLess(issue_edit_event, verified_event)
                self.assertLess(verified_event, pr_route_event)
                handoff = next(cmd[-1] for cmd in calls if cmd[:3] ==
                               ("gh", "pr", "comment") and
                               "ANTINA_HANDOFF" in cmd[-1])
                self.assertIn("**task_id**: `GAT-TEST-008`", handoff)

    def test_handoff_rejects_residual_control_labels_before_pr_routing(self):
        pr = {"state": "OPEN", "headRefName": "chore/task-8", "baseRefName": "main",
              "headRefOid": SHA, "url": URL}
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.md"
            report.write_text(f"## ANTINA_REPORT\n{SHA}\n{URL}\n", encoding="utf-8")
            with patch.object(cycle, "require_branch"), \
                 patch.object(cycle, "issue_view", side_effect=[
                     issue("to:antina", "state:working"),
                     issue("to:antina", "to:grum", "state:working", "state:review")]), \
                 patch.object(cycle, "gh_json", return_value=pr), \
                 patch.object(cycle, "run", side_effect=lambda *args:
                              SHA if args[:2] == ("git", "rev-parse") else "") as run:
                with self.assertRaisesRegex(cycle.CycleError, "exact to:grum"):
                    cycle.handoff(8, "chore/task-8", 9, report)
                calls = [call.args for call in run.call_args_list]
                self.assertNotIn(("gh", "pr", "edit", "9", "--repo", cycle.REPO,
                                  "--add-label", "to:grum"), calls)
                self.assertFalse(any(cmd[:3] == ("gh", "pr", "comment")
                                     for cmd in calls))


if __name__ == "__main__":
    unittest.main()
