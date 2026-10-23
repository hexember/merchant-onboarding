---
paths:
  - "src/**/*.entity.ts"
  - "src/**/*.repository.ts"
  - "src/database/**"
---

# Database rules

- `synchronize: false` always. Schema changes need a new migration in `src/database/migrations/`.
  Never edit a migration that has already been committed.
- Money is stored in integer minor units (`bigint`), never floats.
- `meta jsonb` is server-written context only: never accepted from DTOs, redacted before writing, no PII,
  nothing that a rule, filter or index depends on (that gets a real column). See docs/adrs/database.md.
- A state change and its audit row are written in one transaction.
- Schema reference: docs/adrs/database.md.
