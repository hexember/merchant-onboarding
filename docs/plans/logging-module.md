# Logging: simple log functions with sensitive data removed

## Goal
Replace direct `console.*` calls with `logInfo(context, message, meta)` and
`logError(context, message, meta)` in `src/logging/logger.ts`. Before printing, `meta` goes through
the existing `redact()` and `maskSensitiveFields()` helpers, and an `Error` keeps only `name`,
`message` and `stack`. Each call prints one JSON line to the terminal (`logError` to stderr).
In production nothing is printed. No new dependency.

## Scope
- In: `src/logging/logger.ts` + `logger.spec.ts`; `configureLogger` called once in `src/main.ts`
  with the validated `NODE_ENV`; a **Logs** bullet in `docs/adrs/sensitive-data.md`; a README
  section.
- Out: a log service (for example Grafana), log levels, a global exception filter, request
  logging, and moving the seed to these functions. Each is a later task.

## Design
- Plain functions, not a Nest provider, so any file can call them.
- `process.env` is never read here: `main.ts` passes `production` from `ConfigService`. Until
  `configureLogger` runs, nothing is printed.
- A later log service is added inside `write()` in `logger.ts`.

## Tests
`src/logging/logger.spec.ts`: one JSON line to stdout/stderr outside production; nothing in
production; denied cases that a password, token and raw `taxId` never appear; `Error` extra
properties (such as query parameters) are dropped; the input is not changed.
