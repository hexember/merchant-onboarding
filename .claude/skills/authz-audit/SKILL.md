---
name: authz-audit
description: Cross-check the authorization matrix in docs/adrs/auth.md against the implemented endpoints and the integration tests, and list any rule that is unenforced or untested.
---

1. Read the authorization matrix in `docs/adrs/auth.md`.
2. For every endpoint/role cell, find:
   - the guard or decorator that enforces it (`@Roles`, the scoped repository call, the assignee check)
   - the integration test in `test/` that proves the **denied** case (expected 401/403/404)
3. Output one table with these columns: endpoint | role | expected | enforced at (file:line) | tested at (file:line).
   Mark any missing cell **MISSING**.
4. Pay particular attention to the explicitly required cases. These must have tests:
   - SALES cannot read or change another SALES user's application by ID
   - only the assigned REVIEWER can record a decision
5. Do not modify code. Suggest the exact test cases to add for each MISSING row.
