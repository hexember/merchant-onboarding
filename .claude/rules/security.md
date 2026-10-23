# Security rules (always apply)

- **No secrets in git.** Only `.env.example` holds placeholders. Never read or print `.env`.
  Don't hardcode secrets or passwords, not even in seeds or tests; read them from env.
- **No authz bypass.** Application lookups reachable from a request go through the scoped
  repository method (SALES → `sales_owner_id`, REVIEWER → `assigned_reviewer_id`). Never use an unscoped `findOne({ id })`.
  Out of scope or unknown ID → 404; wrong role → 403. Only the assigned REVIEWER may record a decision.
- **Fake data only** (`@example.com`, made-up names/IDs). No real PII or card numbers.
- **Never log sensitive data:** passwords, hashes, JWTs, `Authorization` headers, or raw
  `taxId`/`ownerNationalId`. Use the shared `redact()`/mask helpers.
- `dev.notes/` is the git-ignored requirements doc. Never commit it or quote it in committed files.
