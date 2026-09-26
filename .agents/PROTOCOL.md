# Grum ↔ Antina Coordination Protocol

This document defines the strict operational rules governing task creation, implementation, code review, and quality assurance for the Grum ↔ Antina agent loop.

---

## 📜 Core Operational Rules

1. **Task Granularity**: One GitHub Issue represents exactly one discrete engineering task (GRUM_TASK).
2. **Branch & PR Scope**: One implementation branch and Pull Request per task, unless explicit rationale is documented.
3. **Concise & Structured Communication**: All agent communications on Issues and PRs must use structured Markdown formats (TASK_FORMAT.md) without filler prose.
4. **Zero Faith Reporting**: Antina's self-reported success or test output is never accepted as proof of correctness on its own.
5. **Independent Inspection**: Grum must independently inspect actual source code diffs, execution logs, test outputs, and CI results before issuing an approval.
6. **No Self-Merging**: Antina is strictly forbidden from merging its own Pull Requests under any circumstances.
7. **Revision Limit**: A task is allowed a maximum of **4 revision rounds** (REVISION_REQUIRED).
8. **Mandatory Human Escalation (NEEDS_KIRIS)**: Repeated failure (exceeding 4 rounds), architectural disagreement between agents, ambiguous product intent, or risky operations must immediately transition state to NEEDS_KIRIS.
9. **No Code Dumps**: Agents must avoid dumping large code blocks into Issue comments or PR descriptions when Grum can inspect files directly in the repository/PR diff.
10. **Project Rule Precedence**: Existing Gathermap repository rules, linting standards, and project guidelines strictly override generic agent conventions.
