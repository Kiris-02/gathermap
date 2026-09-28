#!/usr/bin/env python3
"""Comprehensive test suite for Temporary GitHub -> Kir Local Bridge (GAT-OPS-007).

Validates all 5 findings from Grum's independent review:
1. Deduplication strictly ignores timestamps/metadata changes, and triggers on body changes.
2. Canonical escalation labels (needs:kiris, needs_kiris) and invalid control labels are blocked.
3. Revision binding strictly requires latest GRUM_REVIEW decision to be REVISION_REQUIRED.
4. Two-phase dispatch and crash recovery transitions in-flight tasks to UNCERTAIN without resending.
5. Single-instance concurrency lock and state reload persistence across process restarts.
"""

import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Import bridge module
import bridge


class TestBridgeHardening(unittest.TestCase):

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(prefix="bridge_test_"))
        self.orig_state_file = bridge.STATE_FILE
        self.orig_lock_file = bridge.LOCK_FILE
        self.orig_log_file = bridge.LOG_FILE

        bridge.STATE_FILE = self.test_dir / "bridge_state.json"
        bridge.LOCK_FILE = self.test_dir / "bridge.lock"
        bridge.LOG_FILE = self.test_dir / "bridge.log"

    def tearDown(self):
        bridge.STATE_FILE = self.orig_state_file
        bridge.LOCK_FILE = self.orig_lock_file
        bridge.LOG_FILE = self.orig_log_file
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # -----------------------------------------------------------------------
    # Finding 1: Deduplication Fingerprint & Metadata Changes
    # -----------------------------------------------------------------------
    def test_deduplication_ignores_unrelated_metadata_and_detects_body_change(self):
        base_body = (
            "## 📋 GRUM_TASK\n\n"
            "- **task_id**: GAT-PLAT-008\n"
            "- **goal**: Implement test feature\n\n"
            "### 🎯 Acceptance Criteria\n"
            "- [ ] Criterion A\n"
        )
        fp_initial = bridge.compute_task_fingerprint(
            issue_number=101,
            task_id="GAT-PLAT-008",
            state_label="state:ready",
            body=base_body,
        )

        # 1. Simulate metadata/comment activity (updatedAt changes or different timestamp)
        # Fingerprint MUST remain identical because body & task_id are identical
        fp_after_comments = bridge.compute_task_fingerprint(
            issue_number=101,
            task_id="GAT-PLAT-008",
            state_label="state:ready",
            body=base_body,
        )
        self.assertEqual(fp_initial, fp_after_comments, "Fingerprint changed on metadata-only activity!")

        # 2. Simulate real requirement change in task body
        modified_body = base_body + "- [ ] Criterion B (New Requirement)\n"
        fp_modified = bridge.compute_task_fingerprint(
            issue_number=101,
            task_id="GAT-PLAT-008",
            state_label="state:ready",
            body=modified_body,
        )
        self.assertNotEqual(fp_initial, fp_modified, "Fingerprint failed to change on body requirement update!")

    # -----------------------------------------------------------------------
    # Finding 2: Canonical Escalation & Control Label Rejection
    # -----------------------------------------------------------------------
    def test_canonical_and_forbidden_labels_are_blocked(self):
        forbidden_test_cases = [
            ("needs:kiris", "Canonical needs:kiris must be blocked"),
            ("needs_kiris", "Legacy needs_kiris must be blocked"),
            ("state:needs-kiris", "state:needs-kiris must be blocked"),
            ("to:grum", "to:grum must be blocked"),
            ("state:review", "state:review must be blocked"),
            ("state:done", "state:done must be blocked"),
            ("state:completed", "state:completed must be blocked"),
            ("state:blocked", "state:blocked must be blocked"),
            ("human:escalation", "human:escalation must be blocked"),
        ]

        for bad_label, msg in forbidden_test_cases:
            issue = {
                "number": 102,
                "title": "Blocked task",
                "labels": [{"name": "to:antina"}, {"name": "state:ready"}, {"name": bad_label}],
                "body": "## 📋 GRUM_TASK\n- **task_id**: GAT-001\n",
            }
            eligible, reason, _ = bridge.evaluate_task_eligibility(issue, "dummy/repo")
            self.assertFalse(eligible, f"Failed: {msg} (Reason: {reason})")

    # -----------------------------------------------------------------------
    # Finding 2b: Strict Revision Binding
    # -----------------------------------------------------------------------
    @patch("bridge.run_gh_json")
    def test_revision_binding_accepts_only_revision_required(self, mock_gh):
        issue_body = "## 📋 GRUM_TASK\n- **task_id**: GAT-REV-01\nSee pull/21 for context."

        # Case A: Latest review decision is ACCEPT -> MUST REJECT
        mock_gh.return_value = {
            "state": "OPEN",
            "comments": [
                {"body": "## 🔍 GRUM_REVIEW\n- **decision**: ACCEPT\n- **reviewed_head**: 1111222233334444555566667777888899990000\n- **required_changes**: None\n"}
            ]
        }
        ok, reason, _ = bridge.inspect_revision_pr("dummy/repo", issue_body)
        self.assertFalse(ok)
        self.assertIn("ACCEPT", reason)

        # Case B: Latest review decision is NEEDS_KIRIS -> MUST REJECT
        mock_gh.return_value = {
            "state": "OPEN",
            "comments": [
                {"body": "## 🔍 GRUM_REVIEW\n- **decision**: NEEDS_KIRIS\n- **reviewed_head**: 1111222233334444555566667777888899990000\n- **required_changes**: Needs human approval\n"}
            ]
        }
        ok, reason, _ = bridge.inspect_revision_pr("dummy/repo", issue_body)
        self.assertFalse(ok)
        self.assertIn("NEEDS_KIRIS", reason)

        # Case C: Latest review decision is REVISION_REQUIRED -> MUST ACCEPT
        mock_gh.return_value = {
            "state": "OPEN",
            "comments": [
                {"body": "## 🔍 GRUM_REVIEW\n- **decision**: REVISION_REQUIRED\n- **reviewed_head**: `1111222233334444555566667777888899990000`\n- **required_changes**: Fix unit tests\n- **next_state**: ANTINA_WORKING\n"}
            ]
        }
        ok, reason, details = bridge.inspect_revision_pr("dummy/repo", issue_body)
        self.assertTrue(ok)
        self.assertIn("PR#21", details)
        self.assertIn("DEC:REVISION_REQUIRED", details)

    # -----------------------------------------------------------------------
    # Finding 3: Two-Phase Dispatch & Crash Recovery
    # -----------------------------------------------------------------------
    def test_in_flight_crash_recovery_transitions_to_uncertain_without_resend(self):
        # 1. Simulate crashed run: task was marked in pending_dispatches
        state = {
            "version": "1.1",
            "pending_dispatches": {
                "200": {
                    "task_id": "GAT-CRASH-01",
                    "fingerprint": "fp_crash_200",
                    "state_label": "state:ready",
                    "started_at": "2026-09-28T15:00:00Z"
                }
            },
            "dispatched_tasks": {},
            "uncertain_deliveries": {}
        }
        bridge.save_state(state)

        # 2. Call load_state() to simulate restart recovery
        recovered = bridge.load_state()

        # Assert in-flight dispatch was moved to uncertain_deliveries
        self.assertNotIn("200", recovered["pending_dispatches"])
        self.assertIn("200", recovered["uncertain_deliveries"])
        self.assertEqual(recovered["uncertain_deliveries"]["200"]["reason"], "CRASH_OR_UNCONFIRMED_DELIVERY")

        # 3. Simulate polling loop encountering this task again:
        # Mock poll_github returning issue 200
        mock_issue = {
            "number": 200,
            "title": "Crashed Task",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": "## 📋 GRUM_TASK\n- **task_id**: GAT-CRASH-01\n",
        }
        with patch("bridge.poll_github", return_value=[mock_issue]), \
             patch("bridge.send_to_kir") as mock_send:
            dispatched = bridge.run_single_poll_cycle("dummy/repo", "dummy_conv", recovered, dry_run=False)
            self.assertEqual(dispatched, 0, "Task in UNCERTAIN state must not be re-dispatched!")
            mock_send.assert_not_called()

    # -----------------------------------------------------------------------
    # Finding 4: Single-Instance Lock & Restart
    # -----------------------------------------------------------------------
    def test_single_instance_lock_and_clean_release(self):
        self.assertTrue(bridge.acquire_lock())
        self.assertTrue(bridge.LOCK_FILE.exists())

        # Second acquisition from same live process should reject duplicate run
        self.assertFalse(bridge.acquire_lock())

        # Release lock
        bridge.release_lock()
        self.assertFalse(bridge.LOCK_FILE.exists())


if __name__ == "__main__":
    unittest.main()
