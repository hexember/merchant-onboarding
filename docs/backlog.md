# Backlog

Ordered work for the `ship-next` loop. Each unchecked item is one `/ship` task. The loop takes the
first `- [ ]` item, ships it as a draft PR stacked on the previous item's branch, ticks it and
records the branch and PR. Edit this file to reorder, reword or remove items; the loop reads it
fresh every iteration.

Markers: `- [ ]` to do · `- [x]` shipped (PR open or merged) · `- [!]` stopped, see "Waiting on you".

**Stack starts on:** `main` (the logging-module and workflow PRs are merged).

## Items

- [x] **auth-login** — branch `ai/auth-login-20261024-1551`, PR https://github.com/hexember/merchant-onboarding/pull/7 — Auth: `POST /auth/login` returning `{ accessToken, expiresIn }` per
  docs/adrs/auth.md (HS256 JWT with `JWT_SECRET` from env validation, 1h expiry, claims
  `{ sub, role }`, generic 401, bcrypt compare even for unknown emails, `LOGIN_SUCCEEDED` /
  `LOGIN_FAILED` audit rows with the email masked). Add class-validator with a global
  `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`), a global JWT guard with a
  `@Public()` opt-out, a `@Roles()` guard (403 for the wrong role), a current-user decorator, and
  Swagger decorators. Tests: login success and failure, no token and tampered token → 401, wrong
  role → 403, using a test-only protected route.
- [x] **applications-crud** — branch `ai/applications-crud-20261024-1624`, PR https://github.com/hexember/merchant-onboarding/pull/8 — `merchant_applications` table and migration per
  docs/adrs/database.md; `POST /applications`, `GET /applications?status&page&limit`,
  `GET /applications/:id`, `PATCH /applications/:id` per the auth matrix, with every lookup
  through `findAccessible(id, actor)` (out of scope or unknown → 404). Responses mask `taxId`,
  `ownerNationalId`, `ownerEmail`, `ownerPhone`. Mass-assignment fields rejected (400); SALES
  sending `salesOwnerId` → 403. `APPLICATION_CREATED` / `APPLICATION_UPDATED` audit rows in the
  same transaction. Include the SALES-vs-SALES bypass tests from docs/adrs/testing.md.
- [x] **submit-lifecycle** — branch `ai/submit-lifecycle-20261024-1701`, PR https://github.com/hexember/merchant-onboarding/pull/9 — The state machine from docs/adrs/workflow.md §1.2 as a unit-tested
  pure module (every allowed and rejected transition; `KYB_COMPLETE` unreachable from user
  actions); `POST /applications/:id/submit` from `DRAFT` / `INFO_REQUESTED` to `RISK_REVIEW` in one
  transaction (`kybStatus=PENDING`, cleared KYB fields, `submission_count` + 1, audit row);
  optimistic concurrency; anything else → 409 `INVALID_STATE_TRANSITION`. No queue yet.
- [x] **kyb-worker** — branch `ai/kyb-worker-20261024-1719`, PR https://github.com/hexember/merchant-onboarding/pull/10 — `kyb_checks` table, BullMQ + Redis wiring, injectable `KybProvider` with a
  simulated provider and a deterministic fake for tests, enqueue after commit with
  `jobId = kyb-check:{id}:{n}`, the idempotent worker from docs/adrs/kyb-check.md (stale check,
  unique row, conditional update, retries, final failure → `UNDER_REVIEW` + `FAILED`), and the
  `kybCheck` block with the derived `label` on `GET /applications/:id`.
- [x] **assign-transfer** — branch `ai/assign-transfer-20261024-1811`, PR https://github.com/hexember/merchant-onboarding/pull/11 — ADMIN `POST /applications/:id/assign` (target must be a REVIEWER,
  allowed statuses per §1.2) and `POST /applications/:id/transfer-owner` (target must be SALES,
  non-terminal statuses), with audit rows and the bypass tests (SALES cannot assign or transfer,
  ADMIN cannot transfer to a non-SALES user, A loses access after transfer to B).
- [x] **reviewer-decision** — branch `ai/reviewer-decision-20261024-1833`, PR https://github.com/hexember/merchant-onboarding/pull/12 — `POST /applications/:id/decision` (APPROVE / REJECT / REQUEST_INFO)
  for the assigned REVIEWER only, guards from §1.2 (APPROVE needs `kybStatus=COMPLETED`), 409 for
  invalid states and concurrent decisions, `DECISION_RECORDED` audit row, request info → resubmit
  → new KYB check end to end.
- [x] **audit-log-endpoint** — branch `ai/audit-log-endpoint-20261024-1901`, PR https://github.com/hexember/merchant-onboarding/pull/13 — ADMIN-only `GET /applications/:id/audit-logs` with pagination,
  returning `meta` (masked) per docs/adrs/database.md; REVIEWER and SALES → 403.
- [x] **authz-gap-fill** — branch `ai/authz-gap-fill-20261024-1928`, PR https://github.com/hexember/merchant-onboarding/pull/14 — Run the `authz-audit` skill and add any missing enforcement or tests it
  reports, so every row of the authorization matrix and every denied case in docs/adrs/testing.md
  is covered.

## Waiting on you

Questions, decisions taken by default, and manual steps (such as `.env.example` lines) that the
loop could not do itself. Newest first.

- authz-gap-fill (#14): the audit found no enforcement gaps; the new matrix spec makes every
  auth.md row and testing.md denied case covered. Defaults: unauthenticated → 401 on every
  non-public route; a bad bearer on public login still → 200. No request path logs today, so log
  leak checks are guards only (sensitive-data.md now says where `redact()` runs).

- Defaults taken in audit-log-endpoint (#13): history oldest first; items omit entityType/entityId;
  actor ids returned to ADMIN; masking now matches key names by substring (so e.g. a boolean
  `emailVerified` in meta is masked); bare `auth`/`otp`/`pin` keys deliberately not redacted.
- Follow-up (small): audit rows written in one transaction share `created_at` (KYB final failure
  writes two); a migration switching the default to `clock_timestamp()` would make their order causal.

- Defaults taken in reviewer-decision (#12): note optional for all decisions, trimmed, max 2000,
  no NUL, rejected if it contains the application's own raw tax/national ID; note returned
  unmasked to viewers, never in audit or logs; REQUEST_INFO keeps the reviewer; note and
  `decided_at` survive resubmit until the next decision.
- Follow-up (small): other free-text DTO fields (business name, etc.) probably accept NUL bytes
  and would give a 500 instead of 400; the decision note is fixed in #12.

- Defaults taken in assign-transfer (#11): assigning the same reviewer / transferring to the
  current owner → 200 with a version bump and an audit row `from === to`; target check (400)
  before the application lookup (404), ADMIN-only so nothing leaks; one 400 message for wrong
  role, unknown and malformed target ids; responses use the base masked shape (no `kybCheck`).

- `.env` / `.env.example` (kyb-worker, #10): `REDIS_HOST` is now required (app, `migration:*`,
  `seed`, `test:e2e`) — add `REDIS_HOST=localhost` and `REDIS_PORT=6379` to `.env` if missing, and
  run Redis (`docker compose up -d redis`) for e2e. Add to `.env.example`: `QUEUE_PREFIX=bull`,
  `KYB_WORKER_ENABLED=true`, `KYB_FAILURE_RATE=0.2`, `KYB_SCORE_MEDIUM_MIN=40`,
  `KYB_SCORE_HIGH_MIN=70` (comments in the PR body).
- Defaults taken in kyb-worker (#10): worker writes bump `version`; final failure writes both
  ATTEMPT_FAILED (`final: true`) and KYB_CHECK_FAILED; job retention 7 days (completed) / 30 days
  (failed); invented simulated scoring; thresholds 40/70; failure rate 0.2.
- Production readiness (candidate): Redis auth/TLS (`REDIS_PASSWORD`) and an outbox or sweeper for
  applications left in `RISK_REVIEW` (Redis down at enqueue, stalled jobs). Both are documented
  trade-offs, not built.

- **Decision taken in reviewer-decision (#12):** APPROVE keeps the `kybStatus = COMPLETED` guard
  (409 `KYB_NOT_COMPLETED`); the contradicting sentence in docs/adrs/workflow.md §1.2 is replaced
  in that PR. Say so if you'd rather allow approving after a failed KYB check.
- Defaults taken in submit-lifecycle (#9): submit also clears `kyb_last_attempt_at`;
  `submitted_at` holds the latest submit; decision note/date untouched on resubmit; submit returns
  200 and ignores the body.
- Follow-up (small): every e2e run prints the pg warning "client.query() when the client is
  already executing a query is deprecated" (predates #9).

- Defaults taken in applications-crud (#8): every NOT NULL column required on create; KYB fields,
  `version` and `meta` left out of responses; list `{ items, page, limit, total }` (limit 20, max
  100, page max 10 000); empty PATCH → 400; `ownerFullName` returned unmasked (not in the ADR's
  mask list); taxId / ownerNationalId at least 8 chars; lost PATCH race → 409
  `CONCURRENT_MODIFICATION`; SALES sending `salesOwnerId` with any value → 403.
- Follow-up (small): the old real-format phone fixture `+977-9800000123` is still in
  `src/common/mask.ts`, `src/common/mask.spec.ts` and `docs/plans/database-foundation.md`.

- **Decision (auth-login, #7):** `main` has no global exception filter any more, so error bodies
  are Nest's defaults (no `code`, 5xx not made generic). That no longer matches
  `.claude/rules/api.md` (`{ statusCode, error, message, code }`). Either update the rule, or add a
  backlog item to restore a small error filter. The loop assumes Nest defaults until told otherwise.
- `.env.example` (auth-login, #7): add `JWT_SECRET=change-me` with the comment from the PR, and put a
  real value (32+ chars, 8+ distinct, e.g. `openssl rand -base64 48`) in `.env`. The app, seed,
  migrations and `test:e2e` refuse to start without one.
- `docs/adrs/sensitive-data.md` line 6 still mentions "the exception filter" (predates auth-login).
- Defaults taken in auth-login (#7): login returns 200; passwords capped at 128 chars; a 400
  validation error writes no audit row; the guard re-reads the user on each request.
- `.env.example`: the `LOG_LEVEL` line from the logging-module PR is no longer needed (`LOG_LEVEL`
  was removed on `main`).
