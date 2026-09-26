#!/usr/bin/env python3
"""
Agent Cycle Utility for Antina (Google Antigravity)
Facilitates autonomous task pickup, state transitions, and PR reporting on GitHub.
"""

import subprocess
import json
import sys
import argparse

REPO = "Kiris-02/gathermap"

def run_cmd(cmd, check=True):
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
    if check and res.returncode != 0:
        print(f"Error executing: {cmd}\nStderr: {res.stderr}", file=sys.stderr)
        sys.exit(res.returncode)
    return res.stdout.strip()

def list_pending_tasks():
    print("Checking for pending tasks for Antina...")
    cmd = f'gh issue list --repo {REPO} --label "to:antina" --json number,title,labels,body'
    output = run_cmd(cmd)
    issues = json.loads(output) if output else []
    
    if not issues:
        print("No pending tasks for Antina.")
        return []
    
    print(f"Found {len(issues)} pending task(s):")
    for iss in issues:
        lbls = [l["name"] for l in iss.get("labels", [])]
        print(f"  #{iss['number']}: {iss['title']} (Labels: {', '.join(lbls)})")
    return issues

def start_task(issue_num):
    print(f"Starting task #{issue_num}...")
    # Update labels: remove state:ready/state:revision, add state:working
    run_cmd(f'gh issue edit {issue_num} --repo {REPO} --remove-label "state:ready" --add-label "state:working"', check=False)
    run_cmd(f'gh issue edit {issue_num} --repo {REPO} --remove-label "state:revision"', check=False)
    
    branch = f"feat/issue-{issue_num}"
    print(f"Creating / checking out branch '{branch}'...")
    run_cmd(f"git checkout -B {branch}")
    print(f"Ready to work on issue #{issue_num} on branch {branch}!")

def submit_task(issue_num, title, body_text):
    branch = run_cmd("git rev-parse --abbrev-ref HEAD")
    print(f"Pushing branch '{branch}' to origin...")
    run_cmd(f"git push -u origin {branch}")
    
    print("Creating Pull Request...")
    pr_url = run_cmd(f'gh pr create --repo {REPO} --title "{title}" --body "{body_text}" --base main')
    print(f"PR Created: {pr_url}")
    
    # Hand off to Grum
    print(f"Updating Issue #{issue_num} labels: handoff to Grum...")
    run_cmd(f'gh issue edit {issue_num} --repo {REPO} --remove-label "to:antina,state:working" --add-label "to:grum,state:review"')
    
    # Comment report on issue
    comment_body = f"🚀 **Task Completed by Antina**\n\n- Pull Request: {pr_url}\n\nReady for Grum's review."
    run_cmd(f'gh issue comment {issue_num} --repo {REPO} --body "{comment_body}"')
    print("Handoff complete! Grum is now notified.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Antina Task Runner")
    parser.add_argument("action", choices=["list", "start", "submit"], help="Action to perform")
    parser.add_argument("--issue", type=int, help="Issue number")
    parser.add_argument("--title", type=str, help="PR title (for submit)")
    parser.add_argument("--body", type=str, help="PR body (for submit)")
    
    args = parser.parse_args()
    if args.action == "list":
        list_pending_tasks()
    elif args.action == "start":
        if not args.issue:
            print("Please specify --issue <number>")
            sys.exit(1)
        start_task(args.issue)
    elif args.action == "submit":
        if not args.issue or not args.title:
            print("Please specify --issue and --title")
            sys.exit(1)
        submit_task(args.issue, args.title, args.body or "Closes #" + str(args.issue))
