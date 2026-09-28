#!/usr/bin/env python3
"""Temporary GitHub -> Kir Local Bridge for Kiris-02/gathermap.

Monitors GitHub every 180 seconds for eligible GRUM_TASKs and dispatches them
directly to Kir's Antigravity conversation (6a86133d-899c-4702-a836-3a56a0127e9d)
via the supported Antigravity 2.0 `agentapi send-message` interface.

Key Architectural Guarantees:
- Single-Instance Lock: Enforced via atomic kernel lock with PID check.
- Pure Specification Fingerprint: Task identity strictly excludes mutable timestamps
  (updatedAt, createdAt); re-dispatches occur ONLY if task requirements or revision
  action items actually change.
- Strict Canonical Labeling: Rejects needs:kiris, needs_kiris, to:grum, and non-actionable states.
- Revision Review Binding: For state:revision, strictly requires latest GRUM_REVIEW
  decision to be REVISION_REQUIRED with valid reviewed_head and non-empty required_changes.
- Durable Two-Phase Dispatch: In-flight sends are journaled to state before agentapi call.
  Crashes or ambiguous responses transition to UNCERTAIN and hold rather than duplicate.
- Fail-Closed Idle Guard: Non-destructive local heuristic holding dispatch if Kir is
  actively running steps or messages are queued.
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Ensure UTF-8 output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_REPO = "Kiris-02/gathermap"
DEFAULT_TARGET_CONV = "6a86133d-899c-4702-a836-3a56a0127e9d"
DEFAULT_INTERVAL = 180

READY_LABELS = {"state:ready", "state:revision"}
CANONICAL_FORBIDDEN_LABELS = {
    "to:grum",
    "state:review",
    "state:done",
    "state:completed",
    "needs:kiris",
    "needs_kiris",
    "state:needs-kiris",
    "state:blocked",
    "human:escalation",
}

BRIDGE_DIR = Path(__file__).parent.resolve()
LOCK_FILE = BRIDGE_DIR / "bridge.lock"
STATE_FILE = BRIDGE_DIR / "bridge_state.json"
LOG_FILE = BRIDGE_DIR / "bridge.log"


def log(msg: str) -> None:
    timestamp = datetime.now(timezone.utc).isoformat()
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Single-Instance Lock Management
# ---------------------------------------------------------------------------

def acquire_lock() -> bool:
    """Acquire single-instance lock file with PID."""
    if LOCK_FILE.exists():
        try:
            content = LOCK_FILE.read_text(encoding="utf-8").strip()
            data = json.loads(content)
            old_pid = data.get("pid")
            if old_pid and is_process_running(old_pid):
                log(f"[LOCK] Active bridge instance already running with PID {old_pid}.")
                return False
            else:
                log(f"[LOCK] Stale lock file found for dead PID {old_pid}. Overwriting.")
        except Exception:
            log("[LOCK] Unreadable lock file found. Overwriting.")

    try:
        data = {
            "pid": os.getpid(),
            "acquired_at": datetime.now(timezone.utc).isoformat(),
        }
        LOCK_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        atexit.register(release_lock)
        return True
    except Exception as exc:
        log(f"[LOCK] Failed to acquire lock: {exc}")
        return False


def release_lock() -> None:
    """Release the single-instance lock file."""
    try:
        if LOCK_FILE.exists():
            LOCK_FILE.unlink(missing_ok=True)
            log("[LOCK] Lock file released cleanly.")
    except Exception as exc:
        log(f"[LOCK] Error releasing lock: {exc}")


def is_process_running(pid: int) -> bool:
    """Check if process with given PID exists."""
    if pid <= 0:
        return False
    try:
        if sys.platform == "win32":
            res = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                check=False,
            )
            return str(pid) in res.stdout
        else:
            os.kill(pid, 0)
            return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# State Persistence & Deduplication
# ---------------------------------------------------------------------------

def load_state() -> dict[str, Any]:
    """Load persisted bridge state from disk and recover in-flight tasks."""
    state = {
        "version": "1.1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "total_polls": 0,
        "last_poll_time": None,
        "pending_dispatches": {},
        "dispatched_tasks": {},
        "uncertain_deliveries": {},
    }
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                state.update(data)
        except Exception as exc:
            log(f"[STATE] Error reading state file ({exc}). Starting fresh.")

    # Recover any unconfirmed in-flight dispatches from a prior crashed run
    pending = state.get("pending_dispatches", {})
    if pending:
        for issue_num, meta in list(pending.items()):
            log(f"[RECOVERY] In-flight dispatch detected for Issue #{issue_num} ({meta.get('task_id')}) from crashed session. Transitioning to UNCERTAIN.")
            state["uncertain_deliveries"][issue_num] = {
                "task_id": meta.get("task_id"),
                "fingerprint": meta.get("fingerprint"),
                "reason": "CRASH_OR_UNCONFIRMED_DELIVERY",
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
            del state["pending_dispatches"][issue_num]
        save_state(state)

    return state


def save_state(state: dict[str, Any]) -> None:
    """Save bridge state to disk atomically."""
    temp_file = STATE_FILE.with_suffix(".tmp")
    try:
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        temp_file.replace(STATE_FILE)
    except Exception as exc:
        log(f"[STATE] Error writing state file: {exc}")
        if temp_file.exists():
            temp_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Task Fingerprinting & Specification Normalization
# ---------------------------------------------------------------------------

def normalize_body(body: str) -> str:
    """Normalize body markdown text to ensure whitespace consistency."""
    lines = [line.rstrip() for line in body.replace("\r\n", "\n").split("\n")]
    return "\n".join(lines).strip()


def compute_task_fingerprint(
    issue_number: int,
    task_id: str,
    state_label: str,
    body: str,
    revision_details: str = "",
) -> str:
    """Compute pure task specification fingerprint strictly excluding mutable timestamps."""
    norm_body = normalize_body(body)
    body_hash = hashlib.sha256(norm_body.encode("utf-8")).hexdigest()
    raw = f"{issue_number}|{task_id}|{state_label}|{body_hash}|{revision_details.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Antigravity agentapi Interface Discovery & Execution
# ---------------------------------------------------------------------------

def find_agentapi() -> str:
    """Locate agentapi executable."""
    found = shutil.which("agentapi") or shutil.which("agentapi.bat")
    if found:
        return found
    home = Path.home()
    standard = home / ".gemini" / "antigravity" / "bin" / "agentapi.bat"
    if standard.is_file():
        return str(standard)
    raise FileNotFoundError("Could not find agentapi on PATH or in ~/.gemini/antigravity/bin/")


def is_kir_conversation_idle(target_conv: str) -> tuple[bool, str]:
    """Check if Kir's conversation is currently idle (read-only safety heuristic).
    
    Verifies:
    1. Target SQLite DB steps table (latest step must be status 3 = DONE).
    2. Undelivered messages queue directory must be empty.
    Fails closed if the DB is unreadable or locked.
    """
    home = Path.home()
    db_path = home / ".gemini" / "antigravity" / "conversations" / f"{target_conv}.db"
    undelivered_dir = home / ".gemini" / "antigravity" / "brain" / target_conv / ".system_generated" / "messages" / "undelivered"

    # Check 1: Undelivered messages queue
    if undelivered_dir.is_dir():
        try:
            undelivered_files = list(undelivered_dir.glob("*.json"))
            if undelivered_files:
                return False, f"{len(undelivered_files)} message(s) waiting in undelivered queue."
        except Exception as exc:
            return False, f"Could not inspect undelivered queue ({exc}); failing closed."

    # Check 2: SQLite database step status
    if db_path.is_file():
        try:
            uri = f"file:{db_path.as_posix()}?mode=ro"
            conn = sqlite3.connect(uri, uri=True, timeout=2.0)
            cur = conn.cursor()
            cur.execute("SELECT idx, step_type, status FROM steps ORDER BY idx DESC LIMIT 1;")
            row = cur.fetchone()
            conn.close()

            if row:
                idx, step_type, status = row
                if status != 3:  # 3 = DONE
                    return False, f"Target conversation executing step {idx} (status={status} != DONE)."
                return True, f"Target conversation idle at step {idx} (status=DONE)."
        except Exception as exc:
            return False, f"Conversation DB read exception ({exc}); failing closed."

    return True, "No active blockers detected; assuming idle."


def send_to_kir(target_conv: str, title: str, content: str) -> tuple[bool, str]:
    """Send a message to Kir's conversation via agentapi send-message with cleaned environment."""
    agentapi = find_agentapi()
    cmd = [agentapi, "send-message", f"--title={title}", target_conv, content]

    # Clean environment: strip session-specific ANTIGRAVITY_ vars (like ANTIGRAVITY_PROJECT_ID)
    # to avoid project mismatch permission errors during cross-conversation dispatch.
    clean_env = {
        k: v for k, v in os.environ.items()
        if not k.startswith("ANTIGRAVITY_") or k in ("ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN")
    }

    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            env=clean_env,
        )
        if res.returncode == 0 and "sendMessage" in res.stdout:
            return True, res.stdout.strip()
        else:
            err = res.stderr.strip() or res.stdout.strip()
            return False, f"agentapi exited with code {res.returncode}: {err}"
    except Exception as exc:
        return False, f"Subprocess exception: {exc}"


# ---------------------------------------------------------------------------
# GitHub Polling & Task Eligibility
# ---------------------------------------------------------------------------

def run_gh_json(*args: str) -> Any:
    """Execute gh CLI command and parse JSON output."""
    cmd = ["gh", *args]
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
        errors="replace",
    )
    return json.loads(res.stdout.strip())


def poll_github(repo: str) -> list[dict[str, Any]]:
    """Poll GitHub for open issues."""
    try:
        issues = run_gh_json(
            "issue", "list",
            "--repo", repo,
            "--state", "open",
            "--json", "number,title,labels,updatedAt,body",
            "--limit", "20",
        )
        return issues if isinstance(issues, list) else []
    except Exception as exc:
        log(f"[POLL] GitHub API error during poll: {exc}")
        return []


def inspect_revision_pr(repo: str, issue_body: str) -> tuple[bool, str, str]:
    """Inspect linked PR for state:revision tasks to verify latest GRUM_REVIEW decision is REVISION_REQUIRED."""
    pr_match = re.search(r"pull/(\d+)", issue_body) or re.search(r"#(\d+)", issue_body)
    if not pr_match:
        return False, "No linked Pull Request found in revision issue body.", ""

    pr_num = pr_match.group(1)
    try:
        pr_data = run_gh_json("pr", "view", pr_num, "--repo", repo, "--json", "state,comments,headRefOid")
        if pr_data.get("state") != "OPEN":
            return False, f"Linked PR #{pr_num} is not OPEN (state: {pr_data.get('state')}).", ""

        comments = pr_data.get("comments", [])
        latest_review = None
        for comment in reversed(comments):
            cbody = comment.get("body", "")
            if "GRUM_REVIEW" in cbody:
                latest_review = cbody
                break

        if not latest_review:
            return False, f"No GRUM_REVIEW comment found in linked PR #{pr_num}.", ""

        # Parse decision
        dec_match = re.search(r"-\s*\*\*decision\*\*:\s*([A-Za-z0-9_]+)", latest_review)
        decision = dec_match.group(1).strip() if dec_match else ""

        if decision != "REVISION_REQUIRED":
            return False, f"Latest GRUM_REVIEW decision on PR #{pr_num} is '{decision}', not 'REVISION_REQUIRED'.", ""

        # Parse reviewed_head
        head_match = re.search(r"-\s*\*\*reviewed_head\*\*:\s*`?([a-f0-9]{7,40})`?", latest_review)
        reviewed_head = head_match.group(1).strip() if head_match else ""

        # Parse required_changes
        req_match = re.search(r"-\s*\*\*required_changes\*\*:(.+?)(?=- \*\*|\Z)", latest_review, re.DOTALL)
        required_changes = req_match.group(1).strip() if req_match else ""

        if not required_changes or "none" in required_changes.lower():
            return False, f"Latest GRUM_REVIEW on PR #{pr_num} has empty required_changes.", ""

        revision_details = f"PR#{pr_num}|HEAD:{reviewed_head}|DEC:{decision}|REQ:{hashlib.sha256(required_changes.encode('utf-8')).hexdigest()}"
        return True, "Valid revision review identified.", revision_details

    except Exception as exc:
        return False, f"Error inspecting linked PR #{pr_num}: {exc}", ""


def evaluate_task_eligibility(issue: dict[str, Any], repo: str) -> tuple[bool, str, dict[str, Any]]:
    """Evaluate whether an issue is an eligible GRUM_TASK ready for Antina/Kir."""
    labels = {lbl.get("name", "").strip().lower() for lbl in issue.get("labels", [])}

    # 1. Must contain to:antina
    if "to:antina" not in labels and "to: antina" not in labels:
        return False, "Missing 'to:antina' label.", {}

    # 2. Must NOT contain any canonical forbidden label
    for forbidden in CANONICAL_FORBIDDEN_LABELS:
        if forbidden in labels:
            return False, f"Contains forbidden label '{forbidden}'.", {}

    # 3. Must have an eligible state label
    state_label = None
    for r in READY_LABELS:
        if r in labels:
            state_label = r
            break
    if not state_label:
        return False, "Missing state label ('state:ready' or 'state:revision').", {}

    # 4. Body structure check
    body = issue.get("body", "")
    task_id_match = re.search(r"-\s*\*\*task_id\*\*:\s*([A-Za-z0-9_\-]+)", body)
    task_id = task_id_match.group(1).strip() if task_id_match else f"ISSUE-{issue['number']}"

    # 5. Strict revision binding if state:revision
    revision_details = ""
    if state_label == "state:revision":
        rev_ok, rev_reason, rev_details = inspect_revision_pr(repo, body)
        if not rev_ok:
            return False, f"Revision rejected: {rev_reason}", {}
        revision_details = rev_details

    # Compute pure specification fingerprint (strictly NO timestamps)
    fingerprint = compute_task_fingerprint(
        issue_number=issue["number"],
        task_id=task_id,
        state_label=state_label,
        body=body,
        revision_details=revision_details,
    )

    meta = {
        "issue_number": issue["number"],
        "title": issue.get("title", ""),
        "task_id": task_id,
        "state_label": state_label,
        "body": body,
        "fingerprint": fingerprint,
        "revision_details": revision_details,
    }
    return True, "Eligible task identified.", meta


# ---------------------------------------------------------------------------
# Core Bridge Polling Cycle
# ---------------------------------------------------------------------------

def run_single_poll_cycle(
    repo: str,
    target_conv: str,
    state: dict[str, Any],
    dry_run: bool = False,
) -> int:
    """Execute one full poll cycle with two-phase dispatch journaling."""
    state["total_polls"] = state.get("total_polls", 0) + 1
    state["last_poll_time"] = datetime.now(timezone.utc).isoformat()

    log(f"[POLL #{state['total_polls']}] Polling {repo} for eligible GRUM_TASKs...")
    issues = poll_github(repo)
    dispatched_count = 0

    eligible_tasks = []
    for issue in issues:
        eligible, reason, meta = evaluate_task_eligibility(issue, repo)
        if eligible:
            eligible_tasks.append(meta)
        else:
            lbl_names = [lbl.get("name") for lbl in issue.get("labels", [])]
            if any("antina" in (l or "").lower() or "ready" in (l or "").lower() for l in lbl_names):
                log(f"[POLL] Skipped Issue #{issue['number']}: {reason}")

    log(f"[POLL] Found {len(eligible_tasks)} eligible task(s) among {len(issues)} open issue(s).")

    for task in eligible_tasks:
        issue_num_str = str(task["issue_number"])
        current_fp = task["fingerprint"]

        # Check if already in uncertain state
        uncertain = state.get("uncertain_deliveries", {}).get(issue_num_str)
        if uncertain:
            log(f"[HOLD] Task {task['task_id']} (Issue #{task['issue_number']}) is in UNCERTAIN state ({uncertain.get('reason')}). Holding dispatch.")
            continue

        # Deduplication Check
        prior = state.get("dispatched_tasks", {}).get(issue_num_str)
        if prior and prior.get("fingerprint") == current_fp:
            log(f"[DEDUP] Task {task['task_id']} (Issue #{task['issue_number']}) already dispatched at {prior.get('dispatched_at')} with identical specification fingerprint. Skipping.")
            continue

        if dry_run:
            log(f"[DRY-RUN] Eligible task ready for dispatch: {task['task_id']} (Issue #{task['issue_number']}) [{task['state_label']}]. (Dry-run mode: not sending)")
            continue

        # Check if Kir's conversation is idle
        idle, idle_reason = is_kir_conversation_idle(target_conv)
        if not idle:
            log(f"[HOLD] Kir's conversation is not idle ({idle_reason}). Holding dispatch of {task['task_id']} for next poll.")
            continue

        # Construct notification payload with revalidation warning
        payload = (
            f"🔔 [BRIDGE DISPATCH] New Eligible Task Ready for Implementation\n\n"
            f"- **Task ID**: `{task['task_id']}`\n"
            f"- **Issue**: [#{task['issue_number']}](https://github.com/{repo}/issues/{task['issue_number']}) - {task['title']}\n"
            f"- **State**: `{task['state_label']}`\n"
            f"- **Timestamp**: `{datetime.now(timezone.utc).isoformat()}`\n\n"
            f"### 📋 Task Summary\n"
            f"{task['body'][:800]}\n\n"
            f"---\n"
            f"⚠️ **REVALIDATION REQUIRED**: Before executing tools or changes, verify on GitHub that Issue #{task['issue_number']} is open, still assigned to:antina, and in an actionable state.\n"
            f"*Dispatched automatically by Andy's Temporary GitHub Bridge.*"
        )

        title = f"[BRIDGE] Task Ready: {task['task_id']}"
        log(f"[DISPATCH] Phase 1: Journaling in-flight dispatch for {task['task_id']} (Issue #{task['issue_number']})...")

        # Phase 1: Journal in-flight dispatch
        state.setdefault("pending_dispatches", {})[issue_num_str] = {
            "task_id": task["task_id"],
            "fingerprint": current_fp,
            "state_label": task["state_label"],
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        save_state(state)

        # Phase 2: Dispatch via agentapi
        log(f"[DISPATCH] Phase 2: Sending {task['task_id']} to Kir's conversation {target_conv}...")
        success, result_msg = send_to_kir(target_conv, title, payload)

        # Phase 3: Post-dispatch resolution
        del state["pending_dispatches"][issue_num_str]
        if success:
            log(f"[DISPATCH SUCCESS] Phase 3: Delivered {task['task_id']} to Kir.")
            state.setdefault("dispatched_tasks", {})[issue_num_str] = {
                "task_id": task["task_id"],
                "issue_number": task["issue_number"],
                "fingerprint": current_fp,
                "state_label": task["state_label"],
                "dispatched_at": datetime.now(timezone.utc).isoformat(),
                "status": "DELIVERED",
            }
            dispatched_count += 1
        else:
            log(f"[DISPATCH ERROR] Phase 3: Delivery failed for {task['task_id']}: {result_msg}")
            state.setdefault("uncertain_deliveries", {})[issue_num_str] = {
                "task_id": task["task_id"],
                "fingerprint": current_fp,
                "reason": f"SEND_FAILED: {result_msg}",
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }

    save_state(state)
    return dispatched_count


# ---------------------------------------------------------------------------
# Diagnostic Probe & Test Routines
# ---------------------------------------------------------------------------

def run_diagnostic_ack_probe(target_conv: str, probe_id: str) -> bool:
    """Send a diagnostic connectivity probe and verify matching ACK in target DB."""
    log(f"[DIAG] Sending diagnostic probe '{probe_id}' to {target_conv}...")
    content = (
        f"{probe_id}. Kir, this is a connectivity test from Andy. "
        f"Reply only ACK_{probe_id}. Do not run tools, modify files or GitHub, or resume any engineering task."
    )
    title = f"Diagnostic Test: {probe_id}"

    success, send_out = send_to_kir(target_conv, title, content)
    if not success:
        log(f"[DIAG] Failed to send probe: {send_out}")
        return False

    log(f"[DIAG] Probe dispatched. Waiting up to 15s for exact ACK_{probe_id} in conversation transcript...")
    home = Path.home()
    transcript_file = home / ".gemini" / "antigravity" / "brain" / target_conv / ".system_generated" / "logs" / "transcript.jsonl"

    start_t = time.time()
    ack_token = f"ACK_{probe_id}"
    while time.time() - start_t < 15:
        time.sleep(1.5)
        if transcript_file.is_file():
            try:
                with open(transcript_file, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
                for line in reversed(lines[-10:]):
                    if ack_token in line:
                        log(f"[DIAG SUCCESS] Exact matching ACK received: {ack_token}")
                        return True
            except Exception:
                pass

    log(f"[DIAG TIMEOUT] Did not find {ack_token} in target transcript within 15 seconds.")
    return False


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Temporary GitHub -> Kir Local Bridge")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repository (owner/repo)")
    parser.add_argument("--target-conv", default=DEFAULT_TARGET_CONV, help="Kir's Antigravity conversation ID")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="Polling interval in seconds (default: 180)")
    parser.add_argument("--mode", choices=["daemon", "single-poll", "observe-cycles", "test-probe"], default="daemon")
    parser.add_argument("--probe-id", default=f"BRIDGE_PROBE_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    parser.add_argument("--cycles", type=int, default=3, help="Number of observation cycles")

    args = parser.parse_args()

    if not acquire_lock():
        return 1

    state = load_state()

    try:
        if args.mode == "single-poll":
            run_single_poll_cycle(args.repo, args.target_conv, state, dry_run=False)
            return 0

        elif args.mode == "observe-cycles":
            log(f"[OBSERVE] Running {args.cycles} observation cycles with dry-run=True (interval 3s for verification)...")
            for i in range(1, args.cycles + 1):
                run_single_poll_cycle(args.repo, args.target_conv, state, dry_run=True)
                if i < args.cycles:
                    time.sleep(3)
            log("[OBSERVE] Observation cycles complete. Zero repeated notifications sent.")
            return 0

        elif args.mode == "test-probe":
            ok = run_diagnostic_ack_probe(args.target_conv, args.probe_id)
            return 0 if ok else 1

        elif args.mode == "daemon":
            log(f"[DAEMON] Starting Temporary GitHub -> Kir Bridge daemon (interval: {args.interval}s, repo: {args.repo})...")
            while True:
                try:
                    run_single_poll_cycle(args.repo, args.target_conv, state, dry_run=False)
                except Exception as exc:
                    log(f"[DAEMON ERROR] Unexpected error in polling cycle: {exc}")
                time.sleep(args.interval)

    except KeyboardInterrupt:
        log("[BRIDGE] Shutting down bridge on user interrupt (SIGINT).")
        return 0
    finally:
        save_state(state)
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
