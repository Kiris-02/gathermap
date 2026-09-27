# Platform lane: guarded GitHub handoff and Antina wake-up

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
`to:grum,state:review`, verifies them, labels the PR `to:grum`, and posts an
`ANTINA_HANDOFF` PR comment. That comment is the Grum webhook wake-up, so it
is emitted only after the checks gate passes. It
never approves or merges. GitHub labels are not a transactional lock: run
only one Antina pickup worker for a repository until an atomic claim mechanism
exists. If a step fails, inspect the Issue/PR before retrying; a partial
handoff is possible.

## Automatic Antina runner (v2)

`.github/workflows/antina-runner.yml` wakes only on an Issue label event. The
Issue must be open, authored by the repository owner, contain a structured
`GRUM_TASK`, and have the exact control labels `to:antina` plus one of
`state:ready` or `state:revision`. GitHub Actions concurrency permits one run
per Issue; duplicate/stale events exit without mutation.

The workflow uses the official Google Antigravity Python SDK. The SDK agent is
deny-by-default: it may inspect files, edit only non-protected paths, and run a
small allowlist of read-only/test commands inside the SDK OS sandbox. It cannot
use GitHub mutation tools. `scripts/antina_runner.py` owns branch preparation,
claim, verification, commit, push, PR creation/update, CI wait, and the v1
handoff to Grum. It refuses Product PR #2, protocol/workflow/runner files,
migrations, secrets, deploy commands, force operations, and self-merge.

### One-time activation

Kiris must create the repository Actions secret `GEMINI_API_KEY`. Never paste
the value into an Issue, PR, file, comment, or workflow. Without the secret, an
eligible task fails closed to `NEEDS_KIRIS`; it does not start an SDK session.

After the secret exists, activate a task by applying its final exact labels:

```text
to:antina + state:ready
```

For a Grum revision on the deterministic existing task branch, use:

```text
to:antina + state:revision
```

The runner creates new branches as `agent/<normalized-task-id>`. A ready task
with a pre-existing remote branch, or a revision without exactly one open PR,
stops at `NEEDS_KIRIS` for recovery rather than guessing.

### Disable / rollback

Disable the `Wake Antina` workflow in GitHub Actions or remove either required
Issue label. Existing runs can be cancelled from Actions. Revoking/deleting the
repository secret prevents future SDK sessions. None of these actions merge or
deploy code.

## Remaining limitations

1. Grum wake-up is currently an external ChatGPT GitHub webhook automation,
   not repository code. It passed the PR #7 handoff/revision test, but must
   remain enabled and independently authorized for the loop to continue.
2. GitHub label changes are not transactional. Per-Issue workflow concurrency
   prevents duplicate executions in the supported path, but manual/local v1
   claimers must not run concurrently with the workflow.

Until v2 is merged, the secret is configured, and an end-to-end disposable task
passes, Kiris remains the Antina trigger. Production migrations, deployment,
secrets, self-merging, and force-push remain outside this utility and subject
to `SAFETY.md`.

Run offline guardrail tests with:

```sh
python -m unittest discover -s tests -p 'test_agent_cycle.py' -v
python -m unittest discover -s tests -p 'test_antina_runner.py' -v
```
