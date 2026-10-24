# Sensitive data

- **Never logged:** `password`, `passwordHash`, `accessToken`, the `Authorization` header and the JWT secret.
  A shared `redact()` helper (key-based denylist; a key is redacted when its lowercased name
  contains `password`, `secret`, `token`, `authorization`, `cookie`, `apikey` or `hash`) is applied in the request-logging interceptor,
  in the exception filter and before audit `meta` is written.
- **Logs:** app code logs through `logInfo` / `logError` (`src/logging/logger.ts`), never
  `console.*` directly. They run `redact()` and then `maskSensitiveFields()` on `meta`, keep only
  `name`, `message` and `stack` of an `Error`, and print one JSON line to the terminal. In
  production they print nothing; a log service is a later task.
- **Masked in API responses and audit `meta`:** `taxId` and `ownerNationalId` → `••••••1234`
  (last 4), `ownerEmail` → `j•••@example.com`, `ownerPhone` → last 3 digits.
  _(decision)_ After a write, the API never returns these values in full, not even to the owner.
  A real reviewer UI would need a separate audited "reveal" endpoint (not built).
- **Decision note:** `decision_note` is reviewer-written free text, returned unmasked to
  everyone who can view the application, and never written to audit `meta` or logs. A note that
  contains the application's own raw tax or national ID is rejected with 400. See
  [workflow.md §1.2](workflow.md#12-transition-table).
- **Would need field-level encryption** (documented, not implemented): `tax_id`,
  `owner_national_id`, `owner_phone`, `owner_email`. Candidate approach: envelope encryption
  with a KMS-held key. For lookup by tax ID, store a separate HMAC "blind index" column. Postgres
  disk-level encryption alone does not protect against a DB dump or an over-privileged query.
- **Data minimisation:** the system does not collect bank account or card data at all, because
  onboarding doesn't need it yet.

