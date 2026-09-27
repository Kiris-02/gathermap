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
import shutil
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
REQUIRED_CHECKS = frozenset({"Antina required validation"})
SENSITIVE_ENV = re.compile(
    r"(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|API_KEY|ACTIONS_RUNTIME)",
    re.IGNORECASE,
)
TRUSTED_GIT = shutil.which("git")
TRUSTED_GH = shutil.which("gh")


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
    revision_pr: int | None = None
    revision_head: str | None = None


def product_revision_pin(body: str) -> str | None:
    """An owner Issue must pin the one exceptional Product PR and its exact HEAD."""
    fields = {}
    for name in ("revision_pr", "revision_branch", "revision_head"):
        matches = re.findall(rf"^- \*\*{name}\*\*: `([^`\r\n]+)`\s*$", body, re.MULTILINE)
        if len(matches) > 1:
            raise RunnerError(f"Duplicate {name} pin")
        fields[name] = matches[0] if matches else None
    if not any(fields.values()):
        return None
    if (fields["revision_pr"] != "2"
            or fields["revision_branch"] != "refactor/ui-map-architecture"
            or not fields["revision_head"]
            or not re.fullmatch(r"[0-9a-f]{40}", fields["revision_head"])):
        raise RunnerError("Product revision requires exact PR #2, branch, and 40-hex HEAD pins")
    return fields["revision_head"]


def run(*args: str, cwd: Path | None = None, check: bool = True) -> str:
    command = list(args)
    if command and command[0] == "git" and TRUSTED_GIT:
        command[0] = TRUSTED_GIT
    elif command and command[0] == "gh" and TRUSTED_GH:
        command[0] = TRUSTED_GH
    try:
        result = subprocess.run(
            command,
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
    if trigger_label != "to:antina":
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
    pin = product_revision_pin(body)
    mentions_product = re.search(r"refactor/ui-map-architecture|\bPR\s*#?2\b", body, re.IGNORECASE)
    if mentions_product and pin is None:
        raise RunnerError("Product PR #2 requires an explicit owner Issue revision pin")
    if pin and next(iter(states)) != "state:revision":
        raise RunnerError("Product PR #2 is available only for a pinned revision")
    identifier = task_identifier(body)
    return Task(
        issue=int(issue["number"]),
        task_id=identifier,
        title=issue.get("title") or identifier,
        body=body,
        state_label=next(iter(states)),
        branch="refactor/ui-map-architecture" if pin else branch_for(identifier),
        revision_pr=2 if pin else None,
        revision_head=pin,
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


def scrub_sensitive_environment() -> tuple[str | None, dict[str, str]]:
    """Remove secrets before importing or invoking any SDK-controlled code."""
    api_key = os.environ.get("GEMINI_API_KEY")
    github_transport = {
        name: os.environ[name]
        for name in ("GH_TOKEN", "GITHUB_TOKEN")
        if name in os.environ
    }
    for name in list(os.environ):
        if SENSITIVE_ENV.search(name):
            os.environ.pop(name, None)
    return api_key, github_transport


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


def assert_git_boundary(task: Task, root: Path, expected_head: str) -> None:
    """Reject model/test influence over later privileged Git operations."""
    raw_git_dir = root / ".git"
    if not raw_git_dir.is_dir() or raw_git_dir.is_symlink():
        raise RunnerError("Checkout Git directory is missing, redirected, or not a directory")
    reported = Path(run("git", "rev-parse", "--git-dir", cwd=root))
    if not reported.is_absolute():
        reported = root / reported
    if reported.resolve() != raw_git_dir.resolve():
        raise RunnerError("Checkout uses an unexpected Git directory")
    if run("git", "branch", "--show-current", cwd=root) != task.branch:
        raise RunnerError("Checkout left the dedicated task branch")
    if run("git", "rev-parse", "HEAD", cwd=root) != expected_head:
        raise RunnerError("Checkout HEAD changed outside the harness")
    origin = run("git", "remote", "get-url", "origin", cwd=root)
    if origin not in agent_cycle.EXPECTED_ORIGINS:
        raise RunnerError("Checkout origin changed outside the harness")
    local_keys = run("git", "config", "--local", "--name-only", "--list", cwd=root)
    unsafe_keys = [
        key for key in local_keys.splitlines()
        if key.lower() == "core.hookspath"
        or key.lower().startswith(("include.", "includeif."))
    ]
    if unsafe_keys:
        raise RunnerError("Unsafe local Git configuration: " + ", ".join(unsafe_keys))
    hooks = raw_git_dir / "hooks"
    if hooks.exists():
        active = [
            path.relative_to(raw_git_dir).as_posix()
            for path in hooks.rglob("*")
            if path.is_symlink() or (path.is_file() and not path.name.endswith(".sample"))
        ]
        if active:
            raise RunnerError("Active Git hooks are forbidden: " + ", ".join(sorted(active)))


def remote_branch_exists(branch: str) -> bool:
    executable = TRUSTED_GIT or "git"
    result = subprocess.run(
        (executable, "ls-remote", "--exit-code", "--heads", "origin", branch),
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in {0, 2}:
        raise RunnerError("Could not determine whether the task branch exists")
    return result.returncode == 0


def find_revision_pr(task: Task) -> dict:
    if task.revision_pr is not None:
        pr = gh_json("pr", "view", str(task.revision_pr), "--repo", REPO, "--json",
                     "number,url,state,headRefName,baseRefName,headRefOid,headRepositoryOwner,isCrossRepository")
        if (pr.get("number") != 2 or pr.get("state") != "OPEN"
                or pr.get("headRefName") != task.branch
                or pr.get("baseRefName") != "main"
                or pr.get("headRefOid") != task.revision_head
                or (pr.get("headRepositoryOwner") or {}).get("login") != "Kiris-02"
                or pr.get("isCrossRepository") is not False):
            raise RunnerError("Product PR no longer matches its exact revision pin")
        return pr
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
    if task.revision_pr is None and (pr.get("headRefName") == "refactor/ui-map-architecture" or pr.get("number") == 2):
        raise RunnerError("Refusing to revise Product PR #2")
    if task.revision_pr is not None:
        remote = run("git", "ls-remote", "--heads", "origin", task.branch, cwd=root).split()
        if len(remote) != 2 or remote[0] != task.revision_head:
            raise RunnerError("Product branch moved since the owner pinned its HEAD")
    run("git", "fetch", "origin", f"{task.branch}:refs/remotes/origin/{task.branch}", cwd=root)
    if task.revision_pr is not None and run(
        "git", "rev-parse", f"refs/remotes/origin/{task.branch}", cwd=root
    ) != task.revision_head:
        raise RunnerError("Fetched Product branch differs from the pinned HEAD")
    run("git", "switch", "-c", task.branch, f"origin/{task.branch}", cwd=root)
    return pr


def ensure_product_revision_fixable(task: Task, root: Path) -> None:
    """Do not spend an SDK run on known whitespace errors in forbidden files."""
    if task.revision_pr is None:
        return
    run("git", "fetch", "origin", "main", cwd=root)
    baseline = run("git", "merge-base", "HEAD", "FETCH_HEAD", cwd=root)
    errors = run("git", "diff", "--check", baseline, "HEAD", cwd=root, check=False)
    forbidden = sorted({line.split(":", 1)[0] for line in errors.splitlines()
                        if ":" in line and not path_allowed(line.split(":", 1)[0], root)})
    if forbidden:
        raise RunnerError("Product PR has pre-existing whitespace in protected paths: "
                          + ", ".join(forbidden))


async def run_antigravity(task: Task, root: Path) -> str:
    api_key, github_transport = scrub_sensitive_environment()
    if not api_key:
        os.environ.update(github_transport)
        raise RunnerError("GEMINI_API_KEY disappeared before SDK startup")
    try:
        try:
            from google.antigravity import Agent, LocalAgentConfig, types
            from google.antigravity.hooks import policy
        except ImportError as exc:
            raise RunnerError("google-antigravity is not installed") from exc

        policies = [
            policy.allow("view_file", when=lambda args: read_args_allowed(args, root)),
            policy.allow("list_directory", when=lambda args: read_args_allowed(args, root)),
            policy.allow("search_directory", when=lambda args: read_args_allowed(args, root)),
            policy.allow("find_file", when=lambda args: read_args_allowed(args, root)),
            policy.allow("grep_search", when=lambda args: read_args_allowed(args, root)),
            policy.allow("create_file", when=lambda args: edit_args_allowed(args, root)),
            policy.allow("edit_file", when=lambda args: edit_args_allowed(args, root)),
            policy.deny("*", name="deny-all-unlisted-tools"),
        ]
        instructions = f"""You are Antina, the implementation and testing agent for Gathermap.
Read .agents/README.md, PROTOCOL.md, ANTINA.md, TASK_FORMAT.md, and SAFETY.md first.
Implement only the GRUM_TASK below in the current isolated branch.
Do not call git or gh mutation commands; the outer harness owns branch, commit, push, PR,
labels, and comments. Never merge, deploy, execute migrations, access secrets, or modify
protected protocol/workflow/runner files. You have no command-execution capability;
validation runs later in a separate credential-free GitHub Actions job. If the task is
unsafe, ambiguous, or impossible within these tools, make no changes and explain why.

ISSUE #{task.issue}
{task.body}
"""
        config = LocalAgentConfig(
            api_key=api_key,
            system_instructions=instructions,
            policies=policies,
            capabilities=types.CapabilitiesConfig(
                enable_subagents=False,
                enabled_tools=[
                    types.BuiltinTools.LIST_DIR,
                    types.BuiltinTools.SEARCH_DIR,
                    types.BuiltinTools.FIND_FILE,
                    types.BuiltinTools.VIEW_FILE,
                    types.BuiltinTools.CREATE_FILE,
                    types.BuiltinTools.EDIT_FILE,
                    types.BuiltinTools.FINISH,
                ],
            ),
            workspaces=[str(root.resolve())],
        )
        async with Agent(config) as agent:
            response = await agent.chat(
                "Inspect the repository, implement the task, and finish with a concise factual summary."
            )
            return await response.text()
    finally:
        # Restore only the GitHub transport credentials needed by the outer
        # harness. The model API key and every unrelated secret remain absent.
        os.environ.update(github_transport)


def check_state(check: dict) -> str:
    status = str(check.get("status") or check.get("state") or "").upper()
    conclusion = str(check.get("conclusion") or "").upper()
    if status in {"EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"}:
        return "pending"
    if status == "COMPLETED":
        return "success" if conclusion == "SUCCESS" else "failed"
    if conclusion:
        return "success" if conclusion == "SUCCESS" else "failed"
    return "pending"


def checks_state(rollup: list[dict], required: frozenset[str] = REQUIRED_CHECKS) -> str:
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
            if state == "failed":
                return "failed"
            if state == "pending":
                saw_pending = True
    return "pending" if saw_pending else "success"


def verify_remote_head(task: Task, root: Path, expected_head: str) -> None:
    remote = run("git", "ls-remote", "--heads", "origin", task.branch, cwd=root)
    fields = remote.split()
    if len(fields) != 2 or fields[0] != expected_head:
        raise RunnerError("Remote task branch does not match the pushed commit")


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


def publish(
    task: Task,
    root: Path,
    prior_pr: dict | None,
    summary: str,
    paths: list[str],
    baseline_head: str,
) -> dict:
    assert_git_boundary(task, root, baseline_head)
    if task.revision_pr is not None:
        verify_remote_head(task, root, baseline_head)
    run("git", "add", "--all", cwd=root)
    assert_git_boundary(task, root, baseline_head)
    run(
        "git", "-c", "core.hooksPath=/dev/null",
        "-c", "user.name=Antina Automation",
        "-c", "user.email=antina-automation@users.noreply.github.com",
        "commit", "-m", f"feat(antina): complete {task.task_id}", cwd=root,
    )
    sha = run("git", "rev-parse", "HEAD", cwd=root)
    assert_git_boundary(task, root, sha)
    if task.revision_pr is not None:
        verify_remote_head(task, root, baseline_head)
    run("gh", "auth", "setup-git", cwd=root)
    assert_git_boundary(task, root, sha)
    run(
        "git", "-c", "core.hooksPath=/dev/null", "push", "--set-upstream",
        "origin", task.branch, cwd=root,
    )
    verify_remote_head(task, root, sha)
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
- **Executed Command**: `git diff --check`
- **Result**: Passed.
- **GitHub Actions**: Exact required check `Antina required validation` passed in a separate read-only job.

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
        ensure_product_revision_fixable(task, root)
        agent_cycle.claim(task.issue, task.branch)
        baseline_head = run("git", "rev-parse", "HEAD", cwd=root)
        assert_git_boundary(task, root, baseline_head)
        summary = asyncio.run(run_antigravity(task, root))
        assert_git_boundary(task, root, baseline_head)
        paths = validate_changes(root)
        return publish(task, root, prior_pr, summary, paths, baseline_head)
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
