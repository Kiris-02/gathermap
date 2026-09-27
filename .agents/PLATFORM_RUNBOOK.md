# Platform lane: guarded GitHub handoff (v1)

This branch is separate from the Product lane (`refactor/ui-map-architecture`).
The canonical protocol remains `PROTOCOL.md`, `SAFETY.md`, and `TASK_FORMAT.md`.
The utility in `scripts/agent_cycle.py` is a small transport component, not
an agent runtime. It **does not** wake Antigravity or Grum, execute an Issue
body, merge a PR, or deploy. Do not describe it as a hands-free loop.

## Set up on the Antina machine

Install and authenticate GitHub CLI (`gh auth status`). Use a separate Git
worktree per task; do not reuse the Product checkout. Start the task worktree
from the current `origin/main` and give it a dedicated branch. Run these
commands from that clean task worktree:

```sh
python scripts/agent_cycle.py list
python scripts/agent_cycle.py claim --issue NUMBER --branch chore/task-NUMBER
```

`list` is read-only. `claim` checks the existing branch, clean checkout,
repository origin, open `GRUM_TASK`, and `to:antina` plus exactly one of
`state:ready` or `state:revision`. It then changes the label to
`state:working`, verifies the result, and posts `ANTINA_STATUS`. It refuses
`NEEDS_KIRIS`/blocked tasks. It does not create/reset a branch or run code.

After the task's implementation and tests, push the same task branch, wait for
all GitHub PR checks to pass, and write a UTF-8 report file **outside the
task checkout** (the checkout must remain clean) using the
`ANTINA_REPORT` template. Include the exact `git rev-parse HEAD` SHA and
full PR URL. Then run:

```sh
python scripts/agent_cycle.py handoff --issue NUMBER --branch chore/task-NUMBER --pr PR_NUMBER --report ../antina-report.md
```

`handoff` confirms the open PR targets `main`, its head matches the local and
remote task branch, the report identifies the same PR/HEAD, and `gh pr checks`
exits successfully. It updates the PR description, changes Issue labels to
`to:grum,state:review`, verifies them, and posts a short Issue pointer. It
never approves or merges. GitHub labels are not a transactional lock: run
only one Antina pickup worker for a repository until an atomic claim mechanism
exists. If a step fails, inspect the Issue/PR before retrying; a partial
handoff is possible.

## What's still required for a true no-human relay

1. A supported Antigravity trigger or supervised local worker to invoke
   `list` and start the agent in its own task worktree. Polling alone does not
   start an Antigravity conversation.
2. A Grum wake-up bound to the PR/report event with authorized GitHub read
   access, independent diff and CI review, and `GRUM_REVIEW` publication.
3. A single-worker/atomic-claim mechanism plus tests for retries, duplicate
   events, missing labels, and recoverable partial transitions.

Until these are built and validated, Kiris remains the trigger. Production
migrations, deployment, secrets, self-merging, and force-push remain outside
this utility and subject to `SAFETY.md`.

Run offline guardrail tests with:

```sh
python -m unittest discover -s tests -p 'test_agent_cycle.py' -v
```
