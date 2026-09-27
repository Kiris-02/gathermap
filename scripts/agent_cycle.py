#!/usr/bin/env python3
"""Guarded GitHub task handoff for the Gathermap Grum/Antina protocol.

This is a transport utility, not an autonomous coding agent. It deliberately
does not create branches, execute task bodies, merge PRs, or deploy anything.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


REPO = "Kiris-02/gathermap"
READY = {"state:ready", "state:revision"}
FORBIDDEN = {"state:blocked", "state:needs-kiris", "NEEDS_KIRIS"}


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


def issue_view(number):
    return gh_json("issue", "view", str(number), "--repo", REPO,
                   "--json", "number,title,body,state,labels")


def require_task(issue):
    if issue["state"] != "OPEN" or "GRUM_TASK" not in (issue.get("body") or ""):
        raise CycleError("Issue must be open and contain a GRUM_TASK")
    if labels(issue) & FORBIDDEN:
        raise CycleError("Issue is blocked or requires Kiris")


def require_branch(branch):
    actual = run("git", "branch", "--show-current")
    if not branch or branch in {"main", "master", "refactor/ui-map-architecture"}:
        raise CycleError("A dedicated, non-product task branch is required")
    if actual != branch:
        raise CycleError(f"Checkout is on {actual!r}, expected {branch!r}")
    if run("git", "status", "--porcelain"):
        raise CycleError("Working tree must be clean before a state transition")
    origin = run("git", "remote", "get-url", "origin")
    if not (origin.endswith("Kiris-02/gathermap.git") or
            origin.endswith("Kiris-02/gathermap")):
        raise CycleError("This checkout does not point at the expected repository")


def pending():
    issues = gh_json("issue", "list", "--repo", REPO, "--state", "open",
                     "--label", "to:antina", "--limit", "100",
                     "--json", "number,title,body,state,labels")
    return [{"number": issue["number"], "title": issue["title"]}
            for issue in issues if issue["state"] == "OPEN"
            and "GRUM_TASK" in (issue.get("body") or "")
            and labels(issue) & READY and not labels(issue) & FORBIDDEN]


def claim(number, branch):
    require_branch(branch)
    issue = issue_view(number)
    require_task(issue)
    current = labels(issue)
    if "to:antina" not in current or len(current & READY) != 1:
        raise CycleError("Issue is not in exactly one ready/revision state for Antina")
    old = next(iter(current & READY))
    run("gh", "issue", "edit", str(number), "--repo", REPO,
        "--remove-label", old, "--add-label", "state:working")
    updated = labels(issue_view(number))
    if "state:working" not in updated or old in updated:
        raise CycleError("Claim label transition was not confirmed")
    run("gh", "issue", "comment", str(number), "--repo", REPO,
        "--body", f"## 🔄 ANTINA_STATUS\n\n- **state**: ANTINA_WORKING\n"
                  f"- **branch**: `{branch}`\n- **notes**: Claimed from `{old}`.")
    return {"issue": number, "branch": branch, "state": "ANTINA_WORKING"}


def handoff(number, branch, pr_number, report_path):
    require_branch(branch)
    issue = issue_view(number)
    require_task(issue)
    if not {"to:antina", "state:working"} <= labels(issue):
        raise CycleError("Issue must be owned by Antina and working")
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
    run("gh", "pr", "edit", str(pr_number), "--repo", REPO,
        "--body-file", str(report_path))
    run("gh", "issue", "edit", str(number), "--repo", REPO,
        "--remove-label", "to:antina,state:working",
        "--add-label", "to:grum,state:review")
    updated = labels(issue_view(number))
    if not {"to:grum", "state:review"} <= updated:
        raise CycleError("Handoff label transition was not confirmed")
    run("gh", "issue", "comment", str(number), "--repo", REPO,
        "--body", f"## 📤 ANTINA_REPORT\n\n- **pr**: {pr['url']}\n"
                  f"- **commit**: `{sha}`\n- **status**: PR_READY")
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
