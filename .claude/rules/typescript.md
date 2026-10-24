---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---

# TypeScript rules

- Strict mode is on (`strict`, `noUncheckedIndexedAccess`). No `any` (use `unknown` and narrow),
  no `@ts-ignore`/`@ts-nocheck`, no non-null `!` to silence errors (definite assignment `!:` on
  DTO/entity properties is fine).
- Exported functions and public methods declare explicit return types.
- One Nest module per feature (`src/<feature>/<feature>.module.ts`). Shared code goes in `src/common/`.
- Dependencies come in through constructor injection only; never `new` a provider.
- Once class-validator is added with the API task, request bodies and queries are class-validator
  DTO classes, never inline types or `any`.
- Configuration is read only through `@nestjs/config` (`ConfigService`); never read
  `process.env` outside the config setup.
