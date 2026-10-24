# Sensitive data

- **Never logged:** `password`, `passwordHash`, `accessToken`, the `Authorization` header and the JWT secret.
  A shared `redact()` helper (key-based denylist; a key is redacted when its lowercased name
  contains `password`, `secret`, `token`, `authorization`, `cookie`, `apikey` or `hash`) is applied in the request-logging interceptor,
  in the exception filter and before audit `meta` is written.
- **Masked in API responses and audit `meta`:** `taxId` and `ownerNationalId` → `••••••1234`
  (last 4), `ownerEmail` → `j•••@example.com`, `ownerPhone` → last 3 digits.
  _(decision)_ After a write, the API never returns these values in full, not even to the owner.
  A real reviewer UI would need a separate audited "reveal" endpoint (not built).
- **Would need field-level encryption** (documented, not implemented): `tax_id`,
  `owner_national_id`, `owner_phone`, `owner_email`. Candidate approach: envelope encryption
  with a KMS-held key. For lookup by tax ID, store a separate HMAC "blind index" column. Postgres
  disk-level encryption alone does not protect against a DB dump or an over-privileged query.
- **Data minimisation:** the system does not collect bank account or card data at all, because
  onboarding doesn't need it yet.

