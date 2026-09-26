# Task Completion Report Template (for Antina)

When Antina opens a Pull Request to complete an Issue, post this comment on the Issue:

```markdown
### 🚀 ANTINA EXECUTION REPORT

- **Issue**: Closes #[Issue Number]
- **Pull Request**: #[PR Number] (`[branch-name]`)
- **Status**: Ready for Grum's Independent Review

#### 🛠️ Changes Implemented
- [Bullet 1 summarizing key code change]
- [Bullet 2]

#### 🧪 Verification Output
- `[test command run, e.g. npm test]`: **PASS** (Exit code 0)
```[Test summary or relevant log output]```

#### 🔍 Files Modified
- `path/to/file1.ts`
- `path/to/file2.ts`

#### ⚠️ Edge Cases & Notes
- [Any specific consideration or regression check performed]
```

### Label Transitions:
- Remove: `to:antina`, `state:working` (or `state:ready`)
- Add: `to:grum`, `state:review`
