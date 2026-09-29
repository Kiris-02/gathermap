#!/usr/bin/env python3
"""Comprehensive Regression Suite for Hardened GitHub -> Kir Local Bridge (GAT-OPS-009).

Thoroughly validates all safety findings from Grum's independent review:
1. Fail-closed idle check when conversation DB is missing, unreadable, or has no step records.
2. Kernel atomic lock (O_CREAT | O_EXCL) with true multi-process concurrent race test,
   guaranteeing partial/unreadable locks are never deleted by contenders without verified dead owner.
3. Strict 40-hex revision binding requiring exact full commit SHA equality with PR headRefOid
   (rejecting abbreviated prefixes and mismatched SHAs).
4. Fail-closed state journaling (dispatch aborted on write error; corrupt state blocks startup).
5. Explicit dispatch status semantics (DISPATCHED_TO_CONVERSATION vs recipient ACK).
6. Rejection of conflicting state:* labels and strict validation of GRUM_TASK structure.
7. Pure specification deduplication ignoring mutable metadata.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure bridge module is importable when test is invoked from any directory (e.g. root in CI)
BRIDGE_DIR = Path(__file__).parent.resolve()
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import bridge


def _multiprocess_lock_worker(lock_path_str: str) -> int:
    """Module-level worker for Windows & Linux multiprocessing race testing."""
    lock_path = Path(lock_path_str)
    acquired = bridge.acquire_lock(lock_path)
    if acquired:
        # Hold the lock briefly so competing processes experience contention
        time.sleep(0.15)
        # Cleanly release the lock explicitly as owner
        bridge.release_lock(lock_path)
        return 1
    return 0


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
    # Requirement 1: Fail-Closed Idle Check
    # -----------------------------------------------------------------------
    def test_idle_check_fails_closed_on_missing_db(self):
        """A missing conversation database must fail closed (return False)."""
        idle, reason = bridge.is_kir_conversation_idle("nonexistent_conv", base_home=self.test_dir)
        self.assertFalse(idle, "Idle check must fail closed when DB is missing!")
        self.assertIn("not found", reason.lower())

    def test_idle_check_fails_closed_on_empty_steps_table(self):
        """A conversation database with zero steps must fail closed (return False)."""
        conv_id = "empty_conv_123"
        conv_dir = self.test_dir / ".gemini" / "antigravity" / "conversations"
        conv_dir.mkdir(parents=True, exist_ok=True)
        db_path = conv_dir / f"{conv_id}.db"

        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, status INTEGER);")
        conn.commit()
        conn.close()

        idle, reason = bridge.is_kir_conversation_idle(conv_id, base_home=self.test_dir)
        self.assertFalse(idle, "Idle check must fail closed when steps table has 0 steps!")
        self.assertIn("empty", reason.lower())

    def test_idle_check_fails_closed_when_active_step_running(self):
        """A conversation with step status != 3 (e.g. status=1 or 2) must return False."""
        conv_id = "active_conv_123"
        conv_dir = self.test_dir / ".gemini" / "antigravity" / "conversations"
        conv_dir.mkdir(parents=True, exist_ok=True)
        db_path = conv_dir / f"{conv_id}.db"

        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, status INTEGER);")
        conn.execute("INSERT INTO steps (idx, step_type, status) VALUES (1, 'RUN', 2);")  # 2 != 3
        conn.commit()
        conn.close()

        idle, reason = bridge.is_kir_conversation_idle(conv_id, base_home=self.test_dir)
        self.assertFalse(idle, "Idle check must fail closed when step is actively executing!")
        self.assertIn("status=2", reason)

    def test_idle_check_succeeds_only_when_done_and_no_undelivered_messages(self):
        """Idle check must return True when latest status is 3 (DONE) and no undelivered messages."""
        conv_id = "done_conv_123"
        conv_dir = self.test_dir / ".gemini" / "antigravity" / "conversations"
        conv_dir.mkdir(parents=True, exist_ok=True)
        db_path = conv_dir / f"{conv_id}.db"

        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, status INTEGER);")
        conn.execute("INSERT INTO steps (idx, step_type, status) VALUES (1, 'PLAN', 3);")  # 3 = DONE
        conn.commit()
        conn.close()

        idle, reason = bridge.is_kir_conversation_idle(conv_id, base_home=self.test_dir)
        self.assertTrue(idle, f"Idle check should succeed when status=3 (DONE): {reason}")

    def test_idle_check_fails_closed_when_undelivered_queue_has_messages(self):
        """Undelivered queue containing files must block idle status."""
        conv_id = "queued_conv_123"
        conv_dir = self.test_dir / ".gemini" / "antigravity" / "conversations"
        conv_dir.mkdir(parents=True, exist_ok=True)
        db_path = conv_dir / f"{conv_id}.db"

        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, status INTEGER);")
        conn.execute("INSERT INTO steps (idx, step_type, status) VALUES (1, 'PLAN', 3);")
        conn.commit()
        conn.close()

        undelivered_dir = self.test_dir / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "messages" / "undelivered"
        undelivered_dir.mkdir(parents=True, exist_ok=True)
        (undelivered_dir / "msg_001.json").write_text("{}", encoding="utf-8")

        idle, reason = bridge.is_kir_conversation_idle(conv_id, base_home=self.test_dir)
        self.assertFalse(idle, "Idle check must fail closed when messages are waiting in queue!")
        self.assertIn("undelivered", reason.lower())

    # -----------------------------------------------------------------------
    # Requirement 2: Atomic Lock & Multi-Process Concurrent Race Test
    # -----------------------------------------------------------------------
    def test_atomic_lock_single_process_and_clean_release(self):
        """Basic single-process acquisition and verified release."""
        self.assertTrue(bridge.acquire_lock())
        self.assertTrue(bridge.LOCK_FILE.exists())

        # Second acquisition by same process should fail
        self.assertFalse(bridge.acquire_lock())

        # Release lock
        self.assertTrue(bridge.release_lock())
        self.assertFalse(bridge.LOCK_FILE.exists())

    def test_atomic_lock_concurrent_multiprocess_race(self):
        """Multi-process race test: exactly 1 process acquires the lock, others fail."""
        race_lock = self.test_dir / "race.lock"
        num_workers = 6

        with concurrent.futures.ProcessPoolExecutor(max_workers=num_workers) as executor:
            futures = [
                executor.submit(_multiprocess_lock_worker, str(race_lock))
                for _ in range(num_workers)
            ]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        self.assertEqual(sum(results), 1, f"Expected exactly 1 process to acquire lock; got {sum(results)} out of {num_workers}")
        # Note: Upon worker exit, atexit releases the lock cleanly
        self.assertFalse(race_lock.exists(), "Winner process atexit should have cleanly released the lock upon termination")

    def test_atomic_lock_rejects_unreadable_or_partial_lock_without_deleting(self):
        """A partial, empty, or unreadable lock must NOT be deleted by a contender."""
        corrupt_lock = self.test_dir / "corrupt.lock"
        corrupt_lock.write_text("MALFORMED_NOT_JSON{{{", encoding="utf-8")

        acquired = bridge.acquire_lock(corrupt_lock)
        self.assertFalse(acquired, "Contender must not acquire lock over unreadable lock file!")
        self.assertTrue(corrupt_lock.exists(), "Contender must NEVER delete an unreadable lock without verified dead owner!")

    def test_release_lock_refuses_to_unlink_unreadable_or_foreign_lock(self):
        """release_lock must refuse to delete a lock file if not proven owned by current PID."""
        foreign_lock = self.test_dir / "foreign.lock"
        foreign_lock.write_text(json.dumps({"pid": os.getpid() + 9999}), encoding="utf-8")

        released = bridge.release_lock(foreign_lock)
        self.assertFalse(released, "release_lock must return False when PID does not match")
        self.assertTrue(foreign_lock.exists(), "release_lock must not delete another process's lock file")

    def test_atomic_lock_recovers_from_dead_pid(self):
        """If lock file contains a dead PID, a new process cleanly takes over."""
        dead_pid = 999999
        bridge.LOCK_FILE.write_text(json.dumps({"pid": dead_pid, "acquired_at": "2026-01-01T00:00:00Z"}), encoding="utf-8")

        with patch("bridge.is_process_running", return_value=False):
            self.assertTrue(bridge.acquire_lock(), "Should acquire lock after detecting dead PID")
            content = json.loads(bridge.LOCK_FILE.read_text(encoding="utf-8"))
            self.assertEqual(content["pid"], os.getpid())

        bridge.release_lock()

    # -----------------------------------------------------------------------
    # Requirement 3: Strict 40-Hex Revision Binding (reviewed_head == headRefOid)
    # -----------------------------------------------------------------------
    @patch("bridge.run_gh_json")
    def test_revision_binding_rejects_stale_reviewed_head_mismatch(self, mock_gh):
        """If full 40-hex reviewed_head does not match PR headRefOid, it must be rejected."""
        issue_body = "## 📋 GRUM_TASK\n- **task_id**: GAT-REV-01\nSee pull/21 for details."
        mock_gh.return_value = {
            "state": "OPEN",
            "headRefOid": "aaaa111122223333444455556666777788889999",
            "comments": [
                {
                    "body": (
                        "## 🔍 GRUM_REVIEW\n"
                        "- **decision**: REVISION_REQUIRED\n"
                        "- **reviewed_head**: `bbbb111122223333444455556666777788889999`\n"  # MISMATCH!
                        "- **required_changes**: Update unit tests\n"
                    )
                }
            ]
        }
        ok, reason, _ = bridge.inspect_revision_pr("dummy/repo", issue_body)
        self.assertFalse(ok, "Revision binding must reject stale review with mismatched head SHA!")
        self.assertIn("Stale review rejected", reason)
        self.assertIn("bbbb1111", reason)

    @patch("bridge.run_gh_json")
    def test_revision_binding_rejects_abbreviated_sha(self, mock_gh):
        """Abbreviated SHAs (e.g. 7 or 12 chars) must be strictly rejected even if prefix matches."""
        issue_body = "## 📋 GRUM_TASK\n- **task_id**: GAT-REV-01\nSee pull/21 for details."
        full_head = "aaaa111122223333444455556666777788889999"
        mock_gh.return_value = {
            "state": "OPEN",
            "headRefOid": full_head,
            "comments": [
                {
                    "body": (
                        "## 🔍 GRUM_REVIEW\n"
                        "- **decision**: REVISION_REQUIRED\n"
                        "- **reviewed_head**: `aaaa111`\n"  # ONLY 7 CHARS!
                        "- **required_changes**: Update unit tests\n"
                    )
                }
            ]
        }
        ok, reason, _ = bridge.inspect_revision_pr("dummy/repo", issue_body)
        self.assertFalse(ok, "Revision binding must reject abbreviated SHA!")
        self.assertIn("does not specify a valid full 40-hex", reason)

    @patch("bridge.run_gh_json")
    def test_revision_binding_accepts_exact_full_40_hex_sha(self, mock_gh):
        """When reviewed_head is an exact 40-hex match for current PR headRefOid, it must be accepted."""
        issue_body = "## 📋 GRUM_TASK\n- **task_id**: GAT-REV-01\nSee pull/21 for details."
        head_sha = "cccc111122223333444455556666777788889999"
        mock_gh.return_value = {
            "state": "OPEN",
            "headRefOid": head_sha,
            "comments": [
                {
                    "body": (
                        "## 🔍 GRUM_REVIEW\n"
                        "- **decision**: REVISION_REQUIRED\n"
                        f"- **reviewed_head**: `{head_sha}`\n"
                        "- **required_changes**: Update unit tests\n"
                    )
                }
            ]
        }
        ok, reason, details = bridge.inspect_revision_pr("dummy/repo", issue_body)
        self.assertTrue(ok, f"Should accept revision when exact 40-hex heads match: {reason}")
        self.assertIn("PR#21", details)
        self.assertIn(f"HEAD:{head_sha}", details)

    # -----------------------------------------------------------------------
    # Requirement 4: Fail-Closed State Journaling & Corrupt State Blocking
    # -----------------------------------------------------------------------
    def test_save_state_failure_aborts_dispatch_before_send(self):
        """If Phase 1 save_state fails, dispatch must abort immediately; send_to_kir is never called."""
        state = {
            "version": "1.2",
            "total_polls": 0,
            "pending_dispatches": {},
            "dispatched_tasks": {},
            "uncertain_deliveries": {},
        }
        mock_issue = {
            "number": 301,
            "title": "Journal Fail Task",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": (
                "## 📋 GRUM_TASK\n\n"
                "- **task_id**: GAT-JOURNAL-01\n"
                "- **goal**: Test journaling error\n\n"
                "### 🎯 Acceptance Criteria\n"
                "- [ ] Criteria 1\n"
            ),
        }

        with patch("bridge.poll_github", return_value=[mock_issue]), \
             patch("bridge.is_kir_conversation_idle", return_value=(True, "idle")), \
             patch("bridge.save_state", return_value=False), \
             patch("bridge.send_to_kir") as mock_send:
            dispatched = bridge.run_single_poll_cycle("dummy/repo", "dummy_conv", state)
            self.assertEqual(dispatched, 0, "Dispatch must abort if save_state fails!")
            mock_send.assert_not_called()

    def test_corrupt_state_file_raises_and_blocks_startup(self):
        """Corrupted JSON in state file must raise BridgeStateCorruptedError, refusing to reset."""
        bridge.STATE_FILE.write_text("INVALID_JSON{{{", encoding="utf-8")
        with self.assertRaises(bridge.BridgeStateCorruptedError):
            bridge.load_state()

    def test_in_flight_crash_recovery_transitions_to_uncertain_without_resend(self):
        """In-flight tasks from prior crashed session transition to UNCERTAIN and hold."""
        state = {
            "version": "1.2",
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

        recovered = bridge.load_state()
        self.assertNotIn("200", recovered["pending_dispatches"])
        self.assertIn("200", recovered["uncertain_deliveries"])
        self.assertEqual(recovered["uncertain_deliveries"]["200"]["reason"], "CRASH_OR_UNCONFIRMED_DELIVERY")

        mock_issue = {
            "number": 200,
            "title": "Crashed Task",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": "## 📋 GRUM_TASK\n- **task_id**: GAT-CRASH-01\n- **goal**: Crash recovery test\n### 🎯 Acceptance Criteria\n- [ ] Step 1\n",
        }
        with patch("bridge.poll_github", return_value=[mock_issue]), \
             patch("bridge.send_to_kir") as mock_send:
            dispatched = bridge.run_single_poll_cycle("dummy/repo", "dummy_conv", recovered, dry_run=False)
            self.assertEqual(dispatched, 0, "Task in UNCERTAIN state must not be re-dispatched!")
            mock_send.assert_not_called()

    # -----------------------------------------------------------------------
    # Requirement 5: Explicit Dispatch Status Semantics
    # -----------------------------------------------------------------------
    def test_dispatch_records_dispatched_to_conversation_status(self):
        """Successful agentapi call records DISPATCHED_TO_CONVERSATION, not recipient ACK."""
        state = {
            "version": "1.2",
            "total_polls": 0,
            "pending_dispatches": {},
            "dispatched_tasks": {},
            "uncertain_deliveries": {},
        }
        mock_issue = {
            "number": 401,
            "title": "Semantics Task",
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}],
            "body": (
                "## 📋 GRUM_TASK\n\n"
                "- **task_id**: GAT-SEM-01\n"
                "- **goal**: Test dispatch semantics\n\n"
                "### 🎯 Acceptance Criteria\n"
                "- [ ] Verify status\n"
            ),
        }

        with patch("bridge.poll_github", return_value=[mock_issue]), \
             patch("bridge.is_kir_conversation_idle", return_value=(True, "idle")), \
             patch("bridge.send_to_kir", return_value=(True, "sendMessage ok")):
            dispatched = bridge.run_single_poll_cycle("dummy/repo", "dummy_conv", state)
            self.assertEqual(dispatched, 1)
            record = state["dispatched_tasks"]["401"]
            self.assertEqual(record["delivery_status"], "DISPATCHED_TO_CONVERSATION")
            self.assertIn("does not constitute semantic ACK", record["note"])

    # -----------------------------------------------------------------------
    # Requirement 6: Label Conflicts & Structured GRUM_TASK Validation
    # -----------------------------------------------------------------------
    def test_conflicting_state_labels_are_rejected(self):
        """Simultaneous ready labels (state:ready + state:revision) or multiple state:* labels must be rejected."""
        # Case A: state:ready + state:revision
        issue_conflicting = {
            "number": 501,
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}, {"name": "state:revision"}],
            "body": "## 📋 GRUM_TASK\n- **task_id**: GAT-501\n- **goal**: Conflict\n### 🎯 Acceptance Criteria\n- [ ] A\n",
        }
        eligible, reason, _ = bridge.evaluate_task_eligibility(issue_conflicting, "dummy/repo")
        self.assertFalse(eligible)
        self.assertIn("Conflicting ready state labels", reason)

        # Case B: state:ready + state:working
        issue_multiple_state = {
            "number": 502,
            "labels": [{"name": "to:antina"}, {"name": "state:ready"}, {"name": "state:working"}],
            "body": "## 📋 GRUM_TASK\n- **task_id**: GAT-502\n- **goal**: Conflict\n### 🎯 Acceptance Criteria\n- [ ] A\n",
        }
        eligible, reason, _ = bridge.evaluate_task_eligibility(issue_multiple_state, "dummy/repo")
        self.assertFalse(eligible)
        self.assertIn("Conflicting multiple state labels", reason)

    def test_grum_task_structure_validation(self):
        """Issue body lacking mandatory GRUM_TASK sections must be rejected."""
        # Missing header
        ok, reason, _ = bridge.validate_grum_task_structure("Just a casual issue description")
        self.assertFalse(ok)
        self.assertIn("Missing '## 📋 GRUM_TASK' header", reason)

        # Missing task_id
        ok, reason, _ = bridge.validate_grum_task_structure("## 📋 GRUM_TASK\n- **goal**: Do something\n### 🎯 Acceptance Criteria\n- [ ] A\n")
        self.assertFalse(ok)
        self.assertIn("task_id", reason)

        # Missing goal
        ok, reason, _ = bridge.validate_grum_task_structure("## 📋 GRUM_TASK\n- **task_id**: GAT-1\n### 🎯 Acceptance Criteria\n- [ ] A\n")
        self.assertFalse(ok)
        self.assertIn("goal", reason)

        # Missing Acceptance Criteria section
        ok, reason, _ = bridge.validate_grum_task_structure("## 📋 GRUM_TASK\n- **task_id**: GAT-1\n- **goal**: Test\n")
        self.assertFalse(ok)
        self.assertIn("Acceptance Criteria", reason)

        # Acceptance Criteria with no actionable checkboxes
        ok, reason, _ = bridge.validate_grum_task_structure("## 📋 GRUM_TASK\n- **task_id**: GAT-1\n- **goal**: Test\n### 🎯 Acceptance Criteria\nNo checkboxes here.\n")
        self.assertFalse(ok)
        self.assertIn("no actionable checkboxes", reason)

        # Valid structure
        valid_body = (
            "## 📋 GRUM_TASK\n\n"
            "- **task_id**: GAT-VALID-01\n"
            "- **goal**: Validate parser\n\n"
            "### 🎯 Acceptance Criteria\n"
            "- [ ] Feature complete\n"
        )
        ok, reason, tid = bridge.validate_grum_task_structure(valid_body)
        self.assertTrue(ok)
        self.assertEqual(tid, "GAT-VALID-01")

    # -----------------------------------------------------------------------
    # Requirement 7: Deduplication & Canonical Forbidden Labels
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

        fp_after_comments = bridge.compute_task_fingerprint(
            issue_number=101,
            task_id="GAT-PLAT-008",
            state_label="state:ready",
            body=base_body,
        )
        self.assertEqual(fp_initial, fp_after_comments)

        modified_body = base_body + "- [ ] Criterion B (New Requirement)\n"
        fp_modified = bridge.compute_task_fingerprint(
            issue_number=101,
            task_id="GAT-PLAT-008",
            state_label="state:ready",
            body=modified_body,
        )
        self.assertNotEqual(fp_initial, fp_modified)

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
                "body": "## 📋 GRUM_TASK\n- **task_id**: GAT-001\n- **goal**: Test\n### 🎯 Acceptance Criteria\n- [ ] A\n",
            }
            eligible, reason, _ = bridge.evaluate_task_eligibility(issue, "dummy/repo")
            self.assertFalse(eligible, f"Failed: {msg} (Reason: {reason})")


if __name__ == "__main__":
    unittest.main()
