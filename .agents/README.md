# Grum ↔ Antina Agent Loop Architecture

This directory contains persistent coordination rules, protocols, task templates, and safety guidelines for the autonomous agent workflow governing **Gathermap** (`Kiris-02/gathermap`).

---

## 👥 Roles & Authority Hierarchy

1. **Kiris (`Kiris-02`) — Product Owner & Human Authority**
   - Ultimate authority for product intent, UX design, feature approval, and system governance.
   - Escalation point (`NEEDS_KIRIS`) for high-risk operations, budget/credential changes, or architectural ambiguity.

2. **Grum (OpenAI ChatGPT / Codex) — Architect, Planner & Independent Reviewer**
   - Analyzes product goals with Kiris, inspects codebase, writes engineering task specifications.
   - Independently reviews PR diffs, CI test results, and repository state before accepting changes.

3. **Antina (Google Antigravity) — Implementer, Tester & Debugger**
   - Inspects relevant codebase context, works on isolated feature branches, writes code, runs test suites, submits PRs.
   - May utilize internal Antigravity subagents for research, implementation, and regression verification.

---

## 📯 Communication Transports

- **GitHub Issues**: Serves as the primary medium for engineering tasks (`GRUM_TASK`) and agent progress commentary (`ANTINA_STATUS`).
- **Pull Requests**: Serves as the implementation artifact (`ANTINA_REPORT`) and code review workspace (`GRUM_REVIEW`).
- **`.agents/` Directory**: Serves as the persistent source of truth for workflow protocols and safety rules.

---

## 🔄 Task Lifecycle State Machine

```text
       [ DRAFT ]
           │
           ▼
 [ READY_FOR_ANTINA ]
           │
           ▼
   [ ANTINA_WORKING ] ───► [ BLOCKED ]
           │
           ▼
      [ PR_READY ]
           │
           ▼
     [ GRUM_REVIEW ] ───► [ REVISION_REQUIRED ] (Max 4 rounds)
           │                     │
           │                     └────────► [ ANTINA_WORKING ]
           ▼
        [ DONE ]
```

### Lifecycle States
- **`DRAFT`**: Task is being conceptualized by Kiris and Grum.
- **`READY_FOR_ANTINA`**: Task specification is complete and ready for Antina to execute.
- **`ANTINA_WORKING`**: Antina is inspecting code, building on a dedicated branch, and running tests.
- **`PR_READY`**: Implementation is complete, tests pass, and PR is opened for review.
- **`GRUM_REVIEW`**: Grum is evaluating actual code diffs, CI execution, and test results.
- **`DONE`**: PR is accepted by Grum and merged by Kiris/Grum.

### Special & Exception States
- **`REVISION_REQUIRED`**: Grum identified flaws or missing criteria; Antina updates the same PR.
- **`BLOCKED`**: Execution cannot proceed due to external dependency or environmental failure.
- **`NEEDS_KIRIS`**: Requires explicit decision, approval, or intervention from Kiris (human-in-the-loop).
