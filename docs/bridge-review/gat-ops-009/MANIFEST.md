# GAT-OPS-009 Bridge Hardening Manifest & Test Audit (Revision 2)

- **task_id**: `GAT-OPS-009`
- **created_at**: `2026-09-29T02:00:00Z` (`2026-09-29T09:00:00+07:00`)
- **operator**: Andy (`ad48730f-1b19-4347-a976-d3fe45d0c4e3`)
- **branch**: `fix/gat-ops-009-bridge-hardening`
- **tracking_issue**: [#30](https://github.com/Kiris-02/gathermap/issues/30)
- **related_issues**: [#24](https://github.com/Kiris-02/gathermap/issues/24), [#27](https://github.com/Kiris-02/gathermap/issues/27), [PR #29](https://github.com/Kiris-02/gathermap/pull/29), [PR #31](https://github.com/Kiris-02/gathermap/pull/31)
- **antigravity_version**: `2.17.0.0` (CL `986210228`)
- **target_conversation**: `6a86133d-899c-4702-a836-3a56a0127e9d` (Kir)

---

## 1. Hardened Artifact Inventory

All files in this review directory adhere to strict Unix line endings (LF, `\n`) and contain zero credentials or private session data.

| File | SHA-256 Checksum | Bytes | Lines | Line Endings | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`bridge.py`](bridge.py) | `b8d7c602521d86c0ed910c34bd4b742f74f13c047b8c6a4f60c2b019c983115c` | 33,968 | 812 | LF | Hardened local daemon with fail-closed idle, atomic lock, safe contender behavior, strict 40-hex revision binding, fail-closed journaling, explicit delivery status, and structured task validation |
| [`sidecar.json`](sidecar.json) | `5f356c5e56a4be13b4d96046765b9a90bd6d03727075dc9c02ba8109f91252e1` | 200 | 6 | LF | Antigravity 2.0 sidecar registration specification (`restart_policy: always`) |
| [`test_bridge.py`](test_bridge.py) | `bf2a0d5d1ad67b8c0f1fc75ccce25b8319058dccede6c851d6afd104088217ce` | 24,829 | 514 | LF | 21-test automated regression suite covering all Grum review findings, contender safety, and platform safety guarantees |

---

## 2. Hardening Matrix & Test Audit

Every defect identified in Grum's reviews has been addressed at the root architectural layer and verified by automated regression tests:

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

### Finding 2: Non-Atomic Lock, Partial Unlinking & Concurrent Races
- **Defect**: Initial atomic creation wrote an empty file before writing JSON. A contender saw an empty/unreadable file, caught a JSON parse error, treated it as a stale lock, unlinked it, and acquired a second lock. `release_lock` also unlinked unreadable files without proving PID ownership.
- **Fix**:
  - Atomic creation writes the payload immediately (`os.write(fd, payload)` before `os.close(fd)`).
  - Contenders reading a lock file retry up to 5 times (100ms) to allow in-flight writes to settle.
  - **Crucial Invariant**: If a lock file is partial, empty, or unreadable, a contender **NEVER** removes it. It logs that owner death cannot be verified and fails closed (`return False`).
  - Stale lock removal occurs **only** when JSON parses successfully, contains a valid PID, and `is_process_running(pid)` explicitly confirms the owner is dead.
  - `release_lock` requires JSON to parse and strictly match `data.get("pid") == os.getpid()`; foreign or unreadable locks are never unlinked.
- **Test Coverage**:
  - `test_atomic_lock_single_process_and_clean_release`: **PASS** (basic acquisition and release).
  - `test_atomic_lock_concurrent_multiprocess_race`: **PASS** (spawns 6 real OS processes racing for `race.lock`; asserts exactly 1 process acquires the lock, 5 fail, and winner cleanly releases).
  - `test_atomic_lock_rejects_unreadable_or_partial_lock_without_deleting`: **PASS** (asserts contender refuses to delete unreadable lock and fails closed).
  - `test_release_lock_refuses_to_unlink_unreadable_or_foreign_lock`: **PASS** (asserts release refuses to delete unproven locks).
  - `test_atomic_lock_recovers_from_dead_pid`: **PASS** (verified dead PID is safely taken over).

### Finding 3: Strict 40-Hex Revision Head Binding
- **Defect**: Revision review parsed 7–40 hex characters and compared via `startswith`, accepting abbreviated SHAs and prefix matches.
- **Fix**:
  - Regex requires exactly 40 hex characters: `r"-\s*\*\*reviewed_head\*\*:\s*`?([a-f0-9]{40})`?(?![a-f0-9])"`.
  - Enforces exact string equality: `reviewed_head == head_ref_oid`.
  - Rejects abbreviated SHAs (e.g. 7 or 12 chars) with `does not specify a valid full 40-hex`.
  - Rejects 40-char SHA mismatches with `Stale review rejected`.
- **Test Coverage**:
  - `test_revision_binding_rejects_abbreviated_sha`: **PASS** (rejects 7-char matching prefix).
  - `test_revision_binding_rejects_stale_reviewed_head_mismatch`: **PASS** (rejects full 40-hex mismatch).
  - `test_revision_binding_accepts_exact_full_40_hex_sha`: **PASS** (accepts exact 40-hex match).

### Finding 4: Swallowed Journaling Errors & Corrupted State Reset
- **Defect**: `save_state` swallowed exceptions; poller proceeded to dispatch unjournaled tasks. Corrupted state files silently reset to default empty state.
- **Fix**:
  - `save_state` returns `bool`.
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

Executed locally via `python -m unittest -v docs/bridge-review/gat-ops-009/test_bridge.py`:

```text
test_atomic_lock_concurrent_multiprocess_race (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_atomic_lock_concurrent_multiprocess_race) ... ok
test_atomic_lock_recovers_from_dead_pid (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_atomic_lock_recovers_from_dead_pid) ... ok
test_atomic_lock_rejects_unreadable_or_partial_lock_without_deleting (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_atomic_lock_rejects_unreadable_or_partial_lock_without_deleting) ... ok
test_atomic_lock_single_process_and_clean_release (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_atomic_lock_single_process_and_clean_release) ... ok
test_canonical_and_forbidden_labels_are_blocked (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_canonical_and_forbidden_labels_are_blocked) ... ok
test_conflicting_state_labels_are_rejected (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_conflicting_state_labels_are_rejected) ... ok
test_corrupt_state_file_raises_and_blocks_startup (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_corrupt_state_file_raises_and_blocks_startup) ... ok
test_deduplication_ignores_unrelated_metadata_and_detects_body_change (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_deduplication_ignores_unrelated_metadata_and_detects_body_change) ... ok
test_dispatch_records_dispatched_to_conversation_status (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_dispatch_records_dispatched_to_conversation_status) ... ok
test_grum_task_structure_validation (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_grum_task_structure_validation) ... ok
test_idle_check_fails_closed_on_empty_steps_table (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_idle_check_fails_closed_on_empty_steps_table) ... ok
test_idle_check_fails_closed_on_missing_db (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_idle_check_fails_closed_on_missing_db) ... ok
test_idle_check_fails_closed_when_active_step_running (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_idle_check_fails_closed_when_active_step_running) ... ok
test_idle_check_fails_closed_when_undelivered_queue_has_messages (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_idle_check_fails_closed_when_undelivered_queue_has_messages) ... ok
test_idle_check_succeeds_only_when_done_and_no_undelivered_messages (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_idle_check_succeeds_only_when_done_and_no_undelivered_messages) ... ok
test_in_flight_crash_recovery_transitions_to_uncertain_without_resend (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_in_flight_crash_recovery_transitions_to_uncertain_without_resend) ... ok
test_release_lock_refuses_to_unlink_unreadable_or_foreign_lock (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_release_lock_refuses_to_unlink_unreadable_or_foreign_lock) ... ok
test_revision_binding_accepts_exact_full_40_hex_sha (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_revision_binding_accepts_exact_full_40_hex_sha) ... ok
test_revision_binding_rejects_abbreviated_sha (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_revision_binding_rejects_abbreviated_sha) ... ok
test_revision_binding_rejects_stale_reviewed_head_mismatch (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_revision_binding_rejects_stale_reviewed_head_mismatch) ... ok
test_save_state_failure_aborts_dispatch_before_send (docs.bridge-review.gat-ops-009.test_bridge.TestBridgeHardening.test_save_state_failure_aborts_dispatch_before_send) ... ok

----------------------------------------------------------------------
Ran 21 tests in 1.060s

OK
```

---

## 4. GitHub Actions CI Integration

- **Workflow File**: `.github/workflows/platform-guardrails.yml`
- **Trigger**: Configured to run on `pull_request` when `docs/bridge-review/**` paths are modified.
- **Execution Step**: Added `Run bridge regression tests` step executing `python -m unittest -v docs/bridge-review/gat-ops-009/test_bridge.py`.
- **Reproducibility**: Guarantees that every PR commit modifying bridge review assets produces an independent, verifiable GitHub Actions run for the complete bridge test suite.
