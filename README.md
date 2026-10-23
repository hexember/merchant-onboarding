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

TypeScript · Node.js · NestJS · PostgreSQL + TypeORM (migrations) · Redis + BullMQ ·
JWT (passport-jwt) · class-validator · Swagger/OpenAPI · Jest + Supertest · Docker Compose

## Getting started

> To be completed once the project is scaffolded.

```bash
cp .env.example .env          # then fill in local values
docker compose up -d          # postgres + redis
npm install
npm run migration:run
npm run seed                  # fake users for each role
npm run start:dev             # API on :3000, Swagger at /docs
```

## Testing

```bash
npm run test                  # unit tests
npm run test:e2e              # integration tests (needs docker services)
```

## Design & decisions

Design decisions live in [docs/adrs/](docs/adrs/):

- [workflow.md](docs/adrs/workflow.md): roles, status model, lifecycle and transitions
- [database.md](docs/adrs/database.md): tables and the `meta` column convention
- [kyb-check.md](docs/adrs/kyb-check.md): async KYB check and idempotency
- [auth.md](docs/adrs/auth.md): JWT login and the authorization matrix
- [sensitive-data.md](docs/adrs/sensitive-data.md): redaction, masking and encryption candidates
- [testing.md](docs/adrs/testing.md): test plan, including the denied cases
