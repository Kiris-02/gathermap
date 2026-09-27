#!/usr/bin/env python3
"""Guarded GitHub task handoff for the Gathermap Grum/Antina protocol.

This is a transport utility, not an autonomous coding agent. It deliberately
does not create branches, execute task bodies, merge PRs, or deploy anything.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


REPO = "Kiris-02/gathermap"
READY = {"state:ready", "state:revision"}
FORBIDDEN = {"state:blocked", "state:needs-kiris", "NEEDS_KIRIS", "needs:kiris"}
BUSY = {"state:working", "state:review", "state:done", "to:grum"}
EXPECTED_ORIGINS = {
    "https://github.com/Kiris-02/gathermap",
    "https://github.com/Kiris-02/gathermap.git",
    "git@github.com:Kiris-02/gathermap.git",
    "ssh://git@github.com/Kiris-02/gathermap.git",
}


class CycleError(Exception):
    pass


def run(*args):
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise CycleError(f"Missing executable: {args[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise CycleError(f"{' '.join(args[:3])} failed: {exc.stderr.strip()}") from exc
    return result.stdout.strip()


def gh_json(*args):
    try:
        return json.loads(run("gh", *args))
    except json.JSONDecodeError as exc:
        raise CycleError("GitHub returned malformed JSON") from exc


def labels(issue):
    return {label["name"] for label in issue.get("labels") or []}


def task_id(issue):
    match = re.search(
        r"^\s*-\s*\*\*task_id\*\*:\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*$",
        issue.get("body") or "",
        re.MULTILINE,
    )
    if not match:
        raise CycleError("Issue GRUM_TASK must contain a structured task_id")
    return match.group(1)


def issue_view(number):
    return gh_json("issue", "view", str(number), "--repo", REPO,
                   "--json", "number,title,body,state,labels")


def require_task(issue):
    if issue["state"] != "OPEN" or "GRUM_TASK" not in (issue.get("body") or ""):
        raise CycleError("Issue must be open and contain a GRUM_TASK")
    if labels(issue) & FORBIDDEN:
        raise CycleError("Issue is blocked or requires Kiris")
    task_id(issue)


def require_branch(branch, issue=None, pr_number=None):
    actual = run("git", "branch", "--show-current")
    if not branch or branch in {"main", "master"}:
        raise CycleError("A dedicated, non-product task branch is required")
    if branch == "refactor/ui-map-architecture":
        body = (issue or {}).get("body") or ""
        pinned = all(len(re.findall(rf"^- \*\*{name}\*\*: `{value}`\s*$", body,
                                    re.MULTILINE)) == 1
                     for name, value in (("revision_pr", "2"),
                                         ("revision_branch", "refactor/ui-map-architecture")))
        fields = [name for name in ("revision_pr", "revision_branch", "revision_head")
                  if len(re.findall(rf"^- \*\*{name}\*\*:", body, re.MULTILINE)) != 1]
        head_pins = re.findall(
            r"^- \*\*revision_head\*\*: `([0-9a-f]{40})`\s*$", body, re.MULTILINE
        )
        if fields or not pinned or len(head_pins) != 1 or pr_number not in (None, 2):
            raise CycleError("Product branch requires an exact owner Issue pin to PR #2")
    if actual != branch:
        raise CycleError(f"Checkout is on {actual!r}, expected {branch!r}")
    if run("git", "status", "--porcelain"):
        raise CycleError("Working tree must be clean before a state transition")
    origin = run("git", "remote", "get-url", "origin")
    if origin not in EXPECTED_ORIGINS:
        raise CycleError("This checkout does not point at the expected repository")


def pending():
    issues = gh_json("issue", "list", "--repo", REPO, "--state", "open",
                     "--label", "to:antina", "--limit", "100",
                     "--json", "number,title,body,state,labels")
    return [{"number": issue["number"], "title": issue["title"]}
            for issue in issues if issue["state"] == "OPEN"
            and "GRUM_TASK" in (issue.get("body") or "")
            and len(labels(issue) & READY) == 1
            and not labels(issue) & (FORBIDDEN | BUSY)]


def claim(number, branch):
    issue = issue_view(number)
    require_task(issue)
    require_branch(branch, issue=issue)
    current = labels(issue)
    if ("to:antina" not in current or len(current & READY) != 1 or
            current & BUSY):
        raise CycleError("Issue is not in exactly one ready/revision state for Antina")
    if branch == "refactor/ui-map-architecture" and "state:revision" not in current:
        raise CycleError("Product branch can only be claimed for an exact revision")
    old = next(iter(current & READY))
    identifier = task_id(issue)
    run("gh", "issue", "edit", str(number), "--repo", REPO,
        "--remove-label", old, "--add-label", "state:working")
    updated = labels(issue_view(number))
    if "state:working" not in updated or old in updated:
        raise CycleError("Claim label transition was not confirmed")
    run("gh", "issue", "comment", str(number), "--repo", REPO,
        "--body", f"## 🔄 ANTINA_STATUS\n\n- **task_id**: `{identifier}`\n"
                  f"- **state**: ANTINA_WORKING\n"
                  f"- **branch**: `{branch}`\n- **notes**: Claimed from `{old}`.")
    return {"issue": number, "branch": branch, "state": "ANTINA_WORKING"}


def handoff(number, branch, pr_number, report_path):
    issue = issue_view(number)
    require_task(issue)
    require_branch(branch, issue=issue, pr_number=pr_number)
    if not {"to:antina", "state:working"} <= labels(issue):
        raise CycleError("Issue must be owned by Antina and working")
    identifier = task_id(issue)
    pr = gh_json("pr", "view", str(pr_number), "--repo", REPO,
                 "--json", "number,state,headRefName,baseRefName,headRefOid,url")
    if (pr["state"] != "OPEN" or pr["headRefName"] != branch or
            pr["baseRefName"] != "main"):
        raise CycleError("PR must be open, target main, and use this task branch")
    sha = run("git", "rev-parse", "HEAD")
    if sha != pr["headRefOid"]:
        raise CycleError("Local HEAD differs from the PR's pushed HEAD")
    report = Path(report_path).read_text(encoding="utf-8")
    if "ANTINA_REPORT" not in report or sha not in report or pr["url"] not in report:
        raise CycleError("Report must contain ANTINA_REPORT, PR URL, and exact HEAD SHA")
    # A nonzero exit includes failed or pending checks; never hand off as green.
    run("gh", "pr", "checks", str(pr_number), "--repo", REPO)
    # Product PR descriptions are authored independently and must not be replaced
    # by an automation report. The report is retained in the Issue/PR handoff.
    if branch != "refactor/ui-map-architecture":
        run("gh", "pr", "edit", str(pr_number), "--repo", REPO,
            "--body-file", str(report_path))
    else:
        run("gh", "issue", "comment", str(number), "--repo", REPO,
            "--body-file", str(report_path))
    run("gh", "issue", "edit", str(number), "--repo", REPO,
        "--remove-label", "to:antina,state:working",
        "--add-label", "to:grum,state:review")
    updated = labels(issue_view(number))
    expected = {"to:grum", "state:review"}
    control = {name for name in updated
               if name.startswith("to:") or name.startswith("state:")
               or name in {"NEEDS_KIRIS", "needs:kiris"}}
    if control != expected:
        raise CycleError("Handoff requires exact to:grum + state:review labels")
    # Publish PR routing only after the Issue is confirmed in its exact state.
    run("gh", "pr", "edit", str(pr_number), "--repo", REPO,
        "--add-label", "to:grum")
    run("gh", "issue", "comment", str(number), "--repo", REPO,
        "--body", f"## 📤 ANTINA_REPORT\n\n- **task_id**: `{identifier}`\n"
                  f"- **pr**: {pr['url']}\n"
                  f"- **commit**: `{sha}`\n- **status**: PR_READY")
    # The PR comment is the GitHub webhook wake-up after checks are green.
    run("gh", "pr", "comment", str(pr_number), "--repo", REPO,
        "--body", f"## 📯 ANTINA_HANDOFF\n\n- **issue**: #{number}\n"
                  f"- **task_id**: `{identifier}`\n- **commit**: `{sha}`\n"
                  f"- **state**: GRUM_REVIEW")
    return {"issue": number, "pr": pr["url"], "commit": sha,
            "state": "PR_READY"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("list", help="Print eligible tasks; no state changes")
    claim_parser = sub.add_parser("claim", help="Claim in an existing clean task checkout")
    claim_parser.add_argument("--issue", type=int, required=True)
    claim_parser.add_argument("--branch", required=True)
    handoff_parser = sub.add_parser("handoff", help="Hand off a green PR to Grum")
    handoff_parser.add_argument("--issue", type=int, required=True)
    handoff_parser.add_argument("--branch", required=True)
    handoff_parser.add_argument("--pr", type=int, required=True)
    handoff_parser.add_argument("--report", required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "list":
            result = pending()
        elif args.action == "claim":
            result = claim(args.issue, args.branch)
        else:
            result = handoff(args.issue, args.branch, args.pr, args.report)
    except (CycleError, OSError) as exc:
        parser.exit(1, f"agent_cycle: {exc}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
