# Manifest: Temporary GitHub → Kir Local Bridge Snapshot (`GAT-OPS-008`)

- **task_id**: `GAT-OPS-008`
- **capture_timestamp_utc**: `2026-09-28T16:27:50Z`
- **operator**: Andy (conversation `ad48730f-1b19-4347-a976-d3fe45d0c4e3`)
- **target_conversation**: Kir (`6a86133d-899c-4702-a836-3a56a0127e9d`)
- **host_environment**: Windows 11, Antigravity 2.0 (Product/File version `2.17.0.0`, Language Server CL `986210228` built 2026-09-23)
- **host_source_path**: `C:\Users\HN\.gemini\config\sidecars\github-kir-bridge\`
- **repository_snapshot_path**: `docs/bridge-review/gat-ops-008/`

---

## 1. File Inventory & Cryptographic Hashes

All three approved bridge source files were captured byte-for-byte from the local Antigravity sidecar directory into this snapshot directory. No broader system configurations, private conversation databases, delivery caches, runtime logs, or lock files are included.

| File | Byte Count | Line Count | Line Endings | Host Original SHA-256 | Snapshot SHA-256 | Redaction Status |
| :--- | :---: | :---: | :---: | :--- | :--- | :--- |
| `bridge.py` | 26,283 | 654 | LF (0 CRLF) | `a1d19478b053e99eb66a33c14dc34dfbf8e98dce4c687247788cb51b782bd273` | `a1d19478b053e99eb66a33c14dc34dfbf8e98dce4c687247788cb51b782bd273` | None (0 credentials found; unredacted byte-identical) |
| `sidecar.json` | 200 | 6 | LF (0 CRLF) | `5f356c5e56a4be13b4d96046765b9a90bd6d03727075dc9c02ba8109f91252e1` | `5f356c5e56a4be13b4d96046765b9a90bd6d03727075dc9c02ba8109f91252e1` | None (0 credentials found; unredacted byte-identical) |
| `test_bridge.py` | 9,252 | 206 | LF (0 CRLF) | `ab3b0a2bda4f920adc4879e0498940e43833451a46e687f8120adcc9370ec408` | `ab3b0a2bda4f920adc4879e0498940e43833451a46e687f8120adcc9370ec408` | None (0 credentials found; unredacted byte-identical) |

*Audit Verification*: Hashes were re-verified after copy; originals on the host have not changed between capture and snapshot publication.

---

## 2. Automated Test Suite Execution & Mocking Map

Sanitized execution output from running the standalone regression test suite on the host (`python test_bridge.py -v`):

```text
test_canonical_and_forbidden_labels_are_blocked (__main__.TestBridgeHardening.test_canonical_and_forbidden_labels_are_blocked) ... ok
test_deduplication_ignores_unrelated_metadata_and_detects_body_change (__main__.TestBridgeHardening.test_deduplication_ignores_unrelated_metadata_and_detects_body_change) ... ok
test_in_flight_crash_recovery_transitions_to_uncertain_without_resend (__main__.TestBridgeHardening.test_in_flight_crash_recovery_transitions_to_uncertain_without_resend) ... [2026-09-28T15:41:46.081720+00:00] [RECOVERY] In-flight dispatch detected for Issue #200 (GAT-CRASH-01) from crashed session. Transitioning to UNCERTAIN.
[2026-09-28T15:41:46.085440+00:00] [POLL #1] Polling dummy/repo for eligible GRUM_TASKs...
[2026-09-28T15:41:46.085964+00:00] [POLL] Found 1 eligible task(s) among 1 open issue(s).
[2026-09-28T15:41:46.085964+00:00] [HOLD] Task GAT-CRASH-01 (Issue #200) is in UNCERTAIN state (CRASH_OR_UNCONFIRMED_DELIVERY). Holding dispatch.
ok
test_revision_binding_accepts_only_revision_required (__main__.TestBridgeHardening.test_revision_binding_accepts_only_revision_required) ... ok
test_single_instance_lock_and_clean_release (__main__.TestBridgeHardening.test_single_instance_lock_and_clean_release) ... [2026-09-28T15:41:46.190808+00:00] [LOCK] Active bridge instance already running with PID 15012.
[2026-09-28T15:41:46.191820+00:00] [LOCK] Lock file released cleanly.
ok

----------------------------------------------------------------------
Ran 5 tests in 0.115s

OK
```

### Real Implementation vs. Mocked Dependencies

| Test Case | Real Functions Exercised | Mocked Dependencies | Purpose & Scope |
| :--- | :--- | :--- | :--- |
| `test_deduplication_ignores_unrelated_metadata_and_detects_body_change` | `compute_task_fingerprint()`, `normalize_body()` | None (100% real implementation) | Proves `updatedAt` / timestamps do not affect hash; proves body edits change hash. |
| `test_canonical_and_forbidden_labels_are_blocked` | `evaluate_task_eligibility()`, `CANONICAL_FORBIDDEN_LABELS` | None (100% real implementation) | Asserts `needs:kiris`, `needs_kiris`, `to:grum`, `state:review`, `state:done`, `state:blocked`, `human:escalation` are blocked. |
| `test_revision_binding_accepts_only_revision_required` | `inspect_revision_pr()` (regex parsing of `decision`, `reviewed_head`, `required_changes`) | `bridge.run_gh_json` (mocked PR comments) | Asserts `ACCEPT` and `NEEDS_KIRIS` reviews are rejected; only `REVISION_REQUIRED` with valid SHA and changes passes. |
| `test_in_flight_crash_recovery_transitions_to_uncertain_without_resend` | `load_state()`, `save_state()`, `run_single_poll_cycle()` | `bridge.poll_github`, `bridge.send_to_kir` (mocked to prevent external dispatch) | Verifies in-flight crash journals move to `UNCERTAIN` and do NOT re-dispatch on poll. |
| `test_single_instance_lock_and_clean_release` | `acquire_lock()`, `release_lock()`, atomic file open | None (100% real OS file locking) | Asserts duplicate concurrent instance is rejected; verifies clean file release on exit. |

---

## 3. Active Executor Audit & Concurrency State

Live read-only verification executed at `2026-09-28T16:28:18Z`:

1. **Legacy Cloud Runner (`.github/workflows/antina-runner.yml`)**:
   - Query: `gh api repos/Kiris-02/gathermap/actions/workflows/antina-runner.yml --jq '{id,name,path,state}'`
   - Actual State:
     ```json
     {
       "id": 368201903,
       "name": "Wake Antina",
       "path": ".github/workflows/antina-runner.yml",
       "state": "disabled_manually"
     }
     ```
   - Conclusion: **INACTIVE**. Cannot execute tasks or conflict with local executors.

2. **Standalone Autonomous Local Worker (`scripts/local_antina_worker.py`)**:
   - Query: `Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*local_antina_worker*" -and $_.Name -ne "powershell.exe" }`
   - Active Processes: **0** (None).
   - Lock File (`.antina_worker.lock`): **Absent** (`False`).
   - Conclusion: **INACTIVE**. Kept dormant to avoid creating uncoordinated separate conversations.

3. **Temporary Local Notifier Bridge (`github-kir-bridge`)**:
   - Registered Sidecar: `github-kir-bridge` in `~/.gemini/config/config.json` (`"enabled": true`).
   - Active Process: PID `7804` (`python bridge.py --interval 180 --mode daemon`).
   - Lock File (`bridge.lock`): Active and held by PID `7804`.
   - Polling Interval: 180 seconds.
   - Target Destination: Kir conversation `6a86133d-899c-4702-a836-3a56a0127e9d`.
   - Conclusion: **ACTIVE & OPERATIONAL**. This is the **sole active task executor/notifier**. Zero executor concurrency overlap exists.

---

## 4. Lifecycle Procedures & Verification Classification

### Safe Stop Sequence (Verified)
1. Set `"enabled": false` for `"github-kir-bridge"` in `~/.gemini/config/config.json`.
2. Terminate the active sidecar process by PID: `Stop-Process -Id <PID>`.
3. Verify process termination (`Get-Process -Id <PID>` returns null).
4. Only after verifying process is dead, remove `bridge.lock` if not cleaned by `atexit`.
*(Never delete the lock file while the process is alive).*

### Lifecycle Classification
- Process termination & clean single-instance restart: **Verified on-host** (tested PID `13732` -> `7804` restart with state preserved).
- Antigravity IDE restart supervision: **Documented / Expected by platform specification** (Antigravity 2.0 sidecar supervisor manages relaunch when application is open).
- OS Sleep / Wake behavior: **Documented / Expected by OS process semantics** (process suspends during system sleep and resumes next timer tick upon wake).
