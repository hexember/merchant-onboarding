# Sensitive data

- **Never logged:** `password`, `passwordHash`, `accessToken`, the `Authorization` header and the JWT secret.
  A shared `redact()` helper (key-based denylist; a key is redacted when its lowercased name
  contains `password`, `secret`, `token`, `authorization`, `cookie`, `apikey` or `hash`) is applied in the request-logging interceptor,
  in the exception filter and before audit `meta` is written.
- **Masked in API responses and audit `meta`:** `taxId` and `ownerNationalId` → `••••••1234`
  (last 4), `ownerEmail` → `j•••@example.com`, `ownerPhone` → last 3 digits.
  _(decision)_ After a write, the API never returns these values in full, not even to the owner.
  A real reviewer UI would need a separate audited "reveal" endpoint (not built).
- **Logs:** every log line the app writes after startup goes through `LoggingModule`
  (`src/logging/`). `meta` passes through `sanitizeForLog`: any nested `Error` is serialized, then
  `redact()` and `maskSensitiveFields()` run. Errors go through `serializeError` (name, message,
  code, and the stack outside production only); a database query error (`QueryFailedError`, or
  any error with a `driverError`) gets the fixed message `Database query failed` plus its
  SQLSTATE `code`, because the driver's message can echo input values. In production a stack
  string passed as a message, context or `meta` value is never written. Loose string arguments
  have no key for `redact()` to match, so they are dropped and only counted
  (`meta.droppedValues`). The global `AllExceptionsFilter` logs only the request method, the
  matched route pattern (`/applications/:id`, or `[unmatched]`; never the raw path), status and
  `code`. Its response never echoes internals or input: every 5xx body is the generic status
  text, and the framework 400s for a malformed JSON body or URL parameter get a fixed message.
  If the app fails before its Nest context exists, Nest's buffered startup lines are
  dropped (`autoFlushLogs: false`) and one line is written through the same JSON console writer,
  using `serializeError` without a stack.
- **Would need field-level encryption** (documented, not implemented): `tax_id`,
  `owner_national_id`, `owner_phone`, `owner_email`. Candidate approach: envelope encryption
  with a KMS-held key. For lookup by tax ID, store a separate HMAC "blind index" column. Postgres
  disk-level encryption alone does not protect against a DB dump or an over-privileged query.
- **Data minimisation:** the system does not collect bank account or card data at all, because
  onboarding doesn't need it yet.

