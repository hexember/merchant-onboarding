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

The project is backend only; Swagger serves as the UI.

## Tech stack

TypeScript (strict) · Node.js · NestJS · PostgreSQL + TypeORM (migrations) · Redis + BullMQ ·
JWT (passport-jwt) · class-validator · Swagger/OpenAPI · Jest + Supertest · Docker Compose

## Getting started

Requires Node.js 20+ and Docker.

> `npm run migration:run` and `npm run seed` are placeholders that only print a message until the
> database and auth tasks add migrations and seed data.

```bash
cp .env.example .env          # then fill in local values
docker compose up -d          # postgres + redis
npm install
npm run migration:run
npm run seed                  # fake users for each role
npm run start:dev             # API on :3000
```

## Testing

```bash
npm run test                  # unit tests
npm run test:e2e              # integration tests (needs docker services)
```

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

## Design & decisions

Design decisions live in [docs/adrs/](docs/adrs/):

- [workflow.md](docs/adrs/workflow.md): roles, status model, lifecycle and transitions
- [database.md](docs/adrs/database.md): tables and the `meta` column convention
- [kyb-check.md](docs/adrs/kyb-check.md): async KYB check and idempotency
- [auth.md](docs/adrs/auth.md): JWT login and the authorization matrix
- [sensitive-data.md](docs/adrs/sensitive-data.md): redaction, masking and encryption candidates
- [testing.md](docs/adrs/testing.md): test plan, including the denied cases
