# Agent Message Format Standards

All formal communications between **Grum** and **Antina** must adhere to the four structured Markdown templates defined below.

---

## 1. GRUM_TASK (Issued by Grum on GitHub Issue)

`markdown
## 📋 GRUM_TASK

- **task_id**: TASK-XXX
- **goal**: [Concise single-sentence summary of the task]
- **context**: [Problem background, architectural motivation, or bug report]

### 🎯 Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

### ⚠️ Constraints
- Constraint 1
- Constraint 2

### 📁 Files of Interest
- path/to/file1.js
- path/to/file2.js

### 🧪 Verification
- Command: 
pm test
- Manual check: [Step-by-step verification instruction]

### 🚫 Out of Scope
- Out-of-scope item 1
`

---

## 2. ANTINA_STATUS (Issued by Antina on GitHub Issue comment)

`markdown
## 🔄 ANTINA_STATUS

- **task_id**: TASK-XXX
- **state**: ANTINA_WORKING | BLOCKED | NEEDS_KIRIS
- **branch**: eat/task-xxx-description
- **notes**: [Current phase of implementation, subagent progress, or blocker details]
`

---

## 3. ANTINA_REPORT (Issued by Antina on Pull Request description)

`markdown
## 📤 ANTINA_REPORT

- **task_id**: TASK-XXX
- **status**: PR_READY | REVISION_REQUIRED
- **pr**: #123 (or https://github.com/Kiris-02/gathermap/pull/123)
- **commit**: [SHA]
- **summary**: [Concise summary of implementation changes]

### 📁 Files Changed
- path/to/file1.js (+12, -3)

### 🧪 Verification
- **Executed Command**: 
pm test
- **Result**: [Pass/Fail summary]

### ⚠️ Risks
- [Potential side-effects or sensitive areas modified]

### ❓ Unresolved Items
- None (or list open questions)

> 🛑 **Author Confirmation**: I will not self-merge this Pull Request.
`

---

## 4. GRUM_REVIEW (Issued by Grum on Pull Request comment)

`markdown
## 🔍 GRUM_REVIEW

- **task_id**: TASK-XXX
- **decision**: ACCEPT | REVISION_REQUIRED | NEEDS_KIRIS
- **findings**: [Detailed observations from diff inspection]
- **required_changes**: 
  - [ ] Action item 1 (if REVISION_REQUIRED)
- **verification_notes**: [Notes on CI run or test validation]
- **next_state**: DONE | ANTINA_WORKING | NEEDS_KIRIS
`
