---
paths:
  - "src/**/*.controller.ts"
  - "src/**/*.dto.ts"
  - "src/**/*.service.ts"
  - "src/common/**"
---

# API rules

- Thin controllers. Business rules live in services and pure functions. The transition table is
  data (docs/adrs/workflow.md §1.2).
- Domain errors are mapped by the global filter to `{ statusCode, error, message, code }`. Invalid
  transitions and conflicts → 409.
- DTOs are whitelisted. Clients can never set `createdById`, `status`, `kybStatus`, `kybLevel`, `kybScore`
  or `version`. `salesOwnerId` is accepted only from ADMIN (on create and transfer), and the target
  must be a SALES user.
- Responses never include `passwordHash`. Sensitive fields are masked (docs/adrs/sensitive-data.md).
- Authorization matrix: docs/adrs/auth.md.
