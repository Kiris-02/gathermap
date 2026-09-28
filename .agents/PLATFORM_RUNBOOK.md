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

`.github/workflows/antina-runner.yml` wakes only when `to:antina` is newly
applied to an Issue. Apply the state label first and `to:antina` last; state
label events do not start a second run. The
Issue must be open, authored by the repository owner, contain a structured
`GRUM_TASK`, and have the exact control labels `to:antina` plus one of
`state:ready` or `state:revision`. GitHub Actions concurrency permits one run
per Issue; duplicate/stale events exit without mutation.

The workflow uses the official Google Antigravity Python SDK. The SDK agent is
deny-by-default: it may inspect files and edit only non-protected paths. It has
no command-execution or GitHub mutation tool. `scripts/antina_runner.py` owns
branch preparation, claim, Git-boundary verification, commit, push, PR
creation/update, CI wait, and the v1 handoff to Grum. Before every privileged
commit or push, the harness rechecks the exact branch and HEAD, canonical
origin, local Git includes/hook path, and active hooks; harness Git commands
also disable hooks explicitly. It refuses un-pinned Product PR #2,
protocol/workflow/runner files, migrations, secrets, force operations, and
self-merge.

Repository-controlled tests never execute in the credential-bearing Antina
runner job. `.github/workflows/antina-validation.yml` runs the fixed Python and
Node suites in a separate job with `contents: read`, checkout credentials
disabled, and no later privileged Git operation. The harness waits for the
exact `Antina required validation` check; an empty rollup, an unrelated green
check, a pending check, or a skipped/failed required check cannot pass the
gate.

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

Exception for Product PR #2: an owner-authored Issue with `state:revision`
may explicitly authorize only the existing `refactor/ui-map-architecture`
branch by adding these three structured fields to its `GRUM_TASK` body:

```text
- **revision_pr**: `2`
- **revision_branch**: `refactor/ui-map-architecture`
- **revision_head**: `<exact 40-character lowercase SHA of PR #2 HEAD>`
```

Record the current PR HEAD immediately before activation. The runner verifies
the PR is open, targets `main`, belongs to this repository, and still has the
exact pinned SHA. It verifies the remote before fetch, after fetch, and before
commit/push; normal non-force push fails if the branch moves in between. The
Product PR description is preserved on handoff. An absent or stale pin stops
the job; do not retry blindly. The branch remains subject to protected-path
rules: `.agents/`, `.github/`, migrations, secrets, and the runner itself may
not be edited by the SDK. The independent validation check also requires the
full PR diff to pass `git diff --check` and all product tests. If a required
fix lies in a protected path, stop at `NEEDS_KIRIS` and assign that change to
the appropriate separately reviewed lane. A preflight catches pre-existing
whitespace errors in protected paths before the SDK session starts.

The runner creates new branches as `agent/<normalized-task-id>`. A ready task
with a pre-existing remote branch, or a revision without exactly one open PR,
### Quota handling and bounded backoff

The runner enforces bounded exponential backoff on Gemini API rate limit errors
(HTTP 429 / `RESOURCE_EXHAUSTED` on `generativelanguage.googleapis.com/generate_content_free_tier_requests`).
The Free Tier limit for `gemini-3.7-flash` is 5 requests per minute (RPM).
A single multi-turn agent interaction performing multiple tool calls in rapid
succession will easily exceed 5 RPM. Because the quota window resets every minute,
transient spikes are handled with up to 3 retry attempts with exponential backoff
(15s, 30s). If quota remains exhausted after retries, the job fails closed to
`NEEDS_KIRIS` with an actionable, sanitized message. API keys and secrets are
never printed or logged.

If paid access is desired, Kiris can link a billing account to the project in
Google AI Studio or Google Cloud Console, which raises the quota to standard Pay-as-you-go
tiers (360+ RPM). Under the Free Tier, tasks must tolerate rate limit delays.

### PR Checks and downstream CI gate

The runner strictly verifies that all required checks:
1. `Antina required validation` (from `antina-validation.yml`)
2. `Test Suite & Browser E2E` (from `ci.yml`)

pass against the exact commit SHA of the PR HEAD. The check gate treats empty,
pending, skipped, stale, approval-required (`ACTION_REQUIRED` / `WAITING`), and failed
checks as failures that stop the loop.

**Security Boundary on `GITHUB_TOKEN`**:
Per GitHub Actions documentation (https://docs.github.com/en/actions/concepts/security/github_token),
events created by `GITHUB_TOKEN` (such as push or pull_request) do NOT trigger downstream
`pull_request` workflows. This prevents recursive workflow loops. Consequently, when
`antina_runner.py` creates a PR using `GITHUB_TOKEN`, downstream check workflows do not run
automatically without human approval or an external trigger.

**Proposals for downstream CI execution**:
- **Proposal A (Recommended - Minimal Fine-Grained Secret)**:
  Configure an Actions secret `ANTINA_BOT_TOKEN` containing a fine-grained Personal Access
  Token (or GitHub App) with only `contents: write` and `pull-requests: write`. When Antina
  uses this token to push branches and open PRs, GitHub treats it as an independent identity
  and triggers `Antina validation` and `GatherMap CI` automatically without requiring manual approval.
- **Proposal B (Workflow Dispatch with Expanded Permissions)**:
  Add `workflow_dispatch` triggers to `antina-validation.yml` and `ci.yml`, grant `actions: write`
  to `antina-runner.yml`, and have `antina_runner.py` dispatch the checks directly against the PR ref.

Per safety rules, broader token permissions and new secrets remain stopped for Kiris's explicit decision.

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
3. Automated downstream check triggering requires Kiris to choose Proposal A (PAT)
   or Proposal B (workflow_dispatch).

Until an end-to-end disposable task passes, the automatic runner remains
unproven in production use. Production migrations, deployment,
secrets, self-merging, and force-push remain outside this utility and subject
to `SAFETY.md`.

Run offline guardrail tests with:

```sh
python -m unittest discover -s tests -p 'test_agent_cycle.py' -v
python -m unittest discover -s tests -p 'test_antina_runner.py' -v
```
