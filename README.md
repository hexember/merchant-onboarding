# merchant-onboarding

Merchant onboarding & risk review API built with NestJS, PostgreSQL, TypeORM, BullMQ and Redis.

## Overview

A backend API for **merchant onboarding and risk review** at a payments company:

1. SALES creates a merchant application (draft) and can edit it.
2. SALES submits it, which moves it to `RISK_REVIEW`. The application is locked, and an async
   KYB/risk check runs against a simulated provider, with retries and idempotency.
3. When the check finishes, the system moves the application to `UNDER_REVIEW`. ADMIN assigns it
   to a REVIEWER, either during the check or after it.
4. The assigned REVIEWER approves, rejects or requests info. Request info sends it back to SALES
   to edit, and resubmitting starts a new risk check.
5. Every significant action is written to an audit log, with sensitive fields masked.

The project is backend only; Swagger UI at `/docs` serves as the UI (OpenAPI JSON at `/docs-json`).

## Tech stack

TypeScript (strict) · Node.js · NestJS · PostgreSQL + TypeORM (migrations) · Redis + BullMQ ·
JWT (@nestjs/jwt) · class-validator · Swagger/OpenAPI · Jest + Supertest · Docker Compose

## Getting started

Requires Node.js 20+ and Docker (Postgres 16; the schema needs Postgres 13+).

```bash
cp .env.example .env          # then fill in local values
docker compose up -d          # postgres + redis
npm install
npm run migration:run
npm run seed                  # fake users for each role
npm run start:dev             # API on :3000, Swagger UI at /docs
```

`/docs` is on by default and off when `NODE_ENV=production`; `SWAGGER_ENABLED=true|false`
overrides that.

`npm run seed` inserts one fake user per role (`admin@example.com`, `reviewer@example.com`,
`sales@example.com`). Their passwords come from `SEED_ADMIN_PASSWORD`, `SEED_REVIEWER_PASSWORD`
and `SEED_SALES_PASSWORD` in `.env`. It is idempotent: an existing user is skipped and keeps its
password.

`JWT_SECRET` (at least 32 characters, at least 8 distinct characters, not containing
`change-me`) is required. Replace the `JWT_SECRET=change-me`
placeholder from `.env.example`, for example with the output of `openssl rand -base64 48`: the
app refuses to start with the placeholder, and so does `npm run test:e2e` (a secret that is set
must still be valid). Only when `JWT_SECRET` is not set at all does the e2e run generate a random
one at runtime.

### Auth

`POST /auth/login` with `{ "email", "password" }` returns `{ accessToken, expiresIn }`: an HS256
JWT that expires after 1 hour (`expiresIn: 3600`). Every other route needs
`Authorization: Bearer <accessToken>`; a missing, expired or tampered token gets 401. A wrong
email or password gets the same `401 Invalid credentials`. Routes opt out of the token check with
`@Public()` and limit roles with `@Roles(...)` (the wrong role gets 403). Request bodies are
validated, and unknown fields are rejected with 400.

### Logging

Log with `logInfo(context, message, meta)` and `logError(context, message, meta)` from
`src/logging/logger.ts` instead of `console.*`. Each call prints one JSON line (`logError` to
stderr). Sensitive keys in `meta` are redacted or masked first; put values in `meta`, never in
the message. When `NODE_ENV=production`, nothing is printed.

### Migrations

The schema changes only through migrations in `src/database/migrations/` (`synchronize` is off).

```bash
npm run migration:run         # apply pending migrations
npm run migration:revert      # undo the last migration
npm run migration:generate -- src/database/migrations/<Name>   # diff entities against the DB
```

Each script builds first and uses the compiled `dist/database/data-source.js`. Add every new
migration class to `src/database/migrations/index.ts`, otherwise it never runs.

## Testing

```bash
npm run test                  # unit tests
npm run typecheck             # type-checks src/ and test/
npm run test:e2e              # integration tests against real Postgres (needs docker services)
```

`npm run test:e2e` uses a separate database named by `DB_NAME_TEST`. It **drops and recreates**
that database on every run, then applies all migrations. The name must end in `_test` and differ
from `DB_NAME`. The seed tests also need the `SEED_*` variables.

To try the API by hand, see [docs/manual-testing.md](docs/manual-testing.md): a Postman
collection that logs in every role and walks through the whole flow, plus the common surprises.

## AI-assisted workflow

Run `/ship <task>` in Claude Code to take one task from plan to draft PR:

1. **planner** writes a plan to `docs/plans/<slug>.md`, citing the ADRs, and splits it into
   work packages that touch separate files.
2. **plan-reviewer** checks the plan against `docs/adrs/` and `.claude/rules/`
   (APPROVED / CHANGES_REQUESTED / NEEDS_HUMAN; up to 3 revision rounds).
3. **implementer** subagents write the code and tests, one per package; packages with no
   dependency between them run in parallel.
4. `/verify` runs on the combined change, with **security-reviewer** alongside it for auth,
   query, logging or seed changes.
5. The change is committed on a new branch `ai/<slug>-<timestamp>` (every run gets its own, cut from `origin/main`), pushed, and opened as a **draft** PR.

The pipeline stops and asks a person when the tree is dirty, the plan conflicts with an ADR, the
review doesn't converge, or the quality gate keeps failing. It never merges or pushes to `main`.
Requires an authenticated `gh` CLI.

`/ship --stack <base-branch> <task>` cuts the branch from `<base-branch>` instead of `main` and
opens the PR against it, so PRs can be stacked.

### Working through the backlog

[docs/backlog.md](docs/backlog.md) lists the remaining work in order. `/ship-next` ships the first
unchecked item as a draft PR stacked on the previous one and records the branch and PR in the
backlog. `/loop /ship-next` repeats that until the backlog is done or an item needs a person;
questions, defaults it chose and manual steps collect under "Waiting on you". Review and merge
the stack from the bottom up; GitHub retargets the next PR when its base merges.

## Design & decisions

Design decisions live in [docs/adrs/](docs/adrs/):

- [workflow.md](docs/adrs/workflow.md): roles, status model, lifecycle and transitions
- [database.md](docs/adrs/database.md): tables and the `meta` column convention
- [kyb-check.md](docs/adrs/kyb-check.md): async KYB check and idempotency
- [auth.md](docs/adrs/auth.md): JWT login and the authorization matrix
- [sensitive-data.md](docs/adrs/sensitive-data.md): redaction, masking and encryption candidates
- [testing.md](docs/adrs/testing.md): test plan, including the denied cases

## Before production

Work that must be done before the project runs in production is tracked in
[docs/production-readiness.md](docs/production-readiness.md).
