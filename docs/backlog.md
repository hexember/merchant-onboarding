# Backlog

Ordered work for the `ship-next` loop. Each unchecked item is one `/ship` task. The loop takes the
first `- [ ]` item, ships it as a draft PR stacked on the previous item's branch, ticks it and
records the branch and PR. Edit this file to reorder, reword or remove items; the loop reads it
fresh every iteration.

Markers: `- [ ]` to do · `- [x]` shipped (PR open or merged) · `- [!]` stopped, see "Waiting on you".

**Stack starts on:** `ai/ship-next-loop-20261024-1541` (the PR that adds this file, which sits on
the logging-module PR).

## Items

- [ ] **auth-login** — Auth: `POST /auth/login` returning `{ accessToken, expiresIn }` per
  docs/adrs/auth.md (HS256 JWT with `JWT_SECRET` from env validation, 1h expiry, claims
  `{ sub, role }`, generic 401, bcrypt compare even for unknown emails, `LOGIN_SUCCEEDED` /
  `LOGIN_FAILED` audit rows with the email masked). Add class-validator with a global
  `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`), a global JWT guard with a
  `@Public()` opt-out, a `@Roles()` guard (403 for the wrong role), a current-user decorator, and
  Swagger decorators. Tests: login success and failure, no token and tampered token → 401, wrong
  role → 403, using a test-only protected route.
- [ ] **applications-crud** — `merchant_applications` table and migration per
  docs/adrs/database.md; `POST /applications`, `GET /applications?status&page&limit`,
  `GET /applications/:id`, `PATCH /applications/:id` per the auth matrix, with every lookup
  through `findAccessible(id, actor)` (out of scope or unknown → 404). Responses mask `taxId`,
  `ownerNationalId`, `ownerEmail`, `ownerPhone`. Mass-assignment fields rejected (400); SALES
  sending `salesOwnerId` → 403. `APPLICATION_CREATED` / `APPLICATION_UPDATED` audit rows in the
  same transaction. Include the SALES-vs-SALES bypass tests from docs/adrs/testing.md.
- [ ] **submit-lifecycle** — The state machine from docs/adrs/workflow.md §1.2 as a unit-tested
  pure module (every allowed and rejected transition; `KYB_COMPLETE` unreachable from user
  actions); `POST /applications/:id/submit` from `DRAFT` / `INFO_REQUESTED` to `RISK_REVIEW` in one
  transaction (`kybStatus=PENDING`, cleared KYB fields, `submission_count` + 1, audit row);
  optimistic concurrency; anything else → 409 `INVALID_STATE_TRANSITION`. No queue yet.
- [ ] **kyb-worker** — `kyb_checks` table, BullMQ + Redis wiring, injectable `KybProvider` with a
  simulated provider and a deterministic fake for tests, enqueue after commit with
  `jobId = kyb-check:{id}:{n}`, the idempotent worker from docs/adrs/kyb-check.md (stale check,
  unique row, conditional update, retries, final failure → `UNDER_REVIEW` + `FAILED`), and the
  `kybCheck` block with the derived `label` on `GET /applications/:id`.
- [ ] **assign-transfer** — ADMIN `POST /applications/:id/assign` (target must be a REVIEWER,
  allowed statuses per §1.2) and `POST /applications/:id/transfer-owner` (target must be SALES,
  non-terminal statuses), with audit rows and the bypass tests (SALES cannot assign or transfer,
  ADMIN cannot transfer to a non-SALES user, A loses access after transfer to B).
- [ ] **reviewer-decision** — `POST /applications/:id/decision` (APPROVE / REJECT / REQUEST_INFO)
  for the assigned REVIEWER only, guards from §1.2 (APPROVE needs `kybStatus=COMPLETED`), 409 for
  invalid states and concurrent decisions, `DECISION_RECORDED` audit row, request info → resubmit
  → new KYB check end to end.
- [ ] **audit-log-endpoint** — ADMIN-only `GET /applications/:id/audit-logs` with pagination,
  returning `meta` (masked) per docs/adrs/database.md; REVIEWER and SALES → 403.
- [ ] **authz-gap-fill** — Run the `authz-audit` skill and add any missing enforcement or tests it
  reports, so every row of the authorization matrix and every denied case in docs/adrs/testing.md
  is covered.

## Waiting on you

Questions, decisions taken by default, and manual steps (such as `.env.example` lines) that the
loop could not do itself. Newest first.

- `.env.example`: add `# LOG_LEVEL=log` with its comment (from the logging-module PR).
