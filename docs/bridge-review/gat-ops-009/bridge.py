#!/usr/bin/env python3
"""Temporary GitHub -> Kir Local Bridge for Kiris-02/gathermap (Hardened v1.2).

Monitors GitHub every 180 seconds for eligible GRUM_TASKs and dispatches them
directly to Kir's Antigravity conversation (6a86133d-899c-4702-a836-3a56a0127e9d)
via the supported Antigravity 2.0 `agentapi send-message` interface.

Key Architectural Guarantees & Hardening (GAT-OPS-009):
1. Fail-Closed Idle Check: If conversation DB is missing, unreadable, or has no step records,
   dispatch is held (never fail-open).
2. Atomic Kernel Lock: Single-instance mutex enforced via OS-level atomic creation flags
   (O_CREAT | O_EXCL), preventing TOCTOU races.
3. Strict Revision Head Binding: For state:revision, verified that reviewed_head in GRUM_REVIEW
   strictly matches the linked PR's current headRefOid commit SHA.
4. Fail-Closed State Journaling: State saving errors abort dispatch immediately; corrupted
   or malformed state files block polling without silently resetting.
5. Explicit Delivery Semantics: Dispatches are recorded as DISPATCHED_TO_CONVERSATION, explicitly
   distinguishing local queue injection from a confirmed task ACK from Kir.
6. Strict Label & Task Validation: Rejects conflicting state:* labels and validates mandatory
   GRUM_TASK sections (task_id, goal, Acceptance Criteria checkboxes).
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


class BridgeStateCorruptedError(RuntimeError):
    """Raised when the persisted state file exists but contains invalid JSON or schema."""
    pass


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
# Single-Instance Lock Management (Atomic O_CREAT | O_EXCL)
# ---------------------------------------------------------------------------

def acquire_lock(lock_path: Path | None = None) -> bool:
    """Acquire single-instance lock file atomically via kernel O_CREAT | O_EXCL."""
    target_lock = lock_path or LOCK_FILE
    target_lock.parent.mkdir(parents=True, exist_ok=True)
    my_pid = os.getpid()

    # Attempt 1: Atomic creation
    try:
        fd = os.open(str(target_lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            data = {
                "pid": my_pid,
                "acquired_at": datetime.now(timezone.utc).isoformat(),
            }
            json.dump(data, f, indent=2)
        atexit.register(release_lock, target_lock)
        return True
    except FileExistsError:
        pass
    except Exception as exc:
        log(f"[LOCK] Unexpected error during atomic creation: {exc}")
        return False

    # File exists: Check if existing lock is held by an active process
    try:
        content = target_lock.read_text(encoding="utf-8").strip()
        data = json.loads(content)
        existing_pid = data.get("pid")
        if existing_pid and is_process_running(existing_pid):
            log(f"[LOCK] Active bridge instance already running with PID {existing_pid}.")
            return False
        else:
            log(f"[LOCK] Stale lock file found for dead PID {existing_pid}. Removing stale lock.")
            target_lock.unlink(missing_ok=True)
    except Exception as exc:
        log(f"[LOCK] Unreadable or corrupted lock file found ({exc}). Removing stale lock.")
        target_lock.unlink(missing_ok=True)

    # Attempt 2: Retry atomic creation after clearing confirmed dead/corrupt lock
    try:
        fd = os.open(str(target_lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            data = {
                "pid": my_pid,
                "acquired_at": datetime.now(timezone.utc).isoformat(),
            }
            json.dump(data, f, indent=2)
        atexit.register(release_lock, target_lock)
        return True
    except (FileExistsError, OSError):
        log("[LOCK] Lost race during stale lock acquisition.")
        return False


def release_lock(lock_path: Path | None = None) -> None:
    """Release the single-instance lock file if owned by this process."""
    target_lock = lock_path or LOCK_FILE
    try:
        if target_lock.exists():
            try:
                data = json.loads(target_lock.read_text(encoding="utf-8"))
                if data.get("pid") == os.getpid():
                    target_lock.unlink(missing_ok=True)
                    log("[LOCK] Lock file released cleanly.")
                else:
                    log(f"[LOCK] Skipping release: lock file is owned by PID {data.get('pid')}, not {os.getpid()}.")
            except Exception:
                target_lock.unlink(missing_ok=True)
                log("[LOCK] Corrupt lock file removed on release.")
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
    """Load persisted bridge state from disk and recover in-flight tasks.

    Raises BridgeStateCorruptedError if the state file exists but contains invalid JSON.
    """
    default_state = {
        "version": "1.2",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "total_polls": 0,
        "last_poll_time": None,
        "pending_dispatches": {},
        "dispatched_tasks": {},
        "uncertain_deliveries": {},
    }
    if not STATE_FILE.exists():
        return default_state

    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("State file content is not a JSON object")
        default_state.update(data)
    except Exception as exc:
        log(f"[STATE ERROR] Corrupted state file at {STATE_FILE}: {exc}")
        raise BridgeStateCorruptedError(f"State file is corrupt ({exc}). Refusing to reset automatically.") from exc

    # Recover any unconfirmed in-flight dispatches from a prior crashed run
    pending = default_state.get("pending_dispatches", {})
    if pending:
        for issue_num, meta in list(pending.items()):
            log(f"[RECOVERY] In-flight dispatch detected for Issue #{issue_num} ({meta.get('task_id')}) from crashed session. Transitioning to UNCERTAIN.")
            default_state.setdefault("uncertain_deliveries", {})[issue_num] = {
                "task_id": meta.get("task_id"),
                "fingerprint": meta.get("fingerprint"),
                "reason": "CRASH_OR_UNCONFIRMED_DELIVERY",
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
            del default_state["pending_dispatches"][issue_num]
        if not save_state(default_state):
            raise IOError("Failed to persist in-flight recovery updates to state file.")

    return default_state


def save_state(state: dict[str, Any]) -> bool:
    """Save bridge state to disk atomically. Returns True on success, False on failure."""
    temp_file = STATE_FILE.with_suffix(".tmp")
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        temp_file.replace(STATE_FILE)
        return True
    except Exception as exc:
        log(f"[STATE ERROR] Failed to save state file: {exc}")
        if temp_file.exists():
            try:
                temp_file.unlink(missing_ok=True)
            except Exception:
                pass
        return False


# ---------------------------------------------------------------------------
# Task Fingerprinting & Specification Normalization
# ---------------------------------------------------------------------------

def normalize_body(body: str) -> str:
    """Normalize body markdown text to ensure whitespace consistency."""
    lines = [line.rstrip() for line in body.replace("\r\n", "\n").split("\n")]
    return "\n".join(lines).strip()


def validate_grum_task_structure(body: str) -> tuple[bool, str, str]:
    """Validate that issue body adheres to required GRUM_TASK specification."""
    # Check 1: Header
    if not re.search(r"^##\s*(?:📋\s*)?GRUM_TASK", body, re.MULTILINE):
        return False, "Missing '## 📋 GRUM_TASK' header.", ""

    # Check 2: task_id
    task_id_match = re.search(r"-\s*\*\*task_id\*\*:\s*`?([A-Za-z0-9_\-]+)`?", body)
    if not task_id_match or not task_id_match.group(1).strip():
        return False, "Missing or empty '- **task_id**:' specification.", ""
    task_id = task_id_match.group(1).strip()

    # Check 3: goal
    goal_match = re.search(r"-\s*\*\*goal\*\*:\s*(.+)", body)
    if not goal_match or not goal_match.group(1).strip():
        return False, "Missing or empty '- **goal**:' specification.", ""

    # Check 4: Acceptance Criteria with at least one checkbox
    if not re.search(r"###\s*(?:🎯\s*)?Acceptance Criteria", body, re.IGNORECASE):
        return False, "Missing '### 🎯 Acceptance Criteria' section.", ""

    if not re.search(r"-\s*\[[ xX]\]\s+.+", body):
        return False, "Acceptance Criteria section has no actionable checkboxes ('- [ ]').", ""

    return True, "Valid GRUM_TASK structure.", task_id


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


def is_kir_conversation_idle(target_conv: str, base_home: Path | None = None) -> tuple[bool, str]:
    """Check if Kir's conversation is currently idle (fail-closed safety heuristic).

    Verifies:
    1. Undelivered messages queue directory must exist and be empty.
    2. Target SQLite DB must exist, be queryable, and have at least one step.
    3. The latest step status must equal 3 (DONE).

    Fails closed (returns False) if the DB is missing, steps table is empty, or DB is locked.
    """
    home = base_home or Path.home()
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

    # Check 2: SQLite database existence & step status (FAIL-CLOSED)
    if not db_path.is_file():
        return False, f"Target conversation DB not found at {db_path}; failing closed."

    try:
        uri = f"file:{db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        cur = conn.cursor()
        cur.execute("SELECT idx, step_type, status FROM steps ORDER BY idx DESC LIMIT 1;")
        row = cur.fetchone()
        conn.close()

        if not row:
            return False, "Target conversation DB steps table is empty (0 steps); failing closed."

        idx, step_type, status = row
        if status != 3:  # 3 = DONE
            return False, f"Target conversation executing step {idx} (status={status} != DONE)."
        return True, f"Target conversation idle at step {idx} (status=DONE)."
    except Exception as exc:
        return False, f"Conversation DB read exception ({exc}); failing closed."


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
    """Inspect linked PR for state:revision tasks to verify latest GRUM_REVIEW decision is REVISION_REQUIRED.

    Strictly verifies that reviewed_head in GRUM_REVIEW matches current PR headRefOid.
    """
    pr_match = re.search(r"pull/(\d+)", issue_body) or re.search(r"#(\d+)", issue_body)
    if not pr_match:
        return False, "No linked Pull Request found in revision issue body.", ""

    pr_num = pr_match.group(1)
    try:
        pr_data = run_gh_json("pr", "view", pr_num, "--repo", repo, "--json", "state,comments,headRefOid")
        if pr_data.get("state") != "OPEN":
            return False, f"Linked PR #{pr_num} is not OPEN (state: {pr_data.get('state')}).", ""

        head_ref_oid = (pr_data.get("headRefOid") or "").strip().lower()
        if not head_ref_oid:
            return False, f"Could not determine current headRefOid for linked PR #{pr_num}.", ""

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
        dec_match = re.search(r"-\s*\*\*decision\*\*:\s*`?([A-Za-z0-9_]+)`?", latest_review)
        decision = dec_match.group(1).strip() if dec_match else ""

        if decision != "REVISION_REQUIRED":
            return False, f"Latest GRUM_REVIEW decision on PR #{pr_num} is '{decision}', not 'REVISION_REQUIRED'.", ""

        # Parse reviewed_head
        head_match = re.search(r"-\s*\*\*reviewed_head\*\*:\s*`?([a-f0-9]{7,40})`?", latest_review)
        reviewed_head = (head_match.group(1).strip().lower() if head_match else "")

        if not reviewed_head:
            return False, f"Latest GRUM_REVIEW on PR #{pr_num} does not specify a valid reviewed_head commit SHA.", ""

        # Strict Head Binding: reviewed_head must match current PR headRefOid
        if not (head_ref_oid.startswith(reviewed_head) or reviewed_head.startswith(head_ref_oid)):
            return False, (
                f"Stale review rejected: reviewed_head '{reviewed_head}' does not match "
                f"current PR #{pr_num} headRefOid '{head_ref_oid}'."
            ), ""

        # Parse required_changes
        req_match = re.search(r"-\s*\*\*required_changes\*\*:(.+?)(?=- \*\*|\Z)", latest_review, re.DOTALL)
        required_changes = req_match.group(1).strip() if req_match else ""

        if not required_changes or "none" in required_changes.lower():
            return False, f"Latest GRUM_REVIEW on PR #{pr_num} has empty required_changes.", ""

        revision_details = f"PR#{pr_num}|HEAD:{head_ref_oid}|DEC:{decision}|REQ:{hashlib.sha256(required_changes.encode('utf-8')).hexdigest()}"
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

    # 3. State label validation & conflict rejection
    state_labels_present = [lbl for lbl in labels if lbl.startswith("state:")]
    ready_states_present = [lbl for lbl in state_labels_present if lbl in READY_LABELS]

    if len(ready_states_present) > 1:
        return False, f"Conflicting ready state labels detected: {ready_states_present}.", {}

    if len(state_labels_present) > 1:
        return False, f"Conflicting multiple state labels detected: {state_labels_present}.", {}

    if not ready_states_present:
        return False, "Missing required state label ('state:ready' or 'state:revision').", {}

    state_label = ready_states_present[0]

    # 4. Mandatory GRUM_TASK structure validation
    body = issue.get("body", "")
    struct_ok, struct_reason, task_id = validate_grum_task_structure(body)
    if not struct_ok:
        return False, f"Invalid GRUM_TASK structure: {struct_reason}", {}

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
    base_home: Path | None = None,
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

        # Check if Kir's conversation is idle (fail-closed)
        idle, idle_reason = is_kir_conversation_idle(target_conv, base_home=base_home)
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

        # Phase 1: Journal in-flight dispatch (FAIL-CLOSED on write failure)
        state.setdefault("pending_dispatches", {})[issue_num_str] = {
            "task_id": task["task_id"],
            "fingerprint": current_fp,
            "state_label": task["state_label"],
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        if not save_state(state):
            log(f"[DISPATCH ABORTED] Phase 1: Failed to journal state for {task['task_id']} (Issue #{task['issue_number']}). Aborting dispatch to prevent unjournaled send.")
            del state["pending_dispatches"][issue_num_str]
            continue

        # Phase 2: Dispatch via agentapi
        log(f"[DISPATCH] Phase 2: Sending {task['task_id']} to Kir's conversation {target_conv}...")
        success, result_msg = send_to_kir(target_conv, title, payload)

        # Phase 3: Post-dispatch resolution
        del state["pending_dispatches"][issue_num_str]
        if success:
            log(f"[DISPATCH SUCCESS] Phase 3: Message posted to conversation queue for {task['task_id']}.")
            state.setdefault("dispatched_tasks", {})[issue_num_str] = {
                "task_id": task["task_id"],
                "issue_number": task["issue_number"],
                "fingerprint": current_fp,
                "state_label": task["state_label"],
                "dispatched_at": datetime.now(timezone.utc).isoformat(),
                "delivery_status": "DISPATCHED_TO_CONVERSATION",
                "note": "agentapi returncode 0 confirms injection into conversation message queue; does not constitute semantic ACK from Kir/Antina.",
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
    parser = argparse.ArgumentParser(description="Temporary GitHub -> Kir Local Bridge (Hardened v1.2)")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repository (owner/repo)")
    parser.add_argument("--target-conv", default=DEFAULT_TARGET_CONV, help="Kir's Antigravity conversation ID")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="Polling interval in seconds (default: 180)")
    parser.add_argument("--mode", choices=["daemon", "single-poll", "observe-cycles", "test-probe"], default="daemon")
    parser.add_argument("--probe-id", default=f"BRIDGE_PROBE_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    parser.add_argument("--cycles", type=int, default=3, help="Number of observation cycles")

    args = parser.parse_args()

    if not acquire_lock():
        return 1

    try:
        state = load_state()
    except BridgeStateCorruptedError as err:
        log(f"[FATAL] Cannot start bridge: {err}")
        release_lock()
        return 1

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
            log(f"[DAEMON] Starting Hardened Temporary GitHub -> Kir Bridge daemon (interval: {args.interval}s, repo: {args.repo})...")
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
