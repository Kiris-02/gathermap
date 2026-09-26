# Task Specification Template (for Grum)

When creating a new GitHub Issue for Antina, use this structure:

```markdown
## 🎯 Objective
[1-2 sentences clearly describing what needs to be built or fixed]

## 📋 Acceptance Criteria
- [ ] Criterion 1 (Observable behavior)
- [ ] Criterion 2
- [ ] Criterion 3

## ⚠️ Constraints
- Maintain existing database schemas / no breaking migrations without approval.
- Zero regression on existing map interactions and voting logic.
- Keep diff minimal and clean.

## 🧪 Verification
- Command: `npm test` (or specific test command)
- Expected: All tests pass with exit code 0.

## 📁 Files of Interest
- `src/...`
- `tests/...`
```

### Required Initial Labels:
- `to:antina`
- `state:ready`
