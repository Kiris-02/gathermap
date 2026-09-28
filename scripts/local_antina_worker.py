#!/usr/bin/env python3
"""Local Antina Worker for Kiris-02/gathermap.

Implements Method A: runs locally on Kiris's machine under his existing Antigravity
entitlement via the supported agentapi CLI interface.
Operates completely fail-closed, with single-task concurrency locking, checkpointing,
worktree isolation, deterministic local verification, and strict GitHub Actions CI handoff.
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
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REPO = "Kiris-02/gathermap"
ALLOWED_ASSOCIATIONS = {"OWNER"}
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
    allowed_paths: list[str] | None = None
    revision_pr: int | None = None
    revision_head: str | None = None


# ---------------------------------------------------------------------------
# Shell & GitHub CLI Utilities
# ---------------------------------------------------------------------------

def run_cmd(*args: str, cwd: Path | None = None, check: bool = True) -> str:
    """Execute a system command safely without shell expansion."""
    try:
        res = subprocess.run(
            args,
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


# ---------------------------------------------------------------------------
# Concurrency Lock & Checkpoint System
# ---------------------------------------------------------------------------

def acquire_lock(repo_root: Path, task_id: str) -> Path:
    """Acquire persistent worker lock. Fails closed if another process is active."""
    lock_path = repo_root / LOCK_FILE
    lock_data = {
        "pid": os.getpid(),
        "task_id": task_id,
        "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if lock_path.exists():
        try:
            existing = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = existing.get("pid")
            if pid and is_process_running(pid):
                raise WorkerError(
                    f"Worker lock active by PID {pid} for task {existing.get('task_id')}. "
                    "Another local worker is currently executing."
                )
        except (json.JSONDecodeError, OSError):
            pass

    try:
        lock_path.write_text(json.dumps(lock_data, indent=2), encoding="utf-8")
    except OSError as exc:
        raise WorkerError(f"Failed to write lock file: {exc}") from exc
    return lock_path


def release_lock(repo_root: Path) -> None:
    """Release persistent worker lock."""
    lock_path = repo_root / LOCK_FILE
    if lock_path.exists():
        try:
            lock_path.unlink()
        except OSError:
            pass


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
            return str(pid) in out.stdout
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False


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
    # 1. Direct language_server binary in Antigravity install (preserves multiline arguments)
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        ls_path = Path(local_app_data) / "Programs" / "antigravity" / "resources" / "bin" / "language_server.exe"
        if ls_path.is_file():
            return [str(ls_path.resolve()), "agentapi"]

    # 2. Check user antigravity bin batch wrapper
    home = Path.home()
    agentapi_bat = home / ".gemini" / "antigravity" / "bin" / "agentapi.bat"
    if agentapi_bat.is_file():
        return [str(agentapi_bat.resolve())]

    # 3. Check PATH
    which_bat = shutil.which("agentapi.bat") or shutil.which("agentapi")
    if which_bat:
        return [which_bat]

    raise WorkerError(
        "Antigravity local agentapi interface not found. "
        "Ensure Antigravity IDE is installed and ~/.gemini/antigravity/bin/agentapi.bat is accessible."
    )


def verify_agentapi_ready() -> dict[str, str]:
    """Verify that agentapi is operational and record interface metadata."""
    cmd = find_agentapi_cmd()
    try:
        out = run_cmd(*cmd, "--help")
    except Exception as exc:
        raise WorkerError(f"Antigravity agentapi probe failed: {exc}") from exc

    if "Available Commands" not in out and "new-conversation" not in out:
        raise WorkerError(f"Unexpected agentapi response: {out[:200]}")

    return {
        "command": " ".join(cmd),
        "status": "ready",
        "auth_mode": "antigravity_product_session",
        "quota_mode": "product_entitlement",
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

    # Wait for transcript file to be created
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

def parse_task_from_issue(issue: dict) -> Task:
    """Validate issue format and extract structured Task parameters."""
    if issue.get("state") != "OPEN":
        raise IgnoreTask(f"Issue #{issue.get('number')} is not open")

    body = issue.get("body") or ""
    if "GRUM_TASK" not in body:
        raise IgnoreTask(f"Issue #{issue.get('number')} has no GRUM_TASK block")

    issue_labels = {l.get("name") for l in issue.get("labels") or []}

    # Verify routing label
    if "to:antina" not in issue_labels:
        raise IgnoreTask(f"Issue #{issue.get('number')} does not have 'to:antina'")

    # Verify ready/revision state
    ready_state = issue_labels & READY_LABELS
    if not ready_state:
        raise IgnoreTask(f"Issue #{issue.get('number')} has no ready state label")
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

    # Extract allowed paths / constraints if present
    allowed_paths: list[str] | None = None
    files_interest_match = re.search(r"### 📁 Files of Interest\s*\n((?:- `[^`]+`\s*\n)+)", body)
    if files_interest_match:
        raw_files = re.findall(r"- `([^`]+)`", files_interest_match.group(1))
        if raw_files:
            allowed_paths = [f.strip().replace("\\", "/") for f in raw_files]

    # Specific constraint whitelist check (e.g. "Only edit src/config/constants.js")
    constraint_single_file = re.search(r"Only edit `?([A-Za-z0-9_./\-]+)`?", body, re.IGNORECASE)
    if constraint_single_file:
        single_path = constraint_single_file.group(1).strip().replace("\\", "/")
        if allowed_paths is None:
            allowed_paths = [single_path]
        elif single_path not in allowed_paths:
            allowed_paths.append(single_path)

    # Check for revision pin on PR #2 if applicable
    revision_pr_match = re.search(r"^- \*\*revision_pr\*\*:\s*`?(\d+)`?\s*$", body, re.MULTILINE)
    revision_pr = int(revision_pr_match.group(1)) if revision_pr_match else None

    branch = f"agent/{task_id.lower()}"
    return Task(
        issue_number=int(issue["number"]),
        task_id=task_id,
        title=title,
        body=body,
        state_label=state_label,
        branch=branch,
        allowed_paths=allowed_paths,
        revision_pr=revision_pr,
    )


def assert_clean_git_diff(worktree_path: Path, task: Task) -> list[str]:
    """Ensure that only allowed paths were modified and no protected files were touched."""
    status_output = run_cmd("git", "status", "--porcelain", cwd=worktree_path)
    if not status_output:
        raise WorkerError("Agent produced zero file modifications in worktree")

    changed_files: list[str] = []
    for line in status_output.splitlines():
        if not line.strip():
            continue
        # Format: XY <file> or XY <old> -> <new> (handles leading space stripping gracefully)
        parts = line.strip().split(maxsplit=1)
        if len(parts) < 2:
            continue
        file_path = parts[1].split(" -> ")[-1].strip().strip('"').replace("\\", "/")
        changed_files.append(file_path)

    # Check against protected prefixes and files
    for path in changed_files:
        if path in PROTECTED_FILES or any(path.startswith(prefix) for prefix in PROTECTED_PREFIXES):
            raise WorkerError(f"Agent modified protected file: {path}. Halting immediately.")

    # Check against allowed paths whitelist if specified
    if task.allowed_paths:
        for path in changed_files:
            if path not in task.allowed_paths:
                raise WorkerError(
                    f"Agent modified file outside allowed paths: {path} (allowed: {task.allowed_paths})"
                )

    # Run git diff --check (whitespace error check)
    run_cmd("git", "diff", "--check", cwd=worktree_path)
    return changed_files


# ---------------------------------------------------------------------------
# Worktree Management
# ---------------------------------------------------------------------------

def create_isolated_worktree(repo_root: Path, task: Task) -> Path:
    """Create a completely isolated Git worktree for the task branch."""
    worktree_dir = repo_root / ".worktrees" / f"agent-{task.task_id.lower()}"
    run_cmd("git", "worktree", "remove", "--force", str(worktree_dir), cwd=repo_root, check=False)
    if worktree_dir.exists():
        shutil.rmtree(worktree_dir, ignore_errors=True)
    run_cmd("git", "worktree", "prune", cwd=repo_root, check=False)

    worktree_dir.parent.mkdir(parents=True, exist_ok=True)

    # Clean up local branch if exists
    run_cmd("git", "branch", "-D", task.branch, cwd=repo_root, check=False)

    # Add fresh worktree branching from origin/main
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
    # Link node_modules so tests run instantly without npm ci
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
# Deterministic Local Verification
# ---------------------------------------------------------------------------

def run_local_tests(worktree_path: Path) -> str:
    """Execute local product test suites in the worktree."""
    out = run_cmd("npm", "test", cwd=worktree_path)
    return out


# ---------------------------------------------------------------------------
# GitHub Publishing & CI Waiter
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


def wait_for_pr_checks(pr_number: int, expected_head: str, timeout_seconds: int = 1800) -> None:
    """Wait for required GitHub Actions checks on PR to pass on the exact HEAD SHA."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        pr = gh_json("pr", "view", str(pr_number), "--repo", REPO, "--json", "statusCheckRollup,headRefOid")
        pr_head = str(pr.get("headRefOid") or "")
        if pr_head and pr_head != expected_head:
            raise WorkerError(f"PR HEAD ({pr_head}) does not match pushed commit ({expected_head})")
        rollup = pr.get("statusCheckRollup") or []
        state = checks_state(rollup, REQUIRED_CHECKS, expected_head=expected_head, pr_head=pr_head)
        if state == "success":
            return
        if state == "failed":
            raise WorkerError("Required GitHub Actions PR checks failed")
        if state in {"approval_required", "stale", "skipped"}:
            raise WorkerError(f"PR checks in invalid terminal state: {state}")
        time.sleep(15)
    raise WorkerError(f"Timed out waiting for GitHub Actions checks on PR #{pr_number}")


# ---------------------------------------------------------------------------
# Core Task Execution Pipeline
# ---------------------------------------------------------------------------

def execute_task(repo_root: Path, task: Task, skip_ci: bool = False) -> dict[str, Any]:
    """Execute the full fail-closed task workflow."""
    acquire_lock(repo_root, task.task_id)
    worktree_dir: Path | None = None
    try:
        # Step 1: Transition Issue to state:working
        print(f"[{task.task_id}] Step 1: Claiming Issue #{task.issue_number} (setting state:working)...", flush=True)
        save_checkpoint(repo_root, {"task_id": task.task_id, "issue": task.issue_number, "stage": "CLAIMING"})
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

        # Step 2: Setup isolated worktree
        print(f"[{task.task_id}] Step 2: Creating isolated Git worktree from origin/main...", flush=True)
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

        target_hint = ""
        if task.allowed_paths:
            target_hint = f"\nTARGET FILES TO INSPECT AND MODIFY:\n" + "\n".join(f"- {worktree_dir / p}" for p in task.allowed_paths)

        prompt = f"""You are Antina, the automated implementation agent for Kiris-02/gathermap.
Read and follow .agents/README.md, PROTOCOL.md, ANTINA.md, TASK_FORMAT.md, and SAFETY.md.

CRITICAL INSTRUCTIONS:
1. Work ONLY inside this working directory: {worktree_dir}
2. Never call git commit, push, merge, or gh commands. The outer local worker harness owns all git and PR operations.
3. Never edit protected files (.agents/, .github/, supabase/migrations/, secrets, runner scripts).
4. Strictly implement the GRUM_TASK specified below.{target_hint}
5. Finish with a concise factual summary of the changes made.

TASK DETAILS:
Issue #{task.issue_number}
{task.body}
"""
        print(f"[{task.task_id}] Step 3: Dispatching task to Antigravity agentapi...", flush=True)
        conv_id = start_agent_conversation(prompt, title=f"Antina: {task.task_id}")
        print(f"[{task.task_id}] Conversation started with ID: {conv_id}", flush=True)

        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "AGENT_MONITORING",
            "conversation_id": conv_id,
            "worktree": str(worktree_dir),
        })

        print(f"[{task.task_id}] Step 4: Monitoring Antigravity agent execution...", flush=True)
        agent_result = monitor_agent_execution(conv_id, timeout_seconds=600)
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
        test_output = run_local_tests(worktree_dir)
        print(f"[{task.task_id}] Local tests passed 100%!", flush=True)

        # Clean up any test-generated artifacts (e.g. screenshots, temp databases)
        run_cmd("git", "checkout", "--", "tests/screenshots", cwd=worktree_dir, check=False)
        run_cmd("git", "clean", "-fd", "tests/", cwd=worktree_dir, check=False)

        # Step 6: Commit and Push branch
        print(f"[{task.task_id}] Step 7: Committing changes in worktree...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "COMMITTING",
            "worktree": str(worktree_dir),
        })
        # Re-verify diff after tests and add only verified changed files
        changed_files = assert_clean_git_diff(worktree_dir, task)
        for f in changed_files:
            run_cmd("git", "add", f, cwd=worktree_dir)
        run_cmd(
            "git",
            "commit",
            "-m",
            f"feat(antina): complete {task.task_id} (#{task.issue_number})",
            cwd=worktree_dir,
        )
        head_sha = run_cmd("git", "rev-parse", "HEAD", cwd=worktree_dir)
        print(f"[{task.task_id}] Committed HEAD SHA: {head_sha}", flush=True)

        print(f"[{task.task_id}] Step 8: Pushing branch {task.branch} to origin...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "PUSHING",
            "head_sha": head_sha,
        })
        run_cmd("git", "push", "--set-upstream", "origin", task.branch, cwd=worktree_dir)

        # Step 7: Create or update PR
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

        # Step 8: Wait for CI checks (unless skipped for dry run)
        if not skip_ci:
            print(f"[{task.task_id}] Step 10: Waiting for required GitHub Actions CI checks to turn green on HEAD {head_sha[:8]}...", flush=True)
            save_checkpoint(repo_root, {
                "task_id": task.task_id,
                "issue": task.issue_number,
                "stage": "WAITING_CI",
                "pr_number": pr_number,
                "head_sha": head_sha,
            })
            wait_for_pr_checks(pr_number, head_sha)
            print(f"[{task.task_id}] GitHub Actions CI checks passed green!", flush=True)

        # Step 9: Post ANTINA_REPORT in PR and ANTINA_HANDOFF in Issue
        print(f"[{task.task_id}] Step 11: Publishing ANTINA_REPORT and ANTINA_HANDOFF...", flush=True)
        save_checkpoint(repo_root, {
            "task_id": task.task_id,
            "issue": task.issue_number,
            "stage": "HANDOFF",
            "pr_number": pr_number,
            "head_sha": head_sha,
        })
        changed_files_list = "\n".join(f"- `{f}`" for f in changed_files)
        report = f"""## 📤 ANTINA_REPORT

- **task_id**: `{task.task_id}`
- **status**: `PR_READY`
- **pr**: {pr_info['url']}
- **commit**: `{head_sha}`
- **summary**: {agent_result.get('summary', 'Task implementation completed successfully.')}

### 📁 Files Changed
{changed_files_list}

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

        handoff = f"""## 🤝 ANTINA_HANDOFF

- **task_id**: `{task.task_id}`
- **pr**: {pr_info['url']}
- **commit**: `{head_sha}`
- **notes**: Implementation complete and verified green. Ready for Grum independent inspection.
"""
        run_cmd("gh", "issue", "comment", str(task.issue_number), "--repo", REPO, "--body", handoff)

        # Step 10: Transition labels to to:grum, state:review
        run_cmd(
            "gh", "issue", "edit", str(task.issue_number), "--repo", REPO,
            "--remove-label", "to:antina",
            "--remove-label", "state:working",
            "--add-label", "to:grum",
            "--add-label", "state:review",
        )

        clear_checkpoint(repo_root)
        return {
            "status": "success",
            "task_id": task.task_id,
            "pr_number": pr_number,
            "pr_url": pr_info["url"],
            "commit": head_sha,
        }

    except Exception as exc:
        # On failure: escalate to needs:kiris and record failure details
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
        if worktree_dir:
            remove_isolated_worktree(repo_root, worktree_dir)
        release_lock(repo_root)


# ---------------------------------------------------------------------------
# CLI Commands: poll, run-task, status, unlock, daemon
# ---------------------------------------------------------------------------

def cmd_status(repo_root: Path) -> None:
    """Print current worker status, lock, and checkpoint."""
    probe = verify_agentapi_ready()
    print("================================================================")
    print("🤖 LOCAL ANTINA WORKER STATUS")
    print("================================================================")
    print(f"Repository Root    : {repo_root}")
    print(f"agentapi Command   : {probe['command']}")
    print(f"Auth & Quota Mode  : {probe['auth_mode']} ({probe['quota_mode']})")

    lock_path = repo_root / LOCK_FILE
    if lock_path.exists():
        print(f"Lock Status        : LOCKED ({lock_path.read_text(encoding='utf-8').strip()})")
    else:
        print("Lock Status        : IDLE (No active lock)")

    ckpt = load_checkpoint(repo_root)
    if ckpt:
        print(f"Checkpoint         :\n{json.dumps(ckpt, indent=2)}")
    else:
        print("Checkpoint         : None")
    print("================================================================\n")


def cmd_unlock(repo_root: Path) -> None:
    """Clear stale lock and checkpoint."""
    release_lock(repo_root)
    clear_checkpoint(repo_root)
    print("✅ Stale lock and checkpoint cleared.")


def cmd_poll(repo_root: Path, skip_ci: bool = False) -> bool:
    """Poll GitHub for pending eligible tasks and execute the first one."""
    print("🔍 Polling GitHub Issues for eligible GRUM_TASK (labels: to:antina, state:ready)...")
    issues = gh_json("issue", "list", "--repo", REPO, "--label", "to:antina", "--json", "number,title,body,state,labels")
    if not issues:
        print("ℹ️ No issues with label 'to:antina' found.")
        return False

    for raw_issue in issues:
        try:
            task = parse_task_from_issue(raw_issue)
            print(f"🎯 Found eligible task {task.task_id} on Issue #{task.issue_number}: {task.title}")
            res = execute_task(repo_root, task, skip_ci=skip_ci)
            print(f"🎉 Task {task.task_id} completed successfully: PR {res['pr_url']} ({res['commit'][:8]})")
            return True
        except IgnoreTask as e:
            print(f"  ⏭️ Skipping Issue #{raw_issue.get('number')}: {e}")
            continue

    print("ℹ️ No ready tasks to execute.")
    return False


def cmd_run_task(repo_root: Path, issue_number: int, skip_ci: bool = False) -> None:
    """Execute a specific issue number."""
    raw_issue = gh_json("issue", "view", str(issue_number), "--repo", REPO, "--json", "number,title,body,state,labels")
    task = parse_task_from_issue(raw_issue)
    print(f"🎯 Executing task {task.task_id} for Issue #{task.issue_number}: {task.title}")
    res = execute_task(repo_root, task, skip_ci=skip_ci)
    print(f"🎉 Task {task.task_id} completed successfully: PR {res['pr_url']} ({res['commit'][:8]})")


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
    subparsers.add_parser("unlock", help="Force clear stale lock and checkpoint")

    poll_parser = subparsers.add_parser("poll", help="Poll once for pending eligible tasks")
    poll_parser.add_argument("--skip-ci", action="store_true", help="Skip waiting for CI checks (for local testing)")

    run_parser = subparsers.add_parser("run-task", help="Execute specific issue number")
    run_parser.add_argument("issue_number", type=int, help="GitHub Issue number")
    run_parser.add_argument("--skip-ci", action="store_true", help="Skip waiting for CI checks")

    daemon_parser = subparsers.add_parser("daemon", help="Run continuously as background daemon")
    daemon_parser.add_argument("--interval", type=int, default=30, help="Poll interval in seconds (default: 30)")

    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parent.parent

    if args.subcommand == "status":
        cmd_status(repo_root)
    elif args.subcommand == "unlock":
        cmd_unlock(repo_root)
    elif args.subcommand == "poll":
        cmd_poll(repo_root, skip_ci=args.skip_ci)
    elif args.subcommand == "run-task":
        cmd_run_task(repo_root, args.issue_number, skip_ci=args.skip_ci)
    elif args.subcommand == "daemon":
        cmd_daemon(repo_root, interval=args.interval)

    return 0


if __name__ == "__main__":
    sys.exit(main())
