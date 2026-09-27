#!/usr/bin/env python3
"""Fail-closed Antina runner for approved Gathermap GitHub Issues.

GitHub Actions is the wake-up transport. Google Antigravity SDK edits and tests
the isolated checkout. This harness retains every GitHub/Git state transition.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import agent_cycle

REPO = "Kiris-02/gathermap"
ALLOWED_ASSOCIATIONS = {"OWNER"}
READY = {"state:ready", "state:revision"}
CONTROL_PREFIXES = ("to:", "state:")
FORBIDDEN_CONTROL = {"NEEDS_KIRIS", "state:blocked", "state:needs-kiris"}
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
}
SAFE_GIT = {"diff", "grep", "log", "ls-files", "rev-parse", "show", "status"}
SAFE_NPM_SCRIPTS = {"build", "lint", "test", "test:unit", "test:integration"}
UNSAFE_SHELL = re.compile(r"[;&|><`\n\r]|\$\(")
UNSAFE_COMMAND_WORDS = re.compile(
    r"\b(deploy|publish|release|migration|migrate|supabase|render|secret|"
    r"force|reset|checkout|switch|commit|push|merge|rebase|clean|rm|del)\b",
    re.IGNORECASE,
)
SENSITIVE_ENV = re.compile(
    r"(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|API_KEY|ACTIONS_RUNTIME)",
    re.IGNORECASE,
)


class RunnerError(Exception):
    """A safety or execution failure that must stop the runner."""


class IgnoreEvent(Exception):
    """An event that is ineligible or already consumed; it is a safe no-op."""


@dataclass(frozen=True)
class Task:
    issue: int
    task_id: str
    title: str
    body: str
    state_label: str
    branch: str


def run(*args: str, cwd: Path | None = None, check: bool = True) -> str:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            check=check,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RunnerError(f"Missing executable: {args[0]}") from exc
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or exc.stdout or "command failed").strip()
        raise RunnerError(f"{args[0]} {args[1] if len(args) > 1 else ''}: {message}") from exc
    return result.stdout.strip()


def gh_json(*args: str) -> object:
    try:
        return json.loads(run("gh", *args))
    except json.JSONDecodeError as exc:
        raise RunnerError("GitHub returned malformed JSON") from exc


def label_names(issue: dict) -> set[str]:
    return {item["name"] for item in issue.get("labels") or []}


def task_identifier(body: str) -> str:
    match = re.search(
        r"^\s*-\s*\*\*task_id\*\*:\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*$",
        body,
        re.MULTILINE,
    )
    if not match:
        raise RunnerError("GRUM_TASK has no structured task_id")
    return match.group(1)


def branch_for(task_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", task_id.lower()).strip("-")
    if not slug or len(slug) > 80:
        raise RunnerError("task_id cannot produce a safe branch name")
    branch = f"agent/{slug}"
    if branch in {"main", "master", "refactor/ui-map-architecture"}:
        raise RunnerError("Refusing a protected branch")
    return branch


def validate_event(payload: dict) -> tuple[int, str]:
    if payload.get("action") != "labeled":
        raise IgnoreEvent("Only issue label events wake Antina")
    repository = (payload.get("repository") or {}).get("full_name")
    if repository != REPO:
        raise IgnoreEvent("Event is for another repository")
    issue = payload.get("issue") or {}
    if issue.get("pull_request"):
        raise IgnoreEvent("Pull request label events are not task events")
    if issue.get("state", "").lower() != "open":
        raise IgnoreEvent("Issue is closed")
    association = issue.get("author_association")
    if association not in ALLOWED_ASSOCIATIONS:
        raise IgnoreEvent("Issue author is not allowed to wake Antina")
    trigger_label = (payload.get("label") or {}).get("name", "")
    if trigger_label not in {"to:antina", *READY}:
        raise IgnoreEvent("Unrelated label")
    number = issue.get("number")
    if not isinstance(number, int) or number < 1:
        raise IgnoreEvent("Invalid issue number")
    return number, association


def task_from_issue(issue: dict, association: str) -> Task:
    if association not in ALLOWED_ASSOCIATIONS:
        raise IgnoreEvent("Issue author is not allowed")
    if issue.get("state") != "OPEN":
        raise IgnoreEvent("Issue is no longer open")
    body = issue.get("body") or ""
    if "GRUM_TASK" not in body:
        raise IgnoreEvent("Issue is not a GRUM_TASK")
    names = label_names(issue)
    control = {name for name in names if name.startswith(CONTROL_PREFIXES) or name == "NEEDS_KIRIS"}
    states = names & READY
    if names & FORBIDDEN_CONTROL:
        raise IgnoreEvent("Task is blocked or needs Kiris")
    if "state:working" in names or "to:grum" in names:
        raise IgnoreEvent("Task was already consumed")
    if "to:antina" not in names or len(states) != 1:
        raise IgnoreEvent("Task lacks an exact Antina ready/revision state")
    expected = {"to:antina", next(iter(states))}
    if control != expected:
        raise IgnoreEvent("Task has conflicting control labels")
    if re.search(r"refactor/ui-map-architecture|\bPR\s*#?2\b", body, re.IGNORECASE):
        raise RunnerError("Product PR #2 is reserved for the Product lane")
    identifier = task_identifier(body)
    return Task(
        issue=int(issue["number"]),
        task_id=identifier,
        title=issue.get("title") or identifier,
        body=body,
        state_label=next(iter(states)),
        branch=branch_for(identifier),
    )


def path_allowed(raw_path: str, root: Path) -> bool:
    if not raw_path:
        return False
    value = raw_path.removeprefix("file://")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        relative = candidate.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return False
    if any(part == ".env" or part.startswith(".env.") for part in Path(relative).parts):
        return False
    if relative in PROTECTED_FILES:
        return False
    return not any(relative.startswith(prefix) for prefix in PROTECTED_PREFIXES)


def read_path_allowed(raw_path: str, root: Path) -> bool:
    if not raw_path:
        return False
    value = raw_path.removeprefix("file://")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        relative = candidate.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    parts = relative.parts
    if ".git" in parts or ".npmrc" in parts:
        return False
    return not any(part == ".env" or part.startswith(".env.") for part in parts)


def read_args_allowed(args: dict, root: Path) -> bool:
    path = (
        args.get("path") or args.get("file_path") or args.get("directory_path")
        or args.get("search_path") or args.get("SearchPath") or ""
    )
    return read_path_allowed(str(path), root)


def edit_args_allowed(args: dict, root: Path) -> bool:
    path = args.get("path") or args.get("file_path") or ""
    return path_allowed(str(path), root)


def command_allowed(args: dict) -> bool:
    command = str(args.get("CommandLine") or args.get("command") or "").strip()
    if not command or UNSAFE_SHELL.search(command) or UNSAFE_COMMAND_WORDS.search(command):
        return False
    try:
        words = shlex.split(command)
    except ValueError:
        return False
    if not words:
        return False
    executable = Path(words[0]).name.lower()
    if executable == "git":
        return len(words) >= 2 and words[1] in SAFE_GIT
    if executable == "npm":
        if words[1:2] == ["test"]:
            return True
        return len(words) >= 3 and words[1] == "run" and words[2] in SAFE_NPM_SCRIPTS
    if executable in {"python", "python3"}:
        return len(words) >= 3 and words[1] == "-m" and words[2] in {
            "pytest", "unittest", "py_compile"
        }
    if executable == "node":
        return len(words) >= 2 and not words[1].startswith("-")
    return False


def pop_sensitive_environment() -> dict[str, str]:
    removed = {name: value for name, value in os.environ.items() if SENSITIVE_ENV.search(name)}
    for name in removed:
        os.environ.pop(name, None)
    return removed


def changed_paths(root: Path) -> set[str]:
    tracked = run("git", "diff", "--name-only", "--diff-filter=ACMR", cwd=root)
    untracked = run("git", "ls-files", "--others", "--exclude-standard", cwd=root)
    return {line for line in (tracked + "\n" + untracked).splitlines() if line}


def validate_changes(root: Path) -> list[str]:
    paths = sorted(changed_paths(root))
    if not paths:
        raise RunnerError("Antina produced no repository changes")
    refused = [path for path in paths if not path_allowed(path, root)]
    if refused:
        raise RunnerError("Protected paths changed: " + ", ".join(refused))
    run("git", "diff", "--check", cwd=root)
    return paths


def remote_branch_exists(branch: str) -> bool:
    result = subprocess.run(
        ("git", "ls-remote", "--exit-code", "--heads", "origin", branch),
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in {0, 2}:
        raise RunnerError("Could not determine whether the task branch exists")
    return result.returncode == 0


def find_revision_pr(task: Task) -> dict:
    items = gh_json(
        "pr", "list", "--repo", REPO, "--state", "open", "--head", task.branch,
        "--base", "main", "--json", "number,url,headRefName,baseRefName",
    )
    if not isinstance(items, list) or len(items) != 1:
        raise RunnerError("Revision requires exactly one open PR for the task branch")
    return items[0]


def prepare_branch(task: Task, root: Path) -> dict | None:
    if run("git", "status", "--porcelain", cwd=root):
        raise RunnerError("Initial checkout must be clean")
    origin = run("git", "remote", "get-url", "origin", cwd=root)
    if origin not in agent_cycle.EXPECTED_ORIGINS:
        raise RunnerError("Checkout points at an unexpected repository")
    if task.state_label == "state:ready":
        if remote_branch_exists(task.branch):
            raise RunnerError("Ready task branch already exists; manual recovery is required")
        run("git", "fetch", "origin", "main", cwd=root)
        run("git", "switch", "-c", task.branch, "origin/main", cwd=root)
        return None
    pr = find_revision_pr(task)
    if pr.get("headRefName") == "refactor/ui-map-architecture" or pr.get("number") == 2:
        raise RunnerError("Refusing to revise Product PR #2")
    run("git", "fetch", "origin", f"{task.branch}:refs/remotes/origin/{task.branch}", cwd=root)
    run("git", "switch", "-c", task.branch, f"origin/{task.branch}", cwd=root)
    return pr


async def run_antigravity(task: Task, root: Path) -> str:
    try:
        from google.antigravity import Agent, LocalAgentConfig, types
        from google.antigravity.hooks import policy
    except ImportError as exc:
        raise RunnerError("google-antigravity is not installed") from exc

    secret_environment = pop_sensitive_environment()
    api_key = secret_environment.get("GEMINI_API_KEY")
    if not api_key:
        for name in ("GH_TOKEN", "GITHUB_TOKEN"):
            if name in secret_environment:
                os.environ[name] = secret_environment[name]
        raise RunnerError("GEMINI_API_KEY disappeared before SDK startup")
    try:
        policies = [
            policy.allow("view_file", when=lambda args: read_args_allowed(args, root)),
            policy.allow("list_directory", when=lambda args: read_args_allowed(args, root)),
            policy.allow("search_directory", when=lambda args: read_args_allowed(args, root)),
            policy.allow("find_file", when=lambda args: read_args_allowed(args, root)),
            policy.allow("grep_search", when=lambda args: read_args_allowed(args, root)),
            policy.allow("edit_file", when=lambda args: edit_args_allowed(args, root)),
            policy.allow("run_command", when=command_allowed),
            policy.deny("*", name="deny-all-unlisted-tools"),
        ]
        instructions = f"""You are Antina, the implementation and testing agent for Gathermap.
Read .agents/README.md, PROTOCOL.md, ANTINA.md, TASK_FORMAT.md, and SAFETY.md first.
Implement only the GRUM_TASK below in the current isolated branch.
Do not call git or gh mutation commands; the outer harness owns branch, commit, push, PR,
labels, and comments. Never merge, deploy, execute migrations, access secrets, or modify
protected protocol/workflow/runner files. Run relevant allowed tests. If the task is
unsafe, ambiguous, or impossible within these tools, make no changes and explain why.

ISSUE #{task.issue}
{task.body}
"""
        config = LocalAgentConfig(
            api_key=api_key,
            system_instructions=instructions,
            policies=policies,
            capabilities=types.CapabilitiesConfig(
                run_command_config=types.RunCommandConfig(enable_sandbox=True),
            ),
            workspaces=[str(root.resolve())],
        )
        async with Agent(config) as agent:
            response = await agent.chat(
                "Inspect the repository, implement the task, run relevant tests, and finish with a concise factual summary."
            )
            return await response.text()
    finally:
        # Restore only the GitHub transport credentials needed by the outer
        # harness. The model API key and every unrelated secret remain absent.
        for name in ("GH_TOKEN", "GITHUB_TOKEN"):
            if name in secret_environment:
                os.environ[name] = secret_environment[name]


def checks_state(rollup: list[dict]) -> str:
    if not rollup:
        return "pending"
    pending = {"EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"}
    success = {"NEUTRAL", "SKIPPED", "STALE", "SUCCESS"}
    saw_pending = False
    for check in rollup:
        state = str(check.get("conclusion") or check.get("state") or check.get("status") or "").upper()
        if state in pending or not state:
            saw_pending = True
        elif state not in success and state != "COMPLETED" or state == "COMPLETED" and str(check.get("conclusion") or "").upper() not in success:
            return "failed"
    return "pending" if saw_pending else "success"


def wait_for_checks(pr_number: int, timeout: int = 1800) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pr = gh_json("pr", "view", str(pr_number), "--repo", REPO, "--json", "statusCheckRollup")
        state = checks_state(pr.get("statusCheckRollup") or [])
        if state == "success":
            return
        if state == "failed":
            raise RunnerError("PR checks failed")
        time.sleep(15)
    raise RunnerError("Timed out waiting for PR checks")


def publish(task: Task, root: Path, prior_pr: dict | None, summary: str, paths: list[str]) -> dict:
    test_environment = {
        name: value for name, value in os.environ.items() if not SENSITIVE_ENV.search(name)
    }
    try:
        subprocess.run(
            ("npm", "test"), cwd=root, env=test_environment, check=True,
            capture_output=True, text=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RunnerError(f"npm test failed: {(exc.stderr or exc.stdout).strip()}") from exc
    run("git", "add", "--all", cwd=root)
    run("git", "config", "user.name", "Antina Automation", cwd=root)
    run("git", "config", "user.email", "antina-automation@users.noreply.github.com", cwd=root)
    run("git", "commit", "-m", f"feat(antina): complete {task.task_id}", cwd=root)
    run("gh", "auth", "setup-git", cwd=root)
    run("git", "push", "--set-upstream", "origin", task.branch, cwd=root)
    sha = run("git", "rev-parse", "HEAD", cwd=root)
    if prior_pr is None:
        url = run(
            "gh", "pr", "create", "--repo", REPO, "--base", "main", "--head", task.branch,
            "--title", f"{task.task_id}: {task.title}",
            "--body", f"Automated Antina implementation for #{task.issue}. Verification is in progress.",
            cwd=root,
        )
        pr = gh_json("pr", "view", url, "--repo", REPO, "--json", "number,url,headRefOid")
    else:
        pr = gh_json("pr", "view", str(prior_pr["number"]), "--repo", REPO,
                     "--json", "number,url,headRefOid")
    if pr.get("headRefOid") != sha:
        raise RunnerError("PR head does not match the pushed Antina commit")
    wait_for_checks(int(pr["number"]))
    report = f"""## 📤 ANTINA_REPORT

- **task_id**: `{task.task_id}`
- **status**: PR_READY
- **linked_issue**: #{task.issue}
- **pr**: {pr['url']}
- **commit**: `{sha}`
- **summary**: {summary.strip()[:2000]}

### 📁 Changed Areas
{chr(10).join(f'- `{path}`' for path in paths)}

### 🧪 Tests & Verification
- **Executed Command**: `npm test`
- **Result**: Passed.
- **Executed Command**: `git diff --check`
- **Result**: Passed.
- **GitHub Actions**: Required checks passed.

### ⚠️ Known Risks
- Automated SDK execution is bounded by repository and command policies; human merge remains mandatory.

### ❓ Unresolved Items
- None reported by the runner.

> 🛑 **Author Confirmation**: I will not self-merge this Pull Request.
"""
    report_path = Path(tempfile.gettempdir()) / f"antina-report-{task.issue}.md"
    report_path.write_text(report, encoding="utf-8")
    agent_cycle.handoff(task.issue, task.branch, int(pr["number"]), report_path)
    return {"issue": task.issue, "pr": pr["url"], "commit": sha, "state": "PR_READY"}


def route_needs_kiris(issue_number: int, task_id: str, reason: str) -> None:
    issue = agent_cycle.issue_view(issue_number)
    existing = label_names(issue)
    removable = sorted(
        name for name in existing
        if name == "to:antina" or name.startswith("state:") or name == "NEEDS_KIRIS"
    )
    args = ["issue", "edit", str(issue_number), "--repo", REPO]
    if removable:
        args += ["--remove-label", ",".join(removable)]
    args += ["--add-label", "NEEDS_KIRIS,state:needs-kiris"]
    run("gh", *args)
    safe_reason = re.sub(r"[\r\n]+", " ", reason).strip()[:1000]
    run(
        "gh", "issue", "comment", str(issue_number), "--repo", REPO, "--body",
        f"## 🛑 NEEDS_KIRIS\n\n- **task_id**: `{task_id}`\n- **reason**: {safe_reason}\n"
        "- **state**: Automation stopped without merge or deployment.",
    )


def execute(event_path: Path, root: Path) -> dict:
    payload = json.loads(event_path.read_text(encoding="utf-8"))
    issue_number, association = validate_event(payload)
    live = agent_cycle.issue_view(issue_number)
    task = task_from_issue(live, association)
    if not os.environ.get("GEMINI_API_KEY"):
        route_needs_kiris(task.issue, task.task_id, "Repository secret GEMINI_API_KEY is not configured")
        raise RunnerError("GEMINI_API_KEY is not configured")
    try:
        prior_pr = prepare_branch(task, root)
        agent_cycle.claim(task.issue, task.branch)
        summary = asyncio.run(run_antigravity(task, root))
        paths = validate_changes(root)
        return publish(task, root, prior_pr, summary, paths)
    except Exception as exc:
        route_needs_kiris(task.issue, task.task_id, str(exc))
        raise


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    try:
        result = execute(args.event, args.workspace.resolve())
    except IgnoreEvent as exc:
        print(json.dumps({"state": "IGNORED", "reason": str(exc)}))
        return
    except (RunnerError, agent_cycle.CycleError, OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"antina_runner: {exc}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
