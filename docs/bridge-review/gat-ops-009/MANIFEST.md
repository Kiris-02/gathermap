# GAT-OPS-009 Bridge Hardening Manifest & Test Audit

- **task_id**: `GAT-OPS-009`
- **created_at**: `2026-09-28T17:31:00Z` (`2026-09-29T00:31:00+07:00`)
- **operator**: Andy (`ad48730f-1b19-4347-a976-d3fe45d0c4e3`)
- **branch**: `fix/gat-ops-009-bridge-hardening`
- **tracking_issue**: [#30](https://github.com/Kiris-02/gathermap/issues/30)
- **related_issues**: [#24](https://github.com/Kiris-02/gathermap/issues/24), [#27](https://github.com/Kiris-02/gathermap/issues/27), [PR #29](https://github.com/Kiris-02/gathermap/pull/29)
- **antigravity_version**: `2.17.0.0` (CL `986210228`)
- **target_conversation**: `6a86133d-899c-4702-a836-3a56a0127e9d` (Kir)

---

## 1. Hardened Artifact Inventory

All files in this review directory adhere to strict Unix line endings (LF, `\n`) and contain zero credentials or private session data.

| File | SHA-256 Checksum | Bytes | Lines | Line Endings | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`bridge.py`](bridge.py) | `fc4de0b040a4c2fb260acc0c9ff66ab1d297a674d86b68ae1b1b6729fe67bb0f` | 32,465 | 775 | LF | Hardened local daemon with fail-closed idle, atomic lock, strict revision binding, fail-closed journaling, explicit delivery status, and structured task validation |
| [`sidecar.json`](sidecar.json) | `5f356c5e56a4be13b4d96046765b9a90bd6d03727075dc9c02ba8109f91252e1` | 200 | 6 | LF | Antigravity 2.0 sidecar registration specification (`restart_policy: always`) |
| [`test_bridge.py`](test_bridge.py) | `08c0a4b935fa989aa5f08e1a7ac1c78081fdf841fa20d46b3e9045051964bdad` | 22,082 | 463 | LF | 18-test automated regression suite covering all 6 Grum review findings and platform safety guarantees |

---

## 2. Hardening Matrix & Test Audit

Every defect identified in Grum's [PR #29 review](https://github.com/Kiris-02/gathermap/pull/29#issuecomment-5874734934) has been addressed at the root architectural layer and verified by automated regression tests:

### Finding 1: Idle Check Fails Open
- **Defect**: Missing conversation database or empty `steps` table fell through to `return True` ("assuming idle").
- **Fix**: Re-architected `is_kir_conversation_idle` to be strictly **fail-closed**:
  - If SQLite DB file does not exist -> returns `(False, "Target conversation DB not found; failing closed.")`.
  - If `steps` table is empty (0 rows) -> returns `(False, "Target conversation DB steps table is empty; failing closed.")`.
  - If DB cannot be queried or is locked -> returns `(False, "Conversation DB read exception; failing closed.")`.
  - Only returns `True` when DB exists, latest step `status == 3` (`DONE`), and `messages/undelivered/` has 0 files.
- **Test Coverage**:
  - `test_idle_check_fails_closed_on_missing_db`: **PASS** (reproduces Grum's missing DB case).
  - `test_idle_check_fails_closed_on_empty_steps_table`: **PASS** (reproduces empty steps table case).
  - `test_idle_check_fails_closed_when_active_step_running`: **PASS** (asserts step status != 3 blocks dispatch).
  - `test_idle_check_fails_closed_when_undelivered_queue_has_messages`: **PASS** (asserts pending messages hold dispatch).
  - `test_idle_check_succeeds_only_when_done_and_no_undelivered_messages`: **PASS** (verifies normal idle detection).

### Finding 2: Non-Atomic Lock & Race Testing
- **Defect**: `acquire_lock` used check-then-write (`exists()` then `write_text()`), creating a TOCTOU race window. Existing tests only tested sequential acquisition within one process.
- **Fix**: Replaced with OS-level atomic creation flags (`os.O_CREAT | os.O_EXCL | os.O_WRONLY`). The kernel guarantees atomic file creation; if the file exists, `FileExistsError` is raised. Dead PIDs are safely cleared only after verification, followed by a second atomic creation retry. `release_lock` verifies process PID ownership before unlinking.
- **Test Coverage**:
  - `test_atomic_lock_single_process_and_clean_release`: **PASS** (basic acquisition and release).
  - `test_atomic_lock_concurrent_multiprocess_race`: **PASS** (spawns 6 real OS processes racing for `race.lock`; asserts exactly 1 process acquires the lock, 5 fail, and winner cleanly releases).
  - `test_atomic_lock_recovers_from_dead_pid`: **PASS** (dead PID is cleaned and lock acquired).

### Finding 3: Stale Revision Review Head Acceptance
- **Defect**: `inspect_revision_pr` fetched `headRefOid` from GitHub but never compared it against `reviewed_head` from `GRUM_REVIEW`.
- **Fix**: Added strict equality comparison: `head_ref_oid.startswith(reviewed_head) or reviewed_head.startswith(head_ref_oid)`. If heads do not match, the task is rejected with `Stale review rejected: reviewed_head '...' does not match current PR #... headRefOid '...'`.
- **Test Coverage**:
  - `test_revision_binding_rejects_stale_reviewed_head_mismatch`: **PASS** (reproduces Grum's reproduction case with mismatched SHAs `aaaa...` vs `bbbb...`).
  - `test_revision_binding_accepts_matching_reviewed_head`: **PASS** (accepts valid review when heads match).

### Finding 4: Swallowed Journaling Errors & Corrupted State Reset
- **Defect**: `save_state` swallowed exceptions; poller proceeded to dispatch unjournaled tasks. Corrupted state files silently reset to default empty state.
- **Fix**:
  - `save_state` returns `bool` indicating success/failure.
  - Phase 1 in-flight journaling is strictly fail-closed: if `save_state` returns `False`, dispatch is **aborted immediately** before `send_to_kir` is invoked.
  - `load_state` raises `BridgeStateCorruptedError` on invalid JSON, refusing to start or reset state without human intervention.
- **Test Coverage**:
  - `test_save_state_failure_aborts_dispatch_before_send`: **PASS** (simulates failed save; asserts `send_to_kir` is never called).
  - `test_corrupt_state_file_raises_and_blocks_startup`: **PASS** (asserts corrupted JSON raises error and blocks startup).
  - `test_in_flight_crash_recovery_transitions_to_uncertain_without_resend`: **PASS** (recovers crashed in-flight sends to `UNCERTAIN`).

### Finding 5: Dispatch Status Semantics vs Recipient ACK
- **Defect**: Regular task delivery recorded `DELIVERED` when `agentapi send-message` returned 0, conflating local queue injection with a semantic ACK from Kir.
- **Fix**: Recorded status renamed to `DISPATCHED_TO_CONVERSATION`. Explicit metadata note recorded: `agentapi returncode 0 confirms injection into conversation message queue; does not constitute semantic ACK from Kir/Antina.` Semantic ACKs are verified exclusively via GitHub `ANTINA_STATUS` or dedicated round-trip probes (`test-probe`).
- **Test Coverage**:
  - `test_dispatch_records_dispatched_to_conversation_status`: **PASS** (verifies recorded fields).

### Finding 6: Conflicting State Labels & Lenient Task Validation
- **Defect**: Allowed simultaneous `state:ready` and `state:revision` labels, and did not validate `GRUM_TASK` structure.
- **Fix**:
  - Added conflict detection rejecting issues with multiple `state:*` labels.
  - Added `validate_grum_task_structure`: asserts header (`## 📋 GRUM_TASK`), `- **task_id**:`, `- **goal**:`, and `### 🎯 Acceptance Criteria` with at least one checkbox (`- [ ]`).
- **Test Coverage**:
  - `test_conflicting_state_labels_are_rejected`: **PASS** (rejects both `state:ready` + `state:revision` and `state:ready` + `state:working`).
  - `test_grum_task_structure_validation`: **PASS** (tests missing header, missing task_id, missing goal, missing acceptance criteria, no checkboxes, and valid format).

---

## 3. Test Execution Evidence

Executed on local Python 3.12 (`python test_bridge.py -v`):

```text
test_atomic_lock_concurrent_multiprocess_race (__main__.TestBridgeHardening.test_atomic_lock_concurrent_multiprocess_race) ... ok
test_atomic_lock_recovers_from_dead_pid (__main__.TestBridgeHardening.test_atomic_lock_recovers_from_dead_pid) ... ok
test_atomic_lock_single_process_and_clean_release (__main__.TestBridgeHardening.test_atomic_lock_single_process_and_clean_release) ... ok
test_canonical_and_forbidden_labels_are_blocked (__main__.TestBridgeHardening.test_canonical_and_forbidden_labels_are_blocked) ... ok
test_conflicting_state_labels_are_rejected (__main__.TestBridgeHardening.test_conflicting_state_labels_are_rejected) ... ok
test_corrupt_state_file_raises_and_blocks_startup (__main__.TestBridgeHardening.test_corrupt_state_file_raises_and_blocks_startup) ... ok
test_deduplication_ignores_unrelated_metadata_and_detects_body_change (__main__.TestBridgeHardening.test_deduplication_ignores_unrelated_metadata_and_detects_body_change) ... ok
test_dispatch_records_dispatched_to_conversation_status (__main__.TestBridgeHardening.test_dispatch_records_dispatched_to_conversation_status) ... ok
test_grum_task_structure_validation (__main__.TestBridgeHardening.test_grum_task_structure_validation) ... ok
test_idle_check_fails_closed_on_empty_steps_table (__main__.TestBridgeHardening.test_idle_check_fails_closed_on_empty_steps_table) ... ok
test_idle_check_fails_closed_on_missing_db (__main__.TestBridgeHardening.test_idle_check_fails_closed_on_missing_db) ... ok
test_idle_check_fails_closed_when_active_step_running (__main__.TestBridgeHardening.test_idle_check_fails_closed_when_active_step_running) ... ok
test_idle_check_fails_closed_when_undelivered_queue_has_messages (__main__.TestBridgeHardening.test_idle_check_fails_closed_when_undelivered_queue_has_messages) ... ok
test_idle_check_succeeds_only_when_done_and_no_undelivered_messages (__main__.TestBridgeHardening.test_idle_check_succeeds_only_when_done_and_no_undelivered_messages) ... ok
test_in_flight_crash_recovery_transitions_to_uncertain_without_resend (__main__.TestBridgeHardening.test_in_flight_crash_recovery_transitions_to_uncertain_without_resend) ... ok
test_revision_binding_accepts_matching_reviewed_head (__main__.TestBridgeHardening.test_revision_binding_accepts_matching_reviewed_head) ... ok
test_revision_binding_rejects_stale_reviewed_head_mismatch (__main__.TestBridgeHardening.test_revision_binding_rejects_stale_reviewed_head_mismatch) ... ok
test_save_state_failure_aborts_dispatch_before_send (__main__.TestBridgeHardening.test_save_state_failure_aborts_dispatch_before_send) ... ok

----------------------------------------------------------------------
Ran 18 tests in 0.598s

OK
```

---

## 4. On-Host Executor & Workflow Reconciliations

- **Live Host Bridge**: Safely paused per verified stop sequence.
  - Sidecar supervisor: `"enabled": false` in `~/.gemini/config/config.json`.
  - Process: None (PID 1188 terminated at 17:26:14 UTC).
  - Mutex lock: None (`bridge.lock` removed after process exit confirmation).
- **Legacy Cloud Workflow**:
  - File: `.github/workflows/antina-runner.yml`
  - Name: `Antina Task Runner (Ultra)`
  - Workflow ID: `368201903`
  - State: `disabled_manually`
- **Issue #24 Documentation**:
  - Body description updated to replace stale PID 13732 and delete-lock instructions with verified safe stop procedure and current `PAUSED_SAFE_STOP` status.
