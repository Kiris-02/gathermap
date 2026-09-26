# Safety Rules & Human Approval Protocols

To ensure data integrity, system security, and product alignment, both **Grum** and **Antina** must strictly enforce mandatory human approval (NEEDS_KIRIS) for any operation listed below.

---

## 🚨 Operations Requiring Explicit Kiris Approval

Neither Grum nor Antina may execute or merge any of the following without prior explicit written consent from Kiris:

1. **Destructive Database Migrations**: Dropping tables, altering non-null columns without fallbacks, or destroying database schemas.
2. **Data Deletion**: Deleting user data, production records, or critical project assets.
3. **Production Deployments**: Triggering production deployment pipelines or updating production host environments (e.g. Render, Supabase).
4. **Secrets & Credentials**: Modifying, creating, or committing API keys, tokens, .env files, or authentication secrets.
5. **Billing & Costs**: Actions that incur new financial charges, subscription tier upgrades, or API billing modifications.
6. **Infrastructure Risk**: Provisioning or modifying cloud infrastructure resources with meaningful cost or downtime risk.
7. **Irreversible Git Operations**: Force-pushing (git push --force), deleting remote branches with active work, or rebasing shared public branches.
8. **Scope Creep / Architecture Overhaul**: Major architectural redesigns or structural refactors that fall outside the explicitly assigned GRUM_TASK.
9. **Destructive External Operations**: Executing destructive API calls against third-party production services (e.g. Google Maps Platform, Supabase Cloud, OpenRouteService).

---

## 🛑 Escalation Procedure

When an operation touches any of the above categories:
1. Set the task state immediately to **NEEDS_KIRIS**.
2. Document the specific operation, associated risks, and reason for escalation in the Issue/PR comment.
3. Pause all automated execution until Kiris explicitly provides approval.
