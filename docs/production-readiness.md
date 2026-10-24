# Production readiness

Work that is deliberately not built yet but must be done before the project runs in production.
Each item links to the design doc that explains it. Tick an item only when it is built and tested.

## Database

- [ ] **Run the app as a restricted database role.** Today the app connects as the owner of
  `audit_logs`, so it could disable or drop the append-only triggers. Migrations and the seed keep
  using the owner role; the running app uses a separate role with normal access to other tables and
  only `INSERT, SELECT` on `audit_logs`. Integration tests should then connect as that role and
  check that it cannot update, delete, truncate or alter `audit_logs`.
  See [database.md](adrs/database.md#audit_logs-append-only).

## Auth

- [ ] **Short-lived access tokens with refresh and revocation.** Add rotating refresh tokens and
  a token version on the user. See [auth.md](adrs/auth.md).

## Sensitive data

- [ ] **Field-level encryption** for `tax_id`, `owner_national_id`, `owner_phone` and
  `owner_email`, with a blind index for tax ID lookup.
  See [sensitive-data.md](adrs/sensitive-data.md).
- [ ] **Audited "reveal" endpoint**, if a reviewer UI needs to see full values.
  See [sensitive-data.md](adrs/sensitive-data.md).
