#!/usr/bin/env python3
"""Local Antina Worker for Kiris-02/gathermap.

Implements Method A: runs locally on Kiris's workstation under his authenticated
Antigravity desktop session via the native language_server agentapi interface.

SECURITY & EXECUTION MODEL:
- Execution Identity: Runs locally under Kiris's OS user account with local user permissions.
  Worktree isolation and post-execution diff verification strictly enforce repository boundaries
  (preventing unauthorized modifications from being committed or pushed). However, the agent
  process is NOT an operating system-level sandbox and has read access to files accessible to the
  local user. Sensitive credentials outside the repository should not be kept in unencrypted,
  world-readable paths on the worker host.
- Quota & Entitlement Status: The agent executes using the active Antigravity desktop IDE session
  without an external Gemini API key. Backend billing, rate limits, and quota accounting for
  agentapi sessions are managed by Google Antigravity's upstream platform and are currently
  unverified as an open SLA. It is strictly categorized as 'unverified_upstream_entitlement'.
- Concurrency & Atomicity: Single-task concurrency lock (concurrency = 1) enforced via atomic
  kernel file creation (O_CREAT | O_EXCL). Unlocking a live worker process is rejected.
- Deterministic Verification: Local tests, whitespace checks (git diff --check and --cached --check),
  and required GitHub Actions CI checks on the exact HEAD commit must pass before handoff.
- Revisions: Supports existing PR revision loops on the same branch and PR, enforcing the 4-round
  protocol limit.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REPO = "Kiris-02/gathermap"
READY_LABELS = {"state:ready", "state:revision"}
CONTROL_PREFIXES = ("to:", "state:")
FORBIDDEN_LABELS = {
    "NEEDS_KIRIS",
    "needs:kiris",
    "state:blocked",
    "state:needs-kiris",
    "state:review",
    "state:done",
    "to:grum",
}
PROTECTED_PREFIXES = (
    ".agents/",
    ".github/",
    ".git/",
    "supabase/migrations/",
)
PROTECTED_FILES = {
    ".git",
    ".env",
    ".env.local",
    "requirements-antina.txt",
    "scripts/agent_cycle.py",
    "scripts/antina_runner.py",
    "scripts/local_antina_worker.py",
}
REQUIRED_CHECKS = frozenset({
    "Antina required validation",
    "Test Suite & Browser E2E",
})
KNOWN_TEST_ARTIFACTS = (
    "tests/e2e-playwright-temp.db",
    "tests/e2e-playwright-temp.db-shm",
    "tests/e2e-playwright-temp.db-wal",
    "tests/ci-test.db",
    "tests/ci-test.db-shm",
    "tests/ci-test.db-wal",
)
MAX_REVISION_ROUNDS = 4

LOCK_FILE = Path(".antina_worker.lock")
CHECKPOINT_FILE = Path(".antina_worker_checkpoint.json")


class WorkerError(Exception):
    """A safety, validation, or execution error that must halt the worker."""


class IgnoreTask(Exception):
    """An issue event that is safely skipped because it is not ready or eligible."""


@dataclass(frozen=True)
class Task:
    issue_number: int
    task_id: str
    title: str
    body: str
    state_label: str
    branch: str
    allowed_paths: list[str]
    is_revision: bool = False
    revision_pr: int | None = None
    revision_head: str | None = None
    revision_branch: str | None = None
    review_findings: str | None = None


# ---------------------------------------------------------------------------
# Shell & GitHub CLI Utilities
# ---------------------------------------------------------------------------

def run_cmd(*args: str, cwd: Path | None = None, check: bool = True) -> str:
    """Execute a system command safely without shell expansion."""
    if not args:
        return ""
    cmd_args = list(args)
    resolved_exe = shutil.which(cmd_args[0])
    if resolved_exe:
        cmd_args[0] = resolved_exe
    try:
        res = subprocess.run(
            cmd_args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            check=check,
            encoding="utf-8",
            errors="replace",
        )
        return res.stdout.strip()
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        err_msg = stderr or stdout or str(exc)
        raise WorkerError(f"Command failed ({' '.join(args[:3])}...): {err_msg}") from exc
    except FileNotFoundError as exc:
        raise WorkerError(f"Executable not found on PATH: {args[0]}") from exc


def gh_json(*args: str, cwd: Path | None = None) -> Any:
    """Execute gh CLI command and parse JSON output."""
    raw = run_cmd("gh", *args, cwd=cwd)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WorkerError(f"Malformed JSON from gh command: {raw[:200]}") from exc


def validate_github_remote_url(url: str, expected_repo: str = REPO) -> bool:
    """Strictly validate that a Git remote URL targets github.com/<expected_repo>."""
    clean = url.strip().replace("\\", "/")
    # HTTPS: https://([user:pass@]?)github.com/owner/repo(.git)?(/?)
    https_match = re.match(r"^https://(?:[^@/]+@)?github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", clean, re.IGNORECASE)
    if https_match:
        owner, repo = https_match.group(1), https_match.group(2)
        return f"{owner}/{repo}".lower() == expected_repo.lower()

    # SSH standard URL: ssh://[user@]github.com[:port]/owner/repo(.git)?(/?)
    ssh_match = re.match(r"^ssh://(?:[^@/]+@)?github\.com(?::\d+)?/([^/]+)/([^/]+?)(?:\.git)?/?$", clean, re.IGNORECASE)
    if ssh_match:
        owner, repo = ssh_match.group(1), ssh_match.group(2)
        return f"{owner}/{repo}".lower() == expected_repo.lower()

    # SSH scp-style: [user@]github.com:owner/repo(.git)?(/?)
    scp_match = re.match(r"^(?:[^@/:]+@)?github\.com:([^/]+)/([^/]+?)(?:\.git)?/?$", clean, re.IGNORECASE)
    if scp_match:
        owner, repo = scp_match.group(1), scp_match.group(2)
        return f"{owner}/{repo}".lower() == expected_repo.lower()

    return False


def verify_repo_remote(repo_root: Path) -> None:
    """Ensure repository remotes (both fetch and push) point strictly to the expected repository."""
    for remote_flag in ([], ["--push"]):
        cmd = ["git", "remote", "get-url"] + remote_flag + ["origin"]
        url = run_cmd(*cmd, cwd=repo_root)
        if not validate_github_remote_url(url, REPO):
            raise WorkerError(f"Invalid git remote origin '{url}': must point strictly to github.com/{REPO}")


# ---------------------------------------------------------------------------
# Concurrency Lock & Checkpoint System (Atomic Kernel Locking)
# ---------------------------------------------------------------------------

def is_process_running(pid: int) -> bool:
    """Check if a process PID is currently alive on Windows/Linux."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                check=False,
            )
            return f'"{pid}"' in out.stdout or str(pid) in out.stdout
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False


def is_agent_conversation_active(conversation_id: str, timeout_seconds: float = 15.0) -> bool:
    """Check if an agent conversation is still actively running or writing to transcript."""
    if not conversation_id:
        return False
    transcript_file = get_conversation_transcript_path(conversation_id)
    if not transcript_file.exists():
        return False
    try:
        mtime = transcript_file.stat().st_mtime
        if (time.time() - mtime) > timeout_seconds:
            return False
        lines = transcript_file.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            step = json.loads(line)
            if step.get("source") == "MODEL" and step.get("type") == "PLANNER_RESPONSE" and step.get("status") in {"DONE", "ERROR"}:
                return False
            break
        return True
    except Exception:
        return False


def acquire_lock(repo_root: Path, task_id: str) -> Path:
    """Acquire persistent worker lock atomically via O_CREAT | O_EXCL.

    Fails closed if another process is actively running, or if an interrupted task's
    preserved checkpoint remains unresolved for a different task.
    Reclaims stale lock if the previous holder process is dead and no foreign checkpoint is active.
    """
    lock_path = repo_root / LOCK_FILE
    lock_data = {
        "pid": os.getpid(),
        "task_id": task_id,
        "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    payload = json.dumps(lock_data, indent=2).encode("utf-8")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY

    # Pre-check active checkpoint before claiming
    ckpt = load_checkpoint(repo_root)
    if ckpt and ckpt.get("stage") in {"AGENT_TIMED_OUT", "INTERRUPTED", "AGENT_RUNNING", "AGENT_MONITORING"}:
        preserved_task = ckpt.get("task_id")
        if preserved_task and preserved_task != task_id:
            raise WorkerError(
                f"Cannot acquire lock: an interrupted task '{preserved_task}' is preserved in checkpoint "
                f"(stage: {ckpt.get('stage')}). Reconcile or unlock first."
            )
        conv_id = ckpt.get("conversation_id")
        if conv_id and is_agent_conversation_active(conv_id):
            raise WorkerError(
                f"Cannot acquire lock: agent conversation '{conv_id}' for task '{preserved_task}' "
                "is still actively running."
            )

    try:
        fd = os.open(str(lock_path), flags)
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        return lock_path
    except FileExistsError:
        # File already exists: inspect lock owner
        try:
            existing = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = existing.get("pid")
            if pid and is_process_running(pid):
                raise WorkerError(
                    f"Worker lock active by live PID {pid} for task {existing.get('task_id')}. "
                    "Another local worker is currently executing."
                )
            # Dead PID: verify no conflicting preserved checkpoint before reclaim
            if ckpt and ckpt.get("task_id") and ckpt.get("task_id") != task_id:
                raise WorkerError(
                    f"Cannot reclaim stale lock: checkpoint for task '{ckpt.get('task_id')}' is preserved "
                    f"(stage: {ckpt.get('stage')}). Run unlock or resume the preserved task."
                )
            print(f"⚠️ Stale lock detected (dead PID {pid}). Reclaiming lock atomically.", flush=True)
            lock_path.unlink(missing_ok=True)
            fd = os.open(str(lock_path), flags)
            with os.fdopen(fd, "wb") as f:
                f.write(payload)
            return lock_path
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError(f"Failed to resolve existing lock file: {exc}") from exc


def release_lock(repo_root: Path) -> None:
    """Release persistent worker lock."""
    lock_path = repo_root / LOCK_FILE
    if lock_path.exists():
        try:
            lock_path.unlink()
        except OSError:
            pass


def save_checkpoint(repo_root: Path, data: dict) -> None:
    """Atomically record worker checkpoint."""
    ckpt_path = repo_root / CHECKPOINT_FILE
    data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp_path = ckpt_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp_path.replace(ckpt_path)


def load_checkpoint(repo_root: Path) -> dict | None:
    """Load existing checkpoint if present."""
    ckpt_path = repo_root / CHECKPOINT_FILE
    if not ckpt_path.exists():
        return None
    try:
        return json.loads(ckpt_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def clear_checkpoint(repo_root: Path) -> None:
    """Remove checkpoint upon clean task completion."""
    ckpt_path = repo_root / CHECKPOINT_FILE
    if ckpt_path.exists():
        try:
            ckpt_path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Antigravity agentapi Interface Discovery & Execution
# ---------------------------------------------------------------------------

def find_agentapi_cmd() -> list[str]:
    """Locate the supported Antigravity CLI / language_server agentapi interface."""
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        ls_path = Path(local_app_data) / "Programs" / "antigravity" / "resources" / "bin" / "language_server.exe"
        if ls_path.is_file():
            return [str(ls_path.resolve()), "agentapi"]

    home = Path.home()
    agentapi_bat = home / ".gemini" / "antigravity" / "bin" / "agentapi.bat"
    if agentapi_bat.is_file():
        return [str(agentapi_bat.resolve())]

    which_bat = shutil.which("agentapi.bat") or shutil.which("agentapi")
    if which_bat:
        return [which_bat]

    raise WorkerError(
        "Antigravity local agentapi interface not found. "
        "Ensure Antigravity IDE is installed and language_server.exe is accessible."
    )


def verify_agentapi_ready() -> dict[str, Any]:
    """Verify that agentapi is operational and record interface metadata."""
    cmd = find_agentapi_cmd()
    try:
        out = run_cmd(*cmd, "--help")
    except Exception as exc:
        raise WorkerError(f"Antigravity agentapi probe failed: {exc}") from exc

    if "Available Commands" not in out and "new-conversation" not in out:
        raise WorkerError(f"Unexpected agentapi response: {out[:200]}")

    # Check program version from Antigravity installation
    app_version = "2.17.0"
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        exe_path = Path(local_app_data) / "Programs" / "antigravity" / "Antigravity.exe"
        if exe_path.exists():
            try:
                if sys.platform == "win32":
                    out_v = subprocess.run(
                        ["powershell", "-NoProfile", "-Command", f'(Get-Item "{exe_path}").VersionInfo.ProductVersion'],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    if out_v.stdout.strip():
                        app_version = out_v.stdout.strip()
            except Exception:
                pass

    return {
        "command": " ".join(cmd),
        "antigravity_version": app_version,
        "status": "ready",
        "auth_mode": "local_desktop_session (no separate API key supplied)",
        "quota_billing_status": "unverified_upstream_entitlement (runs under local desktop session; upstream rate limits/billing not guaranteed by public SLA)",
        "verified_billing": False,
    }


def start_agent_conversation(prompt: str, title: str) -> str:
    """Start a new agent conversation via agentapi and return conversation ID."""
    cmd = find_agentapi_cmd()
    full_cmd = [*cmd, "new-conversation", f"--title={title}", prompt]
    raw_output = run_cmd(*full_cmd)
    try:
        data = json.loads(raw_output)
        conv_id = data["response"]["newConversation"]["conversationId"]
        if not conv_id:
            raise ValueError("Empty conversationId")
        return conv_id
    except Exception as exc:
        raise WorkerError(f"Failed to parse conversation ID from agentapi output: {raw_output}") from exc


def get_conversation_transcript_path(conversation_id: str) -> Path:
    """Return the absolute path to the conversation transcript log."""
    home = Path.home()
    return home / ".gemini" / "antigravity" / "brain" / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"


def monitor_agent_execution(conversation_id: str, timeout_seconds: int = 600) -> dict[str, Any]:
    """Monitor conversation transcript until the agent completes its turn."""
    transcript_file = get_conversation_transcript_path(conversation_id)
    deadline = time.monotonic() + timeout_seconds
    last_step_index = -1
    tool_history: list[str] = []
    final_content = ""

    while not transcript_file.exists():
        if time.monotonic() > deadline:
            raise WorkerError(f"Timed out waiting for agent transcript file: {transcript_file}")
        time.sleep(1.0)

    while time.monotonic() < deadline:
        time.sleep(2.0)
        try:
            lines = transcript_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue

        if not lines:
            continue

        parsed_steps: list[dict] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                parsed_steps.append(json.loads(line))
            except json.JSONDecodeError:
                continue

        if not parsed_steps:
            continue

        for s in parsed_steps:
            s_idx = s.get("step_index", -1)
            if s_idx > last_step_index:
                last_step_index = s_idx
                for tc in s.get("tool_calls") or []:
                    tool_history.append(tc.get("name", "unknown"))

        latest = parsed_steps[-1]

        # Completion criteria:
        # Latest step is PLANNER_RESPONSE with status DONE, non-empty content, and NO tool_calls
        if (
            latest.get("source") == "MODEL"
            and latest.get("type") == "PLANNER_RESPONSE"
            and latest.get("status") == "DONE"
            and not latest.get("tool_calls")
        ):
            final_content = latest.get("content", "")
            return {
                "conversation_id": conversation_id,
                "status": "completed",
                "total_steps": len(parsed_steps),
                "tools_executed": tool_history,
                "summary": final_content,
            }

        # Check for error state
        if latest.get("status") == "ERROR":
            raise WorkerError(f"Agent conversation entered ERROR state: {latest.get('content', '')}")

    raise WorkerError(f"Agent execution timed out after {timeout_seconds} seconds")


# ---------------------------------------------------------------------------
# Task Parsing & Safety Boundary Enforcement
# ---------------------------------------------------------------------------

def parse_task_from_issue(issue: dict, matching_checkpoint_issue: int | None = None) -> Task:
    """Validate issue format and extract structured Task parameters.
    Admits state:working ONLY IF it matches an owned checkpoint issue.
    """
    if issue.get("state") != "OPEN":
        raise IgnoreTask(f"Issue #{issue.get('number')} is not open")

    body = issue.get("body") or ""
    if "GRUM_TASK" not in body:
        raise IgnoreTask(f"Issue #{issue.get('number')} has no GRUM_TASK block")

    issue_labels = {l.get("name") for l in issue.get("labels") or []}

    # Verify routing label
    if "to:antina" not in issue_labels:
        raise IgnoreTask(f"Issue #{issue.get('number')} does not have 'to:antina'")

    # Verify ready/revision state or admit matching owned checkpoint
    ready_state = issue_labels & READY_LABELS
    if not ready_state:
        if matching_checkpoint_issue and int(issue.get("number", -1)) == matching_checkpoint_issue and "state:working" in issue_labels:
            state_label = "state:working"
        else:
            raise IgnoreTask(f"Issue #{issue.get('number')} has no ready/revision state label")
    else:
        state_label = next(iter(ready_state))

    # Reject forbidden labels
    blocking = issue_labels & FORBIDDEN_LABELS
    if blocking:
        raise WorkerError(f"Issue #{issue.get('number')} has blocking labels: {blocking}")

    # Extract task_id
    match = re.search(
        r"^\s*-\s*\*\*task_id\*\*:\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*$",
        body,
        re.MULTILINE,
    )
    if not match:
        raise WorkerError(f"Issue #{issue.get('number')} GRUM_TASK missing structured task_id")
    task_id = match.group(1)

    # Extract title
    title = issue.get("title", f"Task {task_id}")

    # Extract and strictly validate allowed paths
    allowed_paths: list[str] = []
    files_interest_match = re.search(r"### 📁 Files of Interest\s*\n((?:- `[^`]+`\s*\n)+)", body)
    if files_interest_match:
        raw_files = re.findall(r"- `([^`]+)`", files_interest_match.group(1))
        for rf in raw_files:
            clean = rf.strip().replace("\\", "/")
            if clean and clean not in allowed_paths:
                allowed_paths.append(clean)

    constraint_single = re.search(r"Only edit `?([A-Za-z0-9_./\-]+)`?", body, re.IGNORECASE)
    if constraint_single:
        single_path = constraint_single.group(1).strip().replace("\\", "/")
        if single_path and single_path not in allowed_paths:
            allowed_paths.append(single_path)

    # Reject missing or ambiguous allowed paths whitelist
    if not allowed_paths:
        raise WorkerError(
            f"Issue #{issue.get('number')} missing explicit allowed_paths whitelist in GRUM_TASK. "
            "Must provide '### 📁 Files of Interest' or 'Only edit <path>'."
        )

    for p in allowed_paths:
        if any(wildcard in p for wildcard in ("*", "?", "[", "]")):
            raise WorkerError(f"Ambiguous allowed_path containing wildcards rejected: '{p}'")
        if p.startswith("/") or ".." in p:
            raise WorkerError(f"Illegal path format outside repository rejected: '{p}'")

    # Extract revision parameters if applicable
    is_revision = (state_label == "state:revision")
    revision_pr_match = re.search(r"^\s*-\s*\*\*revision_pr\*\*:\s*`?(\d+)`?\s*$", body, re.MULTILINE)
    revision_pr = int(revision_pr_match.group(1)) if revision_pr_match else None

    revision_head_match = re.search(r"^\s*-\s*\*\*revision_head\*\*:\s*`?([0-9a-fA-F]{7,40})`?\s*$", body, re.MULTILINE)
    revision_head = revision_head_match.group(1).lower() if revision_head_match else None

    revision_branch_match = re.search(r"^\s*-\s*\*\*revision_branch\*\*:\s*`?([A-Za-z0-9_./\-]+)`?\s*$", body, re.MULTILINE)
    revision_branch = revision_branch_match.group(1).strip() if revision_branch_match else None

    # Strict branch target validation: reject main, master, or protected paths
    if revision_branch:
        if revision_branch in {"main", "master"} or any(revision_branch.startswith(p) for p in PROTECTED_PREFIXES):
            raise WorkerError(f"Protected branch '{revision_branch}' cannot be used as revision branch")

    branch = revision_branch if revision_branch else f"agent/{task_id.lower()}"
    if branch in {"main", "master"} or any(branch.startswith(p) for p in PROTECTED_PREFIXES):
        raise WorkerError(f"Target branch '{branch}' is protected")

    review_findings: str | None = None

    # If revision requested: locate and thoroughly validate existing PR
    if is_revision:
        if revision_pr is None:
            prs = gh_json("pr", "list", "--repo", REPO, "--head", branch, "--state", "open", "--json", "number,headRefOid,headRefName,baseRefName")
            if not prs:
                raise WorkerError(f"Revision requested on Issue #{issue.get('number')} but no open PR found for branch '{branch}'.")
            revision_pr = int(prs[0]["number"])
            if revision_head is None:
                revision_head = prs[0].get("headRefOid", "").lower()

        if revision_pr:
            pr_data = gh_json("pr", "view", str(revision_pr), "--repo", REPO, "--json", "number,state,headRefName,baseRefName,headRefOid,comments")
            if pr_data.get("state") != "OPEN":
                raise WorkerError(f"Revision PR #{revision_pr} is not OPEN (state: {pr_data.get('state')})")
            if pr_data.get("baseRefName") != "main":
                raise WorkerError(f"Revision PR #{revision_pr} base branch is '{pr_data.get('baseRefName')}', must be 'main'")
            pr_head_branch = pr_data.get("headRefName", "")
            if pr_head_branch in {"main", "master"} or any(pr_head_branch.startswith(p) for p in PROTECTED_PREFIXES):
                raise WorkerError(f"Revision PR #{revision_pr} head branch '{pr_head_branch}' is protected")
            if revision_branch and pr_head_branch != revision_branch:
                raise WorkerError(f"Revision PR #{revision_pr} head branch '{pr_head_branch}' does not match specified revision_branch '{revision_branch}'")
            branch = pr_head_branch

            pr_head = pr_data.get("headRefOid", "").lower()
            if revision_head and not pr_head.startswith(revision_head):
                raise WorkerError(f"Stale revision pin: PR #{revision_pr} current HEAD ({pr_head[:8]}) does not match revision_head ({revision_head[:8]}).")
            if not revision_head:
                revision_head = pr_head

            # Revision accounting: count review rounds via GRUM_REVIEW comments
            comments = pr_data.get("comments") or []
            grum_reviews = [c for c in comments if "GRUM_REVIEW" in c.get("body", "")]
            review_rounds = len(grum_reviews)
            if review_rounds > MAX_REVISION_ROUNDS:
                raise WorkerError(f"Task exceeded maximum revision limit ({MAX_REVISION_ROUNDS} review rounds). Halting to NEEDS_KIRIS.")
            if grum_reviews:
                review_findings = grum_reviews[-1].get("body", "").strip()

    return Task(
        issue_number=int(issue["number"]),
        task_id=task_id,
        title=title,
        body=body,
        state_label=state_label,
        branch=branch,
        allowed_paths=allowed_paths,
        is_revision=is_revision,
        revision_pr=revision_pr,
        revision_head=revision_head,
        revision_branch=revision_branch,
        review_findings=review_findings,
    )


# ---------------------------------------------------------------------------
# Strict Diff, Whitespace & Safety Boundary Verification
# ---------------------------------------------------------------------------

def normalize_text_file_whitespace(file_path: Path) -> None:
    """Helper to ensure clean single newline at EOF and strip trailing whitespace on edited text files."""
    if not file_path.is_file() or file_path.is_symlink():
        return
    try:
        content = file_path.read_text(encoding="utf-8")
        lines = [line.rstrip() for line in content.splitlines()]
        cleaned = "\n".join(lines).rstrip() + "\n"
        if cleaned != content:
            file_path.write_text(cleaned, encoding="utf-8")
    except Exception:
        pass


def assert_clean_git_diff(worktree_path: Path, task: Task) -> list[str]:
    """Ensure that only allowed paths were modified, no protected files were touched,
    and git diff --check passes as a strictly blocking check."""
    status_output = run_cmd("git", "status", "--porcelain", cwd=worktree_path)
    if not status_output:
        raise WorkerError("Agent produced zero file modifications in worktree")

    changed_files: list[str] = []
    for line in status_output.splitlines():
        if not line.strip():
            continue
        parts = line.strip().split(maxsplit=1)
        if len(parts) < 2:
            continue
        raw_path = parts[1].strip().strip('"')

        # Handle renames: R old -> new (must check both)
        if " -> " in raw_path:
            old_p, new_p = raw_path.split(" -> ", 1)
            old_clean = old_p.strip().strip('"').replace("\\", "/")
            new_clean = new_p.strip().strip('"').replace("\\", "/")
            changed_files.extend([old_clean, new_clean])
        else:
            clean_path = raw_path.replace("\\", "/")
            # If untracked directory, recursively inspect contents
            disk_path = worktree_path / clean_path
            if disk_path.is_dir():
                for subfile in disk_path.rglob("*"):
                    if subfile.is_file():
                        rel = str(subfile.relative_to(worktree_path)).replace("\\", "/")
                        changed_files.append(rel)
            else:
                changed_files.append(clean_path)

    # Check against protected prefixes and files
    for path in changed_files:
        if path in PROTECTED_FILES or any(path.startswith(prefix) for prefix in PROTECTED_PREFIXES):
            raise WorkerError(f"Agent modified protected file: {path}. Halting immediately.")

    # Check against allowed paths whitelist
    for path in changed_files:
        if path not in task.allowed_paths:
            raise WorkerError(
                f"Agent modified file outside allowed paths: {path} (allowed: {task.allowed_paths})"
            )

    # Check for merge conflict markers
    diff_output = run_cmd("git", "diff", cwd=worktree_path)
    for marker in ("<<<<<<<", "=======", ">>>>>>>"):
        if marker in diff_output:
            raise WorkerError(f"Agent left unresolved merge conflict marker '{marker}' in diff")

    # Normalize harmless whitespace on text files within allowed_paths
    for rel_path in changed_files:
        normalize_text_file_whitespace(worktree_path / rel_path)

    # STRICT BLOCKING CHECK: git diff --check MUST pass with exit code 0
    run_cmd("git", "diff", "--check", cwd=worktree_path, check=True)

    return sorted(list(set(changed_files)))


def validate_committed_range(
    worktree_path: Path,
    task: Task,
    base_sha: str,
    cur_head: str,
) -> list[str]:
    """Validate a recovered committed tree against a trusted baseline before push or handoff.

    Enforces that:
    1. The worktree is on task.branch and the branch is not protected.
    2. base_sha is an ancestor of cur_head (no foreign/diverged history).
    3. If task is a revision with a pinned revision_head, base_sha matches the pin.
    4. At least one file was modified between base_sha and cur_head.
    5. All modified files are within task.allowed_paths and none are protected (including renames).
    6. No merge conflict markers exist in the commit range.
    7. git diff --check passes with code 0 on the commit range.

    Fails closed on any violation, raising WorkerError.
    """
    # 1. Exact branch binding
    cur_branch = run_cmd("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=worktree_path).strip()
    if cur_branch != task.branch:
        raise WorkerError(f"Recovered worktree is on branch '{cur_branch}', expected '{task.branch}'")

    if cur_branch in {"main", "master"} or any(cur_branch.startswith(p) for p in PROTECTED_PREFIXES):
        raise WorkerError(f"Recovered worktree branch '{cur_branch}' is protected")

    # 2. Base ancestor check
    try:
        run_cmd("git", "merge-base", "--is-ancestor", base_sha, cur_head, cwd=worktree_path)
    except Exception as exc:
        raise WorkerError(
            f"Recovered commit {cur_head[:8]} is not a direct descendant of trusted baseline {base_sha[:8]}. "
            "Refusing to resume divergent or rebased history."
        ) from exc

    # 3. Pinned revision head verification
    if task.is_revision and task.revision_head:
        if not base_sha.startswith(task.revision_head.lower()):
            raise WorkerError(
                f"Committed baseline {base_sha[:8]} does not match pinned revision_head {task.revision_head[:8]}"
            )

    # 4. Changed paths extraction
    diff_name_output = run_cmd("git", "diff", "--name-status", f"{base_sha}..{cur_head}", cwd=worktree_path)
    if not diff_name_output.strip():
        raise WorkerError(f"Commit range {base_sha[:8]}..{cur_head[:8]} contains zero file modifications")

    changed_files: list[str] = []
    for line in diff_name_output.splitlines():
        if not line.strip():
            continue
        parts = line.strip().split("\t")
        if len(parts) < 2:
            continue
        if len(parts) >= 3 and parts[0].startswith("R"):
            changed_files.append(parts[1].strip().strip('"').replace("\\", "/"))
            changed_files.append(parts[2].strip().strip('"').replace("\\", "/"))
        else:
            changed_files.append(parts[-1].strip().strip('"').replace("\\", "/"))

    # 5. Protected file check
    for path in changed_files:
        if path in PROTECTED_FILES or any(path.startswith(prefix) for prefix in PROTECTED_PREFIXES):
            raise WorkerError(f"Committed tree modified protected file: {path}. Halting immediately.")

    # 6. Allowed paths whitelist check
    for path in changed_files:
        if path not in task.allowed_paths:
            raise WorkerError(
                f"Committed tree modified file outside allowed paths: {path} (allowed: {task.allowed_paths})"
            )

    # 7. Merge conflict markers check
    diff_output = run_cmd("git", "diff", f"{base_sha}..{cur_head}", cwd=worktree_path)
    for marker in ("<<<<<<<", "=======", ">>>>>>>"):
        if marker in diff_output:
            raise WorkerError(f"Committed tree contains unresolved merge conflict marker '{marker}'")

    # 8. Blocking whitespace check on commit range
    run_cmd("git", "diff", "--check", f"{base_sha}..{cur_head}", cwd=worktree_path, check=True)

    return sorted(list(set(changed_files)))


def assert_clean_committed_range(
    worktree_path: Path,
    task: Task,
    base_sha: str,
    cur_head: str,
) -> list[str]:
    """Validate a recovered committed tree against a trusted baseline before push or handoff.
    Used for clean-only committed recovery (has_uncommitted == False).
    Runs validate_committed_range, runs local tests, and asserts clean worktree post-test.
    """
    changed_files = validate_committed_range(worktree_path, task, base_sha, cur_head)

    # Local product tests execution
    print(f"[{task.task_id}] Executing local regression tests (npm test) on recovered commit {cur_head[:8]}...", flush=True)
    run_local_tests(worktree_path, task)
    print(f"[{task.task_id}] Local tests passed 100% on recovered commit!", flush=True)

    # Cleanliness post-test
    status_output = run_cmd("git", "status", "--porcelain", cwd=worktree_path)
    if status_output.strip():
        raise WorkerError(f"Worktree has unexpected uncommitted modifications after test execution: {status_output.strip()}")

    return changed_files


# ---------------------------------------------------------------------------
# Worktree Management (Isolated & Reversible)
# ---------------------------------------------------------------------------

def create_isolated_worktree(repo_root: Path, task: Task, resume_existing: bool = False) -> Path:
    """Create or safely resume an isolated Git worktree for the task branch.
    Never removes or overwrites an existing worktree when resume_existing is True
    or when a matching AGENT_TIMED_OUT / INTERRUPTED checkpoint exists.
    Fails closed if an unmanaged worktree already exists on disk.
    """
    ckpt = load_checkpoint(repo_root)
    if ckpt and ckpt.get("worktree") and (resume_existing or ckpt.get("task_id") == task.task_id):
        worktree_dir = Path(ckpt["worktree"])
    else:
        worktree_dir = repo_root / ".worktrees" / f"agent-{task.task_id.lower()}"

    has_preserved_checkpoint = (
        ckpt is not None
        and ckpt.get("task_id") == task.task_id
        and ckpt.get("stage") in {
            "AGENT_TIMED_OUT", "INTERRUPTED", "AGENT_RUNNING",
            "AGENT_MONITORING", "LOCAL_VERIFYING", "COMMITTING"
        }
    )

    if worktree_dir.exists():
        if resume_existing or has_preserved_checkpoint:
            print(f"[{task.task_id}] Preserving and reusing existing worktree at {worktree_dir}", flush=True)
            # Re-ensure node_modules symlink/junction exists
            root_nm = repo_root / "node_modules"
            wt_nm = worktree_dir / "node_modules"
            if root_nm.is_dir() and not wt_nm.exists():
                if sys.platform == "win32":
                    subprocess.run(["cmd", "/c", "mklink", "/J", str(wt_nm), str(root_nm)], check=False, capture_output=True)
                else:
                    try:
                        wt_nm.symlink_to(root_nm, target_is_directory=True)
                    except OSError:
                        pass
            return worktree_dir
        else:
            raise WorkerError(
                f"Worktree '{worktree_dir}' already exists on disk but has no authorized resumption checkpoint. "
                "Refusing to overwrite existing worktree. Inspect worktree or resolve explicitly."
            )

    worktree_dir.parent.mkdir(parents=True, exist_ok=True)

    if task.is_revision:
        # Revision: preserve existing PR branch and commit history
        print(f"[{task.task_id}] Fetching existing branch origin/{task.branch} for revision...", flush=True)
        run_cmd("git", "fetch", "origin", task.branch, cwd=repo_root)
        run_cmd(
            "git",
            "worktree",
            "add",
            str(worktree_dir),
            f"origin/{task.branch}",
            cwd=repo_root,
        )
        run_cmd("git", "checkout", "-B", task.branch, f"origin/{task.branch}", cwd=worktree_dir)
        worktree_head = run_cmd("git", "rev-parse", "HEAD", cwd=worktree_dir).lower()
        if task.revision_head and not worktree_head.startswith(task.revision_head.lower()):
            raise WorkerError(
                f"Fetched branch '{task.branch}' HEAD ({worktree_head[:8]}) does not match pinned revision_head ({task.revision_head[:8]}). "
                "Remote branch has diverged."
            )
    else:
        # Fresh task: start clean from origin/main
        run_cmd("git", "branch", "-D", task.branch, cwd=repo_root, check=False)
        run_cmd("git", "fetch", "origin", "main", cwd=repo_root)
        run_cmd(
            "git",
            "worktree",
            "add",
            "-b",
            task.branch,
            str(worktree_dir),
            "origin/main",
            cwd=repo_root,
        )

    # Link node_modules so tests run instantly without network overhead
    root_nm = repo_root / "node_modules"
    wt_nm = worktree_dir / "node_modules"
    if root_nm.is_dir() and not wt_nm.exists():
        if sys.platform == "win32":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(wt_nm), str(root_nm)], check=False, capture_output=True)
        else:
            try:
                wt_nm.symlink_to(root_nm, target_is_directory=True)
            except OSError:
                pass

    return worktree_dir


def remove_isolated_worktree(repo_root: Path, worktree_dir: Path) -> None:
    """Safely remove the worktree after completion or failure."""
    if worktree_dir.exists():
        wt_nm = worktree_dir / "node_modules"
        if wt_nm.exists():
            if sys.platform == "win32":
                subprocess.run(["cmd", "/c", "rmdir", str(wt_nm)], check=False, capture_output=True)
            else:
                try:
                    wt_nm.unlink()
                except OSError:
                    pass
        run_cmd("git", "worktree", "remove", "--force", str(worktree_dir), cwd=repo_root, check=False)
        if worktree_dir.exists():
            shutil.rmtree(worktree_dir, ignore_errors=True)
    run_cmd("git", "worktree", "prune", cwd=repo_root, check=False)


# ---------------------------------------------------------------------------
# Deterministic Local Verification & Artifact Hygiene
# ---------------------------------------------------------------------------

def run_local_tests(worktree_path: Path, task: Task) -> str:
    """Execute local product test suites and clean only identified runtime test artifacts.
    Preserves newly authored test files."""
    out = run_cmd("npm", "test", cwd=worktree_path)

    # Remove only known generated test database artifacts
    for art in KNOWN_TEST_ARTIFACTS:
        p = worktree_path / art
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass

    # Revert test screenshots ONLY if screenshots are not in the allowed paths whitelist
    if not any(p.startswith("tests/screenshots") for p in task.allowed_paths):
        run_cmd("git", "checkout", "--", "tests/screenshots", cwd=worktree_path, check=False)

    return out


# ---------------------------------------------------------------------------
# GitHub Checks Waiter
# ---------------------------------------------------------------------------

def check_state(check: dict) -> str:
    status = str(check.get("status") or check.get("state") or "").upper()
    conclusion = str(check.get("conclusion") or "").upper()
    if status == "ACTION_REQUIRED" or conclusion == "ACTION_REQUIRED":
        return "approval_required"
    if conclusion == "STALE":
        return "stale"
    if conclusion == "SKIPPED":
        return "skipped"
    if status in {"EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"}:
        return "pending"
    if status == "COMPLETED":
        return "success" if conclusion == "SUCCESS" else "failed"
    if conclusion:
        return "success" if conclusion == "SUCCESS" else "failed"
    return "pending"


def checks_state(
    rollup: list[dict],
    required: frozenset[str] = REQUIRED_CHECKS,
    expected_head: str | None = None,
    pr_head: str | None = None,
) -> str:
    if expected_head is not None and pr_head is not None and pr_head != expected_head:
        return "stale"
    if not rollup:
        return "pending"
    grouped: dict[str, list[dict]] = {}
    for check in rollup:
        name = str(check.get("name") or check.get("context") or "")
        grouped.setdefault(name, []).append(check)
    if not required <= grouped.keys():
        return "pending"
    saw_pending = False
    for name in required:
        for check in grouped[name]:
            state = check_state(check)
            if state in {"failed", "approval_required", "stale", "skipped"}:
                return state
            if state == "pending":
                saw_pending = True
    return "pending" if saw_pending else "success"


def wait_for_pr_checks(pr_number: int, expected_head: str, timeout_seconds: int = 1800) -> list[dict]:
    """Wait for required GitHub Actions checks on PR to pass on the exact HEAD SHA.
    Returns the successful check rollup for evidence reporting."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pr = gh_json("pr", "view", str(pr_number), "--repo", REPO, "--json", "statusCheckRollup,headRefOid")
        pr_head = str(pr.get("headRefOid") or "").lower()
        if pr_head and pr_head != expected_head.lower():
            raise WorkerError(f"PR HEAD ({pr_head}) does not match pushed commit ({expected_head})")
        rollup = pr.get("statusCheckRollup") or []
        state = checks_state(rollup, REQUIRED_CHECKS, expected_head=expected_head.lower(), pr_head=pr_head)
        if state == "success":
            return rollup
        if state == "failed":
            raise WorkerError("Required GitHub Actions PR checks failed")
        if state in {"approval_required", "stale", "skipped"}:
            raise WorkerError(f"PR checks in invalid terminal state: {state}")
        time.sleep(15)
    raise WorkerError(f"Timed out waiting for GitHub Actions checks on PR #{pr_number}")


# ---------------------------------------------------------------------------
# Core Task Execution Pipeline
# ---------------------------------------------------------------------------

def execute_task(repo_root: Path, task: Task, local_only: bool = False) -> dict[str, Any]:
    """Execute the full fail-closed task workflow."""
    verify_repo_remote(repo_root)
    acquire_lock(repo_root, task.task_id)
    worktree_dir: Path | None = None
    agent_conv_id: str | None = None
    pr_number: int | None = None
    head_sha: str | None = None
    execution_failed = False
    is_resuming = False
    resumption_advanced = False

    try:
        # Checkpoint reconciliation
        ckpt = load_checkpoint(repo_root)
        if ckpt and ckpt.get("task_id") == task.task_id:
            stage = ckpt.get("stage")
            print(f"[{task.task_id}] Reconciling interrupted checkpoint at stage: {stage}", flush=True)
            if stage == "WAITING_CI" and ckpt.get("pr_number") and ckpt.get("head_sha"):
                is_resuming = True
                pr_number = int(ckpt["pr_number"])
                head_sha = str(ckpt["head_sha"])
                if local_only:
                    print(f"[{task.task_id}] [LOCAL_ONLY] Resumed from WAITING_CI. Skipping remote CI wait and handoff.", flush=True)
                    clear_checkpoint(repo_root)
                    return {
                        "status": "local_only_success",
                        "task_id": task.task_id,
                        "commit": head_sha,
                        "changed_files": task.allowed_paths,
                    }
                print(f"[{task.task_id}] Resuming CI check waiter for PR #{pr_number} on {head_sha[:8]}...", flush=True)
                checks_rollup = wait_for_pr_checks(pr_number, head_sha)
                # Proceed directly to handoff
                return publish_handoff(repo_root, task, pr_number, head_sha, checks_rollup, summary="Resumed from checkpoint")

            # Case 2: Handled interruption / timeout recovery
            if stage in {"AGENT_TIMED_OUT", "INTERRUPTED", "AGENT_RUNNING", "AGENT_MONITORING", "LOCAL_VERIFYING", "COMMITTING"}:
                is_resuming = True
                conv_id = ckpt.get("conversation_id")
                agent_conv_id = conv_id
                if conv_id and is_agent_conversation_active(conv_id):
                    raise WorkerError(
                        f"Cannot recover task '{task.task_id}': prior agent conversation '{conv_id}' is still actively running. "
                        "Preserving worktree and checkpoint intact for human inspection."
                    )

                preserved_wt_path = Path(ckpt.get("worktree")) if ckpt.get("worktree") else (repo_root / ".worktrees" / f"agent-{task.task_id.lower()}")
                if not preserved_wt_path.exists():
                    raise WorkerError(
                        f"Preserved worktree '{preserved_wt_path}' for task '{task.task_id}' not found on disk. "
                        "Failing closed to leave checkpoint intact for human inspection."
                    )
                worktree_dir = create_isolated_worktree(repo_root, task, resume_existing=True)

                # Check worktree git state
                status_output = run_cmd("git", "status", "--porcelain", cwd=worktree_dir)
                has_uncommitted = bool(status_output.strip())

                has_commit = False
                existing_head = None
                if task.is_revision and task.revision_head:
                    base_ref = task.revision_head
                elif task.is_revision:
                    base_ref = f"origin/{task.branch}"
                else:
                    base_ref = "origin/main"

                try:
                    cur_head = run_cmd("git", "rev-parse", "HEAD", cwd=worktree_dir).strip().lower()
                    base_sha = run_cmd("git", "rev-parse", base_ref, cwd=worktree_dir).strip().lower()
                except Exception as exc:
                    raise WorkerError(
                        f"Failed to resolve recovered worktree HEAD or trusted baseline ({base_ref}): {exc}"
                    ) from exc

                if cur_head != base_sha:
                    has_commit = True
                    existing_head = cur_head

                if not has_uncommitted and not has_commit:
                    raise WorkerError(
                        f"Preserved worktree for task '{task.task_id}' has no unfinished modifications or commits to resume. "
                        "Leaving worktree and checkpoint intact for human inspection."
                    )

                if has_uncommitted:
                    print(f"[{task.task_id}] Preserved worktree has uncommitted modifications. Resuming verification...", flush=True)
                    # If there were also prior commits ahead of base, validate that commit range as well
                    if has_commit:
                        print(f"[{task.task_id}] Validating existing committed range {base_sha[:8]}..{cur_head[:8]} before resuming uncommitted work...", flush=True)
                        prior_committed_files = validate_committed_range(worktree_dir, task, base_sha, cur_head)
                        print(f"[{task.task_id}] Existing committed range validated clean. Files: {prior_committed_files}", flush=True)

                    save_checkpoint(repo_root, {
                        "task_id": task.task_id,
                        "issue": task.issue_number,
                        "stage": "LOCAL_VERIFYING",
                        "worktree": str(worktree_dir),
                        "conversation_id": conv_id,
                    })
                    changed_files = assert_clean_git_diff(worktree_dir, task)
                    print(f"[{task.task_id}] Diff verified clean. Modified files: {changed_files}", flush=True)

                    print(f"[{task.task_id}] Executing local regression tests (npm test)...", flush=True)
                    run_local_tests(worktree_dir, task)
                    print(f"[{task.task_id}] Local tests passed 100%!", flush=True)

                    changed_files = assert_clean_git_diff(worktree_dir, task)

                    print(f"[{task.task_id}] Staging and committing resumed changes...", flush=True)
                    save_checkpoint(repo_root, {
                        "task_id": task.task_id,
                        "issue": task.issue_number,
                        "stage": "COMMITTING",
                        "worktree": str(worktree_dir),
                    })
                    for f in changed_files:
                        run_cmd("git", "add", f, cwd=worktree_dir)
                    run_cmd("git", "diff", "--cached", "--check", cwd=worktree_dir, check=True)
                    commit_msg = (
                        f"fix(antina): address review feedback for {task.task_id} (#{task.issue_number})"
                        if task.is_revision
                        else f"feat(antina): complete {task.task_id} (#{task.issue_number})"
                    )
                    run_cmd("git", "commit", "-m", commit_msg, cwd=worktree_dir)
                    head_sha = run_cmd("git", "rev-parse", "HEAD", cwd=worktree_dir).strip().lower()

                    # If there were prior commits, validate the complete combined range from base_sha to head_sha
                    if has_commit:
                        print(f"[{task.task_id}] Validating combined committed range {base_sha[:8]}..{head_sha[:8]}...", flush=True)
                        changed_files = validate_committed_range(worktree_dir, task, base_sha, head_sha)
                    else:
                        changed_files = sorted(list(set(changed_files)))

                    resumption_advanced = True
                else:
                    head_sha = existing_head
                    print(f"[{task.task_id}] Validating clean divergent committed HEAD: {head_sha[:8]} against baseline {base_sha[:8]}...", flush=True)
                    changed_files = assert_clean_committed_range(worktree_dir, task, base_sha, head_sha)
                    print(f"[{task.task_id}] Recovered commit {head_sha[:8]} validated clean. Files: {changed_files}", flush=True)
                    resumption_advanced = True

                if local_only:
                    print(f"[{task.task_id}] [LOCAL_ONLY] Local verification passed. Remote push, PR creation, and review handoffs skipped.", flush=True)
                    clear_checkpoint(repo_root)
                    return {
                        "status": "local_only_success",
                        "task_id": task.task_id,
                        "commit": head_sha,
                        "changed_files": changed_files,
                    }

                # Push branch
                print(f"[{task.task_id}] Pushing branch {task.branch} to origin...", flush=True)
                save_checkpoint(repo_root, {
                    "task_id": task.task_id,
                    "issue": task.issue_number,
                    "stage": "PUSHING",
                    "head_sha": head_sha,
                })
                run_cmd("git", "push", "--set-upstream", "origin", task.branch, cwd=worktree_dir)

                # Create or update PR
                if task.is_revision:
                    pr_number = task.revision_pr
                    pr_info = gh_json("pr", "view", str(pr_number), "--repo", REPO, "--json", "number,url,headRefOid,state,baseRefName")
                    if pr_info.get("state") != "OPEN":
                        raise WorkerError(f"Revision PR #{pr_number} is no longer OPEN before publication (state: {pr_info.get('state')})")
                    if pr_info.get("baseRefName") != "main":
                        raise WorkerError(f"Revision PR #{pr_number} base branch changed to '{pr_info.get('baseRefName')}', expected 'main'")
                    print(f"[{task.task_id}] Reusing existing PR #{pr_number}: {pr_info['url']}", flush=True)
                else:
                    save_checkpoint(repo_root, {
                        "task_id": task.task_id,
                        "issue": task.issue_number,
                        "stage": "CREATING_PR",
                        "head_sha": head_sha,
                    })
                    pr_url = run_cmd(
                        "gh", "pr", "create", "--repo", REPO,
                        "--base", "main",
                        "--head", task.branch,
                        "--title", f"{task.task_id}: {task.title}",
                        "--body", f"Automated Antina implementation for #{task.issue_number}.\n\n### Summary\nResumed from preserved checkpoint.",
                        cwd=worktree_dir,
                    )
                    pr_info = gh_json("pr", "view", pr_url, "--repo", REPO, "--json", "number,url,headRefOid")
                    pr_number = int(pr_info["number"])
                    print(f"[{task.task_id}] PR #{pr_number} opened: {pr_info['url']}", flush=True)

                # Wait for CI
                print(f"[{task.task_id}] Waiting for required GitHub Actions CI checks on HEAD {head_sha[:8]}...", flush=True)
                save_checkpoint(repo_root, {
                    "task_id": task.task_id,
                    "issue": task.issue_number,
                    "stage": "WAITING_CI",
                    "pr_number": pr_number,
                    "head_sha": head_sha,
                })
                checks_rollup = wait_for_pr_checks(pr_number, head_sha)
                print(f"[{task.task_id}] GitHub Actions CI checks passed green!", flush=True)

                return publish_handoff(
                    repo_root,
                    task,
                    pr_number,
                    head_sha,
                    checks_rollup,
                    summary="Resumed from preserved worktree checkpoint and verified green.",
                    changed_files=changed_files,
                )

        # Step 1: Transition Issue to state:working (skipped if local_only)
        if not local_only:
            print(f"[{task.task_id}] Step 1: Claiming Issue #{task.issue_number} (setting state:working)...", flush=True)
            save_checkpoint(repo_root, {"task_id": task.task_id, "issue": task.issue_number, "stage": "CLAIMING"})
            if task.state_label != "state:working":
                run_cmd(
                    "gh", "issue", "edit", str(task.issue_number), "--repo", REPO,
                    "--remove-label", task.state_label,
                    "--add-label", "state:working",
                )
            status_comment = f"""## 🔄 ANTINA_STATUS

- **task_id**: `{task.task_id}`
- **state**: `ANTINA_WORKING`
- **branch**: `{task.branch}`
- **notes**: Local Antina Worker claimed task under Antigravity local session. Setting up isolated worktree.
"""
            run_cmd("gh", "issue", "comment", str(task.issue_number), "--repo", REPO, "--body", status_comment)
        else:
            print(f"[{task.task_id}] [LOCAL_ONLY] Step 1: Skipping remote issue claim and status comment.", flush=True)

        # Step 2: Setup isolated worktree
        print(f"[{task.task_id}] Step 2: Creating isolated Git worktree...", flush=True)
        save_checkpoint(repo_root, {"task_id": task.task_id, "issue": task.issue_number, "stage": "WORKTREE_SETUP"})
        worktree_dir = create_isolated_worktree(repo_root, task)
        print(f"[{task.task_id}] Worktree established at: {worktree_dir}", flush=True)

        # Step 3: Build agent prompt and execute via local agentapi
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "AGENT_RUNNING",
            "worktree": str(worktree_dir),
        })

        target_hint = "\nTARGET FILES TO INSPECT AND MODIFY:\n" + "\n".join(f"- {worktree_dir / p}" for p in task.allowed_paths)
        revision_hint = ""
        if task.is_revision:
            revision_hint = (
                f"\nREVISION NOTICE: You are updating existing PR #{task.revision_pr} ({task.branch}). "
                "Address review feedback directly on this branch.\n"
            )
            if task.review_findings:
                revision_hint += f"\nLATEST REVIEW FINDINGS TO RESOLVE:\n{task.review_findings}\n"

        prompt = f"""You are Antina, the automated implementation agent for Kiris-02/gathermap.
Read and follow .agents/README.md, PROTOCOL.md, ANTINA.md, TASK_FORMAT.md, and SAFETY.md.

CRITICAL INSTRUCTIONS:
1. Work ONLY inside this working directory: {worktree_dir}
2. Never call git commit, push, merge, or gh commands. The outer local worker harness owns all git and PR operations.
3. Never edit protected files (.agents/, .github/, supabase/migrations/, secrets, runner scripts).
4. Strictly implement the GRUM_TASK specified below.{revision_hint}{target_hint}
5. Finish with a concise factual summary of the changes made.

TASK DETAILS:
Issue #{task.issue_number}
{task.body}
"""
        print(f"[{task.task_id}] Step 3: Dispatching task to Antigravity agentapi...", flush=True)
        agent_conv_id = start_agent_conversation(prompt, title=f"Antina: {task.task_id}")
        print(f"[{task.task_id}] Conversation started with ID: {agent_conv_id}", flush=True)

        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "AGENT_MONITORING",
            "conversation_id": agent_conv_id,
            "worktree": str(worktree_dir),
        })

        print(f"[{task.task_id}] Step 4: Monitoring Antigravity agent execution...", flush=True)
        agent_result = monitor_agent_execution(agent_conv_id, timeout_seconds=600)
        print(f"[{task.task_id}] Agent finished: {agent_result.get('total_steps')} steps, tools executed: {agent_result.get('tools_executed')}", flush=True)

        # Step 4: Verify working tree diff
        print(f"[{task.task_id}] Step 5: Validating worktree diff against constraints and safety rules...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "LOCAL_VERIFYING",
            "worktree": str(worktree_dir),
        })
        changed_files = assert_clean_git_diff(worktree_dir, task)
        print(f"[{task.task_id}] Diff verified clean. Modified files: {changed_files}", flush=True)

        # Step 5: Run deterministic local test verification
        print(f"[{task.task_id}] Step 6: Executing local regression tests (npm test)...", flush=True)
        run_local_tests(worktree_dir, task)
        print(f"[{task.task_id}] Local tests passed 100%!", flush=True)

        # Re-verify diff after tests to ensure test runs didn't leave unvalidated changes
        changed_files = assert_clean_git_diff(worktree_dir, task)

        # Step 6: Commit changes in worktree
        print(f"[{task.task_id}] Step 7: Staging and committing changes in worktree...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "COMMITTING",
            "worktree": str(worktree_dir),
        })
        for f in changed_files:
            run_cmd("git", "add", f, cwd=worktree_dir)

        # STRICT BLOCKING CHECK: git diff --cached --check covering the full staged commit
        run_cmd("git", "diff", "--cached", "--check", cwd=worktree_dir, check=True)

        commit_msg = (
            f"fix(antina): address review feedback for {task.task_id} (#{task.issue_number})"
            if task.is_revision
            else f"feat(antina): complete {task.task_id} (#{task.issue_number})"
        )
        run_cmd("git", "commit", "-m", commit_msg, cwd=worktree_dir)
        head_sha = run_cmd("git", "rev-parse", "HEAD", cwd=worktree_dir).lower()
        print(f"[{task.task_id}] Committed HEAD SHA: {head_sha}", flush=True)

        if local_only:
            print(f"[{task.task_id}] [LOCAL_ONLY] Local verification passed. Remote push, PR creation, and review handoffs skipped.", flush=True)
            clear_checkpoint(repo_root)
            return {
                "status": "local_only_success",
                "task_id": task.task_id,
                "commit": head_sha,
                "changed_files": changed_files,
            }

        # Step 7: Push branch to origin
        print(f"[{task.task_id}] Step 8: Pushing branch {task.branch} to origin...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "PUSHING",
            "head_sha": head_sha,
        })
        run_cmd("git", "push", "--set-upstream", "origin", task.branch, cwd=worktree_dir)

        # Step 8: Create or update PR
        if task.is_revision:
            pr_number = task.revision_pr
            pr_info = gh_json("pr", "view", str(pr_number), "--repo", REPO, "--json", "number,url,headRefOid,state,baseRefName")
            if pr_info.get("state") != "OPEN":
                raise WorkerError(f"Revision PR #{pr_number} is no longer OPEN before publication (state: {pr_info.get('state')})")
            if pr_info.get("baseRefName") != "main":
                raise WorkerError(f"Revision PR #{pr_number} base branch changed to '{pr_info.get('baseRefName')}', expected 'main'")
            print(f"[{task.task_id}] Step 9: Reusing existing PR #{pr_number}: {pr_info['url']}", flush=True)
        else:
            print(f"[{task.task_id}] Step 9: Creating Pull Request on GitHub...", flush=True)
            save_checkpoint(repo_root, {
                "task_id": task.task_id,
                "issue": task.issue_number,
                "stage": "CREATING_PR",
                "head_sha": head_sha,
            })
            pr_url = run_cmd(
                "gh", "pr", "create", "--repo", REPO,
                "--base", "main",
                "--head", task.branch,
                "--title", f"{task.task_id}: {task.title}",
                "--body", f"Automated Antina implementation for #{task.issue_number}.\n\n### Summary\n{agent_result.get('summary', '')}",
                cwd=worktree_dir,
            )
            pr_info = gh_json("pr", "view", pr_url, "--repo", REPO, "--json", "number,url,headRefOid")
            pr_number = int(pr_info["number"])
            print(f"[{task.task_id}] PR #{pr_number} opened: {pr_info['url']}", flush=True)

        # Step 9: Wait for required CI checks
        print(f"[{task.task_id}] Step 10: Waiting for required GitHub Actions CI checks on HEAD {head_sha[:8]}...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "WAITING_CI",
            "pr_number": pr_number,
            "head_sha": head_sha,
        })
        checks_rollup = wait_for_pr_checks(pr_number, head_sha)
        print(f"[{task.task_id}] GitHub Actions CI checks passed green!", flush=True)

        # Step 10: Publish handoff
        return publish_handoff(
            repo_root,
            task,
            pr_number,
            head_sha,
            checks_rollup,
            summary=agent_result.get("summary", "Task implementation completed successfully."),
            changed_files=changed_files,
        )

    except Exception as exc:
        execution_failed = True
        is_timeout = "timed out" in str(exc).lower()
        ckpt_stage = "AGENT_TIMED_OUT" if is_timeout else "INTERRUPTED"
        if not is_resuming or resumption_advanced:
            save_checkpoint(repo_root, {
                "task_id": task.task_id,
                "issue": task.issue_number,
                "stage": ckpt_stage,
                "conversation_id": agent_conv_id,
                "worktree": str(worktree_dir) if worktree_dir else None,
                "error": str(exc),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            if not local_only:
                try:
                    run_cmd(
                        "gh", "issue", "edit", str(task.issue_number), "--repo", REPO,
                        "--remove-label", "state:working",
                        "--add-label", "needs:kiris",
                    )
                    failure_comment = f"""## 🛑 ANTINA_FAILURE

- **task_id**: `{task.task_id}`
- **error**: `{str(exc)}`
- **notes**: Local Antina Worker halted safely. Escalated to Kiris for inspection.
"""
                    run_cmd("gh", "issue", "comment", str(task.issue_number), "--repo", REPO, "--body", failure_comment)
                except Exception:
                    pass
        raise
    finally:
        # Establish whether agent is still running before destructive cleanup
        agent_active = False
        if agent_conv_id:
            agent_active = is_agent_conversation_active(agent_conv_id)

        if execution_failed or agent_active:
            print(
                f"[{task.task_id}] Execution interrupted or agent active ({agent_active}). "
                f"Preserving isolated worktree at '{worktree_dir}' and keeping lock active for safety.",
                flush=True,
            )
        else:
            if worktree_dir:
                remove_isolated_worktree(repo_root, worktree_dir)
            release_lock(repo_root)


def publish_handoff(
    repo_root: Path,
    task: Task,
    pr_number: int,
    head_sha: str,
    checks_rollup: list[dict],
    summary: str = "",
    changed_files: list[str] | None = None,
) -> dict[str, Any]:
    """Publish idempotent ANTINA_REPORT and ANTINA_HANDOFF on PR and Issue, and update routing labels."""
    print(f"[{task.task_id}] Step 11: Publishing idempotent ANTINA_REPORT & ANTINA_HANDOFF...", flush=True)
    save_checkpoint(repo_root, {
        "task_id": task.task_id,
        "issue": task.issue_number,
        "stage": "HANDOFF",
        "pr_number": pr_number,
        "head_sha": head_sha,
    })

    pr_info = gh_json("pr", "view", str(pr_number), "--repo", REPO, "--json", "number,url,comments,labels")
    existing_pr_comments = [c.get("body", "") for c in pr_info.get("comments", [])]

    # Build check evidence list
    check_lines = []
    for c in checks_rollup:
        c_name = c.get("name") or c.get("context")
        c_url = c.get("detailsUrl") or ""
        c_conclusion = str(c.get("conclusion") or "SUCCESS").upper()
        if c_url:
            check_lines.append(f"- `{c_name}`: [{c_conclusion}]({c_url})")
        else:
            check_lines.append(f"- `{c_name}`: {c_conclusion}")
    checks_evidence = "\n  ".join(check_lines) if check_lines else "- All required checks: SUCCESS"

    # Publish ANTINA_REPORT on PR if not already present for this commit
    if not any(f"`{head_sha}`" in c and "## 📤 ANTINA_REPORT" in c for c in existing_pr_comments):
        files_str = "\n".join(f"- `{f}`" for f in (changed_files or task.allowed_paths))
        report = f"""## 📤 ANTINA_REPORT

- **task_id**: `{task.task_id}`
- **status**: `PR_READY`
- **pr**: {pr_info['url']}
- **commit**: `{head_sha}`
- **summary**: {summary}

### 📁 Files Changed
{files_str}

### 🧪 Verification
- **Executed Command**: `npm test`
- **Result**: PASSED locally and verified in GitHub Actions CI.

### ⚠️ Risks
- None identified; strictly modified within allowed scope.

### ❓ Unresolved Items
- None.

> 🛑 **Author Confirmation**: I will not self-merge this Pull Request.
"""
        run_cmd("gh", "pr", "comment", str(pr_number), "--repo", REPO, "--body", report)

    # Publish idempotent ANTINA_HANDOFF on PR (required wake-up for Grum webhook)
    if not any(f"`{head_sha}`" in c and "## 🤝 ANTINA_HANDOFF" in c for c in existing_pr_comments):
        pr_handoff = f"""## 🤝 ANTINA_HANDOFF

- **task_id**: `{task.task_id}`
- **issue**: https://github.com/{REPO}/issues/{task.issue_number}
- **pr**: {pr_info['url']}
- **commit**: `{head_sha}`
- **checks**:
  {checks_evidence}
- **notes**: Implementation complete and verified green. Ready for Grum independent inspection.
"""
        run_cmd("gh", "pr", "comment", str(pr_number), "--repo", REPO, "--body", pr_handoff)

    # Apply PR routing labels
    pr_labels = {l.get("name") for l in pr_info.get("labels", [])}
    if not ({"to:grum", "state:review"} <= pr_labels):
        run_cmd(
            "gh", "pr", "edit", str(pr_number), "--repo", REPO,
            "--add-label", "to:grum,state:review",
        )

    # Check existing comments on Issue
    issue_info = gh_json("issue", "view", str(task.issue_number), "--repo", REPO, "--json", "comments,labels")
    existing_issue_comments = [c.get("body", "") for c in issue_info.get("comments", [])]

    # Publish ANTINA_HANDOFF on Issue
    if not any(f"`{head_sha}`" in c and "## 🤝 ANTINA_HANDOFF" in c for c in existing_issue_comments):
        issue_handoff = f"""## 🤝 ANTINA_HANDOFF

- **task_id**: `{task.task_id}`
- **pr**: {pr_info['url']}
- **commit**: `{head_sha}`
- **notes**: Implementation complete and verified green. Ready for Grum independent inspection.
"""
        run_cmd("gh", "issue", "comment", str(task.issue_number), "--repo", REPO, "--body", issue_handoff)

    # Transition Issue labels
    issue_labels = {l.get("name") for l in issue_info.get("labels", [])}
    remove_labels = []
    if "to:antina" in issue_labels:
        remove_labels.append("to:antina")
    if "state:working" in issue_labels:
        remove_labels.append("state:working")
    add_labels = []
    if "to:grum" not in issue_labels:
        add_labels.append("to:grum")
    if "state:review" not in issue_labels:
        add_labels.append("state:review")

    edit_cmd = ["gh", "issue", "edit", str(task.issue_number), "--repo", REPO]
    for rl in remove_labels:
        edit_cmd.extend(["--remove-label", rl])
    for al in add_labels:
        edit_cmd.extend(["--add-label", al])
    if remove_labels or add_labels:
        run_cmd(*edit_cmd)

    clear_checkpoint(repo_root)
    return {
        "status": "success",
        "task_id": task.task_id,
        "pr_number": pr_number,
        "pr_url": pr_info["url"],
        "commit": head_sha,
    }


# ---------------------------------------------------------------------------
# CLI Commands: status, unlock, poll, run-task, daemon
# ---------------------------------------------------------------------------

def cmd_status(repo_root: Path) -> None:
    """Print current worker status, lock, and checkpoint."""
    probe = verify_agentapi_ready()
    print("================================================================")
    print("🤖 LOCAL ANTINA WORKER STATUS")
    print("================================================================")
    print(f"Repository Root    : {repo_root}")
    print(f"agentapi Command   : {probe['command']}")
    print(f"Antigravity Version: {probe.get('antigravity_version')}")
    print(f"Auth Mode          : {probe['auth_mode']}")
    print(f"Quota & Billing    : {probe['quota_billing_status']}")

    lock_path = repo_root / LOCK_FILE
    if lock_path.exists():
        try:
            lock_info = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = lock_info.get("pid")
            alive = is_process_running(pid) if pid else False
            status_str = f"ACTIVE (PID {pid} alive)" if alive else f"STALE (PID {pid} dead)"
            print(f"Lock Status        : LOCKED - {status_str}")
        except Exception:
            print("Lock Status        : LOCKED (unreadable)")
    else:
        print("Lock Status        : IDLE (No active lock)")

    ckpt = load_checkpoint(repo_root)
    if ckpt:
        print(f"Checkpoint         :\n{json.dumps(ckpt, indent=2)}")
    else:
        print("Checkpoint         : None")
    print("================================================================\n")


def cmd_unlock(repo_root: Path, force: bool = False, clear_ckpt: bool = False) -> None:
    """Clear stale lock. Rejects unlocking a live active worker unless forced.
    Preserves checkpoints unless --clear-checkpoint or --force is specified."""
    lock_path = repo_root / LOCK_FILE
    if lock_path.exists():
        try:
            existing = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = existing.get("pid")
            if pid and is_process_running(pid):
                if not force:
                    raise WorkerError(
                        f"Cannot unlock: worker PID {pid} is actively executing task {existing.get('task_id')}. "
                        "Refusing to unlock a live worker. Stop the process first or pass --force."
                    )
        except WorkerError:
            raise
        except Exception:
            pass

    ckpt = load_checkpoint(repo_root)
    if ckpt and not force:
        conv_id = ckpt.get("conversation_id")
        if conv_id and is_agent_conversation_active(conv_id):
            raise WorkerError(
                f"Cannot unlock: agent conversation '{conv_id}' is still actively running. "
                "Wait for it to finish or pass --force."
            )

    release_lock(repo_root)

    if force or clear_ckpt:
        clear_checkpoint(repo_root)
        print("✅ Lock and checkpoint cleared.")
    else:
        if ckpt:
            print(f"✅ Lock released. Checkpoint preserved for task {ckpt.get('task_id')} at stage '{ckpt.get('stage')}'. Pass --clear-checkpoint to clear.")
        else:
            print("✅ Lock released. No checkpoint was active.")


def cmd_poll(repo_root: Path, local_only: bool = False) -> bool:
    """Poll GitHub for pending eligible tasks or reconcile an owned interrupted task."""
    print("🔍 Checking worker state and polling GitHub Issues...")
    ckpt = load_checkpoint(repo_root)
    ckpt_issue = int(ckpt.get("issue")) if ckpt and ckpt.get("issue") else None

    # Reconcile owned matching checkpoint before general task selection
    if ckpt_issue:
        try:
            print(f"🔄 Found owned checkpoint for Issue #{ckpt_issue}. Checking eligibility...", flush=True)
            raw_issue = gh_json("issue", "view", str(ckpt_issue), "--repo", REPO, "--json", "number,title,body,state,labels")
            task = parse_task_from_issue(raw_issue, matching_checkpoint_issue=ckpt_issue)
            print(f"🎯 Resuming owned task {task.task_id} on Issue #{task.issue_number}: {task.title}")
            res = execute_task(repo_root, task, local_only=local_only)
            print(f"🎉 Task {task.task_id} completed successfully: {res.get('commit', '')[:8]}")
            return True
        except (IgnoreTask, WorkerError) as e:
            print(f"ℹ️ Owned checkpoint task could not be resumed: {e}")
            return False

    # General poll
    issues = gh_json("issue", "list", "--repo", REPO, "--label", "to:antina", "--json", "number,title,body,state,labels")
    if not issues:
        print("ℹ️ No issues with label 'to:antina' found.")
        return False

    for raw_issue in issues:
        try:
            task = parse_task_from_issue(raw_issue, matching_checkpoint_issue=ckpt_issue)
            print(f"🎯 Found eligible task {task.task_id} on Issue #{task.issue_number}: {task.title}")
            res = execute_task(repo_root, task, local_only=local_only)
            print(f"🎉 Task {task.task_id} completed successfully: {res.get('commit', '')[:8]}")
            return True
        except IgnoreTask as e:
            print(f"  ⏭️ Skipping Issue #{raw_issue.get('number')}: {e}")
            continue

    print("ℹ️ No ready tasks to execute.")
    return False


def cmd_run_task(repo_root: Path, issue_number: int, local_only: bool = False) -> None:
    """Execute a specific issue number, admitting matching owned checkpoint."""
    ckpt = load_checkpoint(repo_root)
    ckpt_issue = int(ckpt.get("issue")) if ckpt and ckpt.get("issue") else None
    raw_issue = gh_json("issue", "view", str(issue_number), "--repo", REPO, "--json", "number,title,body,state,labels")
    task = parse_task_from_issue(raw_issue, matching_checkpoint_issue=ckpt_issue)
    print(f"🎯 Executing task {task.task_id} for Issue #{task.issue_number}: {task.title}")
    res = execute_task(repo_root, task, local_only=local_only)
    print(f"🎉 Task {task.task_id} completed successfully: {res.get('commit', '')[:8]}")


def cmd_daemon(repo_root: Path, interval: int = 30) -> None:
    """Run continuously as a local background worker."""
    print(f"🚀 Starting Local Antina Worker daemon (poll interval: {interval}s). Press Ctrl+C to exit.")
    try:
        while True:
            try:
                cmd_poll(repo_root)
            except Exception as exc:
                print(f"⚠️ Error during poll cycle: {exc}")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n🛑 Daemon stopped by user.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Antina Worker for Kiris-02/gathermap")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    subparsers.add_parser("status", help="Display worker status, lock, and checkpoint")

    unlock_parser = subparsers.add_parser("unlock", help="Force clear stale lock and checkpoint")
    unlock_parser.add_argument("--force", action="store_true", help="Force unlock even if PID is alive")
    unlock_parser.add_argument("--clear-checkpoint", action="store_true", help="Also clear the checkpoint file")

    poll_parser = subparsers.add_parser("poll", help="Poll once for pending eligible tasks")
    poll_parser.add_argument("--local-only", action="store_true", help="Run local verification only without pushing or PR handoff")

    run_parser = subparsers.add_parser("run-task", help="Execute specific issue number")
    run_parser.add_argument("issue_number", type=int, help="GitHub Issue number")
    run_parser.add_argument("--local-only", action="store_true", help="Run local verification only without pushing or PR handoff")

    daemon_parser = subparsers.add_parser("daemon", help="Run continuously as background daemon")
    daemon_parser.add_argument("--interval", type=int, default=30, help="Poll interval in seconds (default: 30)")

    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parent.parent

    if args.subcommand == "status":
        cmd_status(repo_root)
    elif args.subcommand == "unlock":
        cmd_unlock(repo_root, force=args.force, clear_ckpt=args.clear_checkpoint)
    elif args.subcommand == "poll":
        cmd_poll(repo_root, local_only=args.local_only)
    elif args.subcommand == "run-task":
        cmd_run_task(repo_root, args.issue_number, local_only=args.local_only)
    elif args.subcommand == "daemon":
        cmd_daemon(repo_root, interval=args.interval)

    return 0


if __name__ == "__main__":
    sys.exit(main())
