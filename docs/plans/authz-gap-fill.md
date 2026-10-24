# Authorization gap fill: full matrix coverage

## Goal
Every cell of the authorization matrix in docs/adrs/auth.md (each endpoint × ADMIN, REVIEWER,
SALES, plus unauthenticated / tampered token) and every explicit bypass case in
docs/adrs/testing.md is proved by an integration test that asserts the exact status. The audit
below found **no enforcement gaps**: every rule is enforced in `src/`. It found only test gaps, all
closed by one new table-driven spec, `test/authz-matrix.e2e-spec.ts`. No production code changes.

## Scope
- In: one new e2e spec `test/authz-matrix.e2e-spec.ts` that walks the whole matrix
  table-driven, an unknown/malformed-id table per id route, and the missing PATCH
  mass-assignment cases: `kybScore` and `version` (from .claude/rules/api.md) and `meta` (from
  .claude/rules/database.md, "never accepted from DTOs").
- Out: any change under `src/`, the existing specs (they stay as they are; some overlap is
  intended), `package.json`, ADRs, `.env.example`, a global exception filter, the KYB worker,
  Swagger.

## Audit results

Done by following `.claude/skills/authz-audit/SKILL.md`. Shorthand used in the table:

- `ctl` = `src/applications/applications.controller.ts`, `svc` = `src/applications/applications.service.ts`,
  `repo` = `src/applications/applications.repository.ts`
- `JWT` = `src/auth/guards/jwt-auth.guard.ts:43-77`, global through `src/auth/auth.module.ts:31`
- `RG` = `src/auth/guards/roles.guard.ts:23-38`, global through `src/auth/auth.module.ts:32`
- `scope` = `repo:89-98` (`findAccessible`, which returns null for a non-UUID at :94) plus `repo:313-331` (`applyScope`; SALES → `sales_owner_id`, REVIEWER → `assigned_reviewer_id`, ADMIN → all, unknown role → `1 = 0`)
- `apps` = `test/applications.e2e-spec.ts`, `dec` = `test/reviewer-decision.e2e-spec.ts`,
  `ale` = `test/audit-log-endpoint.e2e-spec.ts`, `auth` = `test/auth.e2e-spec.ts`

| Endpoint | Role | Expected | Enforced at | Tested at | GAP? |
|---|---|---|---|---|---|
| POST /auth/login | ADMIN | 200 (public) | `src/auth/auth.controller.ts:21` `@Public()` | auth:419 "allows an ADMIN token from login" | — |
| POST /auth/login | REVIEWER | 200 (public) | same | only implicit, in other specs' `beforeAll` `.expect(200)` | **GAP (test)**: no named test |
| POST /auth/login | SALES | 200 (public) | same | auth:189 "returns an HS256 token for the SALES user…" | — |
| POST /auth/login | unauth, bad creds | 401 `Invalid credentials` | `src/auth/auth.service.ts` | auth:223, auth:243 | — |
| POST /applications | ADMIN | 201 (`salesOwnerId` required, else 400) | ctl:55; svc:528-539 | apps:576 "ADMIN creates for SALES B…"; apps:629 "denied: ADMIN with %s gets 400…" | — |
| POST /applications | REVIEWER | 403 | ctl:55 (RG); svc:540-541 | apps:607 "denied: REVIEWER gets 403" | — |
| POST /applications | SALES | 201 owner = self; `salesOwnerId` → 403 | ctl:55; svc:523-527 | apps:542; apps:595 "denied: SALES sending salesOwnerId as %s gets 403…" | — |
| POST /applications | unauth / tampered | 401 | JWT | apps:667, apps:675 | — |
| GET /applications | ADMIN | 200, all | ctl:68; svc:180; scope | apps:719 | — |
| GET /applications | REVIEWER | 200, assigned only | ctl:68; scope (REVIEWER) | apps:706 | — |
| GET /applications | SALES | 200, own only | ctl:68; scope (SALES) | apps:692 | — |
| GET /applications | unauth | 401 | JWT | apps:749 | — |
| GET /applications | tampered | 401 | JWT:58-63 | none on this route | **GAP (test)** |
| GET /applications/:id | ADMIN | 200; unknown → 404 | ctl:80; svc:194-197; scope | apps:784 (200) | **GAP (test)**: ADMIN unknown/malformed id → 404 |
| GET /applications/:id | REVIEWER | 200 if assigned, else 404 | ctl:80; scope | apps:771 | **GAP (test)**: REVIEWER unknown/malformed id → 404 |
| GET /applications/:id | SALES | 200 if owner, else 404 (same as unknown) | ctl:80; scope | apps:758, apps:784 | — |
| GET /applications/:id | unauth | 401 | JWT | apps:795 | — |
| GET /applications/:id | tampered | 401 | JWT | none | **GAP (test)** |
| PATCH /applications/:id | ADMIN | 200; unknown → 404 | ctl:108; svc:213-216 | apps:925 (200) | **GAP (test)**: ADMIN unknown/malformed id → 404 |
| PATCH /applications/:id | REVIEWER | 403 | ctl:108 (RG) | apps:957 "denied: REVIEWER, even the assigned one, gets 403" | — |
| PATCH /applications/:id | SALES | 200 if owner, else 404 | ctl:108; svc:213; repo:136-155 (scope repeated in UPDATE) | apps:858, apps:941 | partial: malformed id not tested |
| PATCH /applications/:id | unauth | 401 | JWT | **none** | **GAP (test)**: no "no token → 401" for PATCH (testing.md bypass list) |
| PATCH /applications/:id | tampered | 401 | JWT | none | **GAP (test)** |
| POST /:id/submit | ADMIN | 200; unknown → 404 | ctl:127; svc:255-263 | apps:1076, apps:1120 | **GAP (test)**: ADMIN unknown id → 404 |
| POST /:id/submit | REVIEWER | 403 (also on unknown id) | ctl:127 (RG); svc:255-257 | apps:1150 | — |
| POST /:id/submit | SALES | 200 if owner, else 404 | ctl:127; svc:260; repo:165-195 | apps:1020, apps:1132 | — |
| POST /:id/submit | unauth / tampered | 401 | JWT | apps:1267, apps:1277 | — |
| POST /:id/assign | ADMIN | 200; unknown → 404; non-REVIEWER target → 400 | ctl:142; svc:319-331 | apps:1300, apps:1494, apps:1448 | — |
| POST /:id/assign | REVIEWER | 403 | ctl:142 (RG); svc:319-321 | apps:1414 | — |
| POST /:id/assign | SALES | 403 | ctl:142 (RG); svc:319-321 | apps:1414 | — |
| POST /:id/assign | unauth | 401 | JWT | apps:1429 | — |
| POST /:id/assign | tampered | 401 | JWT | none | **GAP (test)** |
| POST /:id/transfer-owner | ADMIN | 200; unknown → 404; non-SALES target → 400 | ctl:162; svc:374-386 | apps:1560, apps:1721, apps:1680 | — |
| POST /:id/transfer-owner | REVIEWER | 403 | ctl:162 (RG); svc:374-376 | apps:1646 | — |
| POST /:id/transfer-owner | SALES | 403 | ctl:162 (RG); svc:374-376 | apps:1646 | — |
| POST /:id/transfer-owner | unauth | 401 | JWT | apps:1663 | — |
| POST /:id/transfer-owner | tampered | 401 | JWT | none | **GAP (test)** |
| POST /:id/decision | ADMIN | 403 | ctl:184 (RG); svc:432-434 | dec:517 "ADMIN, valid body gets 403…" | — |
| POST /:id/decision | REVIEWER | 200 if assigned; non-assigned / unknown / unassigned → 404 | ctl:184; svc:437-440; repo:267-297 (scope repeated) | dec:438, dec:530, dec:548, dec:558 | — |
| POST /:id/decision | SALES | 403 | ctl:184 (RG); svc:432-434 | dec:517 "the SALES owner…" | partial: non-owner SALES not tested (same guard) |
| POST /:id/decision | unauth / tampered | 401 | JWT | dec:573, dec:583 | — |
| GET /:id/audit-logs | ADMIN | 200; unknown → 404 | ctl:93; svc:496-502 | ale:392, ale:658 | — |
| GET /:id/audit-logs | REVIEWER | 403 | ctl:93 (RG); svc:496-498 | ale:620 | — |
| GET /:id/audit-logs | SALES | 403 | ctl:93 (RG); svc:496-498 | ale:620 | — |
| GET /:id/audit-logs | unauth / tampered | 401 | JWT | ale:634, ale:643 | — |

The testing.md bypass list and security.md rules:

| Case | Expected | Enforced at | Tested at | GAP? |
|---|---|---|---|---|
| SALES A GET/PATCH/submit SALES B's app by id | 404 | scope | apps:758, apps:941, apps:1132 | — |
| After transfer A → B: A 404, B has access | 404 / 200 | scope; repo:236-255 | apps:1560 | — |
| SALES cannot transfer | 403 | ctl:162; svc:374 | apps:1646 | — |
| SALES cannot set `salesOwnerId` on create | 403 | svc:523-526 | apps:595 | — |
| ADMIN cannot transfer to a non-SALES user | 400 | svc:378-380 | apps:1680 | — |
| SALES cannot assign / decide | 403 | ctl:142, ctl:184 | apps:1414, dec:517 | — |
| Non-assigned REVIEWER cannot decide | 404 | svc:437; scope | dec:530 | — |
| ADMIN cannot decide | 403 | ctl:184; svc:432 | dec:517 | — |
| Mass assignment on create (`createdById`, `status`, `kybStatus`, `kybLevel`, `kybScore`, `assignedReviewerId`, `version`, `meta`) | 400 | `src/app.module.ts:43` ValidationPipe `whitelist` + `forbidNonWhitelisted`; `create-application.dto.ts` | apps:647 | — |
| Mass assignment on PATCH (`salesOwnerId` from SALES and ADMIN, `createdById`, `status`, `kybStatus`, `kybLevel`, `assignedReviewerId`) | 400 | same; `update-application.dto.ts` | apps:992 | — |
| Mass assignment on PATCH of `kybScore`, `version` (.claude/rules/api.md) and `meta` (.claude/rules/database.md); none of them in testing.md | 400 | same | none | **GAP (test)** |
| Unknown application id → 404, same body as out of scope | 404 | scope | apps:758 (GET, SALES), apps:941 (PATCH, SALES), apps:1132, apps:1494, apps:1721, dec:530, ale:658 | partial: see the ADMIN/REVIEWER rows above |
| No token / tampered token → 401 | 401 | JWT | see per-route rows; auth:314-369 (probe routes: Basic scheme, wrong secret, expired, alg none, deleted user) | gaps: PATCH (no token), GET list / GET :id / PATCH / assign / transfer (tampered) |
| Role comes from DB, not from token (demoted user → 403) | 403 | JWT:71-75 | auth:401 | — |
| No unscoped `findOne({ id })` reachable from a request | — | `src/users/users.repository.ts:29` `findOne` by **email** is for login only; `KybWorkerApplicationsRepository` is worker-only (boundary enforced by `src/kyb/kyb-worker-boundary.spec.ts:69`); every application read/write in svc goes through `findAccessible`/`findAccessiblePage` | `src/kyb/kyb-worker-boundary.spec.ts` | — |

**Enforcement verdict: no enforcement gaps.** Every cell is enforced by `@Roles` (RG) and, where
the matrix says "if owner / if assigned", by `applyScope` in both the read and the conditional
UPDATE. The service also repeats the role check for submit, assign, transfer, decide and
audit-logs as defence in depth. Every gap above is a missing test.

## ADR references
- docs/adrs/auth.md §Authorization (matrix, two layers, 404 vs 403): the spec's expectation table
  is the matrix itself. Wrong role → 403, out of scope or unknown → 404 with the same body.
- docs/adrs/auth.md §Auth details: the tampered token (payload re-encoded with role ADMIN, original
  signature) → 401. `@Public()` login works for every role.
- docs/adrs/testing.md: every explicit bypass case is asserted again in one place, and so is the
  rule that tests must not depend on randomness (the KYB worker stays off and no provider runs).
- .claude/rules/testing.md: every authz rule has its denied case. The spec has no sleeps.
- .claude/rules/security.md: fake `@example.com` users, passwords from `SEED_*` through
  `ConfigService`, and the scoped repository is never bypassed. The test-only SQL in `forceState`
  is the only direct SQL, and it does setup only.

## ADR conflicts
None.

## Steps
1. `test/authz-matrix.e2e-spec.ts` (new): a table-driven e2e spec.
   - **Setup (copy the patterns of `test/reviewer-decision.e2e-spec.ts:216-288`):**
     `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(KYB_PROVIDER).useValue(new FakeKybProvider())`.
     Call `app.init()`, get `queue = app.get<Queue>(getQueueToken(KYB_CHECK_QUEUE))` and
     `await queue.waitUntilReady()`. Spy stdout/stderr/console (`mockImplementation`) and set
     `configureLogger({ production: false })`. Read passwords with
     `config.getOrThrow('SEED_SALES_PASSWORD' | 'SEED_REVIEWER_PASSWORD' | 'SEED_ADMIN_PASSWORD')`
     and hash each once with `BCRYPT_COST`. Call `resetTables(dataSource)` and insert users with
     `UsersRepository.insertIfAbsent`: `authz-admin@example.com`, `authz-reviewer@example.com`,
     `authz-reviewer-2@example.com`, `authz-sales@example.com`, `authz-sales-2@example.com`, all
     with made-up names. Log each one in once through `POST /auth/login`. `jest.setTimeout(60_000)`.
     `afterAll`: `queue.obliterate({ force: true })`, `app.close()`,
     `configureLogger({ production: true })`, then restore the spies. `beforeEach`:
     `resetApplicationData(dataSource)`. The KYB worker is already off (`test/setup/test-env.ts:99`).
   - **Actors:** `type Actor = 'ADMIN' | 'REVIEWER' | 'REVIEWER_OTHER' | 'SALES_OWNER' | 'SALES_OTHER' | 'NO_TOKEN' | 'TAMPERED'`.
     `tokenFor(actor)` returns `undefined` for `NO_TOKEN`. For `TAMPERED` it takes SALES_OWNER's
     token, sets `role: 'ADMIN'` in the payload and keeps the original signature (the same
     `base64UrlJson`/`decodeSegment` helpers as the existing specs).
   - **Fixture:** `fixture(status)` creates a DRAFT as SALES_OWNER through `POST /applications`
     (expect 201). It then uses test-only `forceState` (fixed column names, values as parameters,
     as in `test/reviewer-decision.e2e-spec.ts:360-370`) to set `status`,
     `assigned_reviewer_id = REVIEWER` and `kyb_status = 'COMPLETED'`. It returns the id.
   - **Route table** (`interface RouteCase { name; status; call(token, id): Promise<Response>; expected: Record<Actor, number> }`).
     Each route gets a fixture status in which the allowed cell succeeds:
     | Route | Fixture status | Body | ADMIN | REVIEWER | REVIEWER_OTHER | SALES_OWNER | SALES_OTHER | NO_TOKEN | TAMPERED |
     |---|---|---|---|---|---|---|---|---|---|
     | GET /applications/:id | UNDER_REVIEW | — | 200 | 200 | 404 | 200 | 404 | 401 | 401 |
     | PATCH /applications/:id | INFO_REQUESTED | `{ businessName: 'Example Changed' }` | 200 | 403 | 403 | 200 | 404 | 401 | 401 |
     | POST /:id/submit | INFO_REQUESTED | — | 200 | 403 | 403 | 200 | 404 | 401 | 401 |
     | POST /:id/assign | UNDER_REVIEW | `{ reviewerId: <REVIEWER_OTHER id> }` | 200 | 403 | 403 | 403 | 403 | 401 | 401 |
     | POST /:id/transfer-owner | UNDER_REVIEW | `{ salesOwnerId: <SALES_OTHER id> }` | 200 | 403 | 403 | 403 | 403 | 401 | 401 |
     | POST /:id/decision | UNDER_REVIEW | `{ decision: 'REJECT' }` | 403 | 200 | 404 | 403 | 403 | 401 | 401 |
     | GET /:id/audit-logs | UNDER_REVIEW | — | 200 | 403 | 403 | 403 | 403 | 401 | 401 |
     The table is flattened into `it.each` cases named `'%s as %s → %d'`. Each case creates its
     own fixture, snapshots the row (`status, version, sales_owner_id, assigned_reviewer_id,
     decision_note, business_name, kyb_status, submission_count`) and all audit rows, makes the call and asserts `res.status` exactly. For
     denied cells it also asserts the exact body (`{ statusCode: 401, message: 'Unauthorized' }`,
     `{ statusCode: 403, message: 'Forbidden' }`, or `{ statusCode: 404, error: 'Not Found',
     message: APPLICATION_NOT_FOUND_MESSAGE }`), an unchanged row and unchanged audit rows.
   - **Collection routes** (separate `it.each`, since there is no id):
     - `POST /applications`. Body per actor: ADMIN gets `PAYLOAD + { salesOwnerId: SALES_OWNER id }` → 201.
       SALES_OWNER gets `PAYLOAD` → 201. REVIEWER gets `PAYLOAD` → 403. NO_TOKEN and TAMPERED
       (TAMPERED with `salesOwnerId: SALES_OTHER id`) → 401. For each denied cell, assert that
       `merchant_applications` and `audit_logs` gain no new row.
     - `GET /applications` against one UNDER_REVIEW fixture. Expect 200 for ADMIN, REVIEWER,
       REVIEWER_OTHER, SALES_OWNER and SALES_OTHER, and assert the fixture id is in `items` exactly
       for ADMIN, REVIEWER and SALES_OWNER (`total` 1 vs 0). NO_TOKEN and TAMPERED → 401.
     - `POST /auth/login`: ADMIN, REVIEWER and SALES each log in with their SEED password → 200 with
       `accessToken`. A wrong password → 401. A valid login sent with the TAMPERED token in
       `Authorization` → 200 (a `@Public()` route skips the JWT check). Login requests go
       through a separate `login()` helper that never calls `track()`, so no `accessToken` ever
       reaches `responseTexts`. This also covers the logins in `beforeAll`.
   - **Response tracking:** every application request helper (`call`, the create and list helpers)
     goes through `track(res)`, which pushes `JSON.stringify(res.body)` onto `responseTexts`, as in
     `apps:383-386`. `beforeEach` clears `responseTexts` and the stdout/stderr/console spies, as in
     `dec:279-288`, so captures never carry over from one test to the next.
   - **Unknown / malformed id table:** for each id route above, ids `FAKE_UUID`
     (`'00000000-0000-4000-8000-000000000009'`) and `'not-a-uuid'`, and actors ADMIN, REVIEWER,
     SALES_OWNER, NO_TOKEN. Expected: NO_TOKEN → 401. A role the route's `@Roles` denies → 403
     (the role check runs before the lookup). Otherwise 404 with the shared `NOT_FOUND_BODY`.
     The table reuses each `RouteCase`'s own `call(token, id)` with the same body as the matrix
     table, so the body is never what decides the status:
     - PATCH keeps its non-empty `{ businessName: 'Example Changed' }`. An empty body would get
       400 "No fields to update" from svc:206-210 before the lookup, and that would hide the 404.
     - decision keeps a valid `{ decision: 'REJECT' }`, so validation passes and the lookup runs.
     - assign and transfer keep valid targets (REVIEWER_OTHER, SALES_OTHER), so the 400 target
       check at svc:323 / svc:378 does not hide the 404.
   - **Extra bypass cases:**
     - `PATCH` mass-assignment as SALES_OWNER on an INFO_REQUESTED fixture: `kybScore: 10`,
       `version: 99`, `meta: { source: 'test' }` → 400, body contains
       `property <key> should not exist`, row unchanged.
     - "only the assigned REVIEWER may decide", stated once as its own named test:
       REVIEWER_OTHER → 404 and REVIEWER → 200 on the same fixture, with exactly one
       `DECISION_RECORDED` audit row whose `actor_id` is REVIEWER.
   - **Leak check:** one self-contained `it`, built like `apps:1937-1983`, named
     `never returns, logs or audits a raw sensitive value or a token`. It must not rely on what
     earlier tests captured, because `beforeEach` has cleared all of that. Inside the one test:
     1. Create a fixture: SALES_OWNER creates the application, then `forceState` sets it to
        INFO_REQUESTED with `assigned_reviewer_id = REVIEWER` and `kyb_status = 'COMPLETED'`.
     2. Send one allowed request per route, all tracked, in an order that keeps each one valid:
        GET /applications as SALES_OWNER; GET :id as ADMIN; PATCH as SALES_OWNER
        (`{ ownerEmail: 'authz-owner2@example.com' }`); submit as SALES_OWNER (→ RISK_REVIEW);
        assign as ADMIN (REVIEWER); transfer-owner as ADMIN (SALES_OTHER); `forceState` to
        UNDER_REVIEW with `kyb_status = 'COMPLETED'` (the worker is off); decision as REVIEWER
        (`REJECT`); audit-logs as ADMIN. Assert each status, so the check cannot pass on silent
        failures.
     3. Send one denied request (GET :id as REVIEWER_OTHER → 404) and one TAMPERED request (GET :id
        → 401), both tracked.
     4. Positive check first: `responseTexts` is non-empty and the audit rows include
        `APPLICATION_SUBMITTED`, `REVIEWER_ASSIGNED`, `OWNERSHIP_TRANSFERRED` and
        `DECISION_RECORDED`.
     5. Assert that none of `capturedText()`, `JSON.stringify(await auditRows())` and the
        `responseTexts` entries contains RAW_TAX_ID, RAW_NATIONAL_ID, RAW_OWNER_EMAIL,
        `'authz-owner2@example.com'`, RAW_OWNER_PHONE, any of the 5 `beforeAll` tokens or the
        TAMPERED token.

     Login bodies are never tracked (see the login bullet above), so issued tokens cannot appear
     in `responseTexts`.

## Tests
- Unit: none. No production code changes.
- Integration: `test/authz-matrix.e2e-spec.ts`:
  - `matrix: <route> as <actor> → <status>`: 7 id routes × 7 actors = 49 cases, every denied cell
    included (403 wrong role, 404 out of scope, 401 no token, 401 tampered).
  - `POST /applications as <actor> → <status>`: 5 cases.
  - `GET /applications as <actor> → 200 / 401, scoped`: 7 cases.
  - `POST /auth/login as <role> → 200`: 3 cases, plus `wrong password → 401` and
    `public route ignores a tampered bearer → 200`.
  - `unknown id <id> on <route> as <actor> → <status>`: 7 routes × 2 ids × 4 actors = 56 cases.
  - `denied: PATCH mass-assignment of kybScore / version / meta → 400`: 3 cases.
  - `only the assigned REVIEWER may decide: other reviewer 404, assigned reviewer 200, one audit row`.
  - `never returns, logs or audits a raw sensitive value or a token`: one self-contained test. It
    makes one allowed call per route, one denied (404) call and one TAMPERED (401) call, then
    checks the logs, the audit rows and the tracked application responses.
  - Run with `npm run test:e2e` (already `--runInBand`) and `/verify`.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1     | test/authz-matrix.e2e-spec.ts | — |

## Security notes
- No authz bypass: the spec checks the scoped lookups through the HTTP API only. It never calls an
  unscoped repository method. `forceState` is test-only setup SQL with fixed column names and
  parameterised values.
- No secrets: passwords come from `SEED_*` via `ConfigService.getOrThrow`. The spec never reads or
  prints `.env`, and no password, hash or token is ever logged. The tampered token is derived at
  runtime and never printed.
- Fake data only: `authz-*@example.com` users, made-up names, a `PAN-FAKE-…` / `NID-FAKE-…`
  payload.
- Error bodies are Nest defaults (there is intentionally no global filter), so the spec asserts
  `{ statusCode, message }` for 401/403 and the `NOT_FOUND_BODY` shape the existing specs use.

## Risks / open questions
- The ADR matrix has no "unauthenticated" column. Default used: 401 on every non-`@Public()` route
  (global `JwtAuthGuard` plus the testing.md "no token or a tampered token → 401" rule).
- The TAMPERED actor uses one variant (SALES token re-encoded as ADMIN), the highest-risk one.
  Other variants (wrong secret, expired, alg none, deleted user, demoted user) are already covered
  in `test/auth.e2e-spec.ts` and are not repeated.
- "Public login ignores a bad bearer header → 200" follows from `JwtAuthGuard` returning early on
  `@Public()` (jwt-auth.guard.ts:48-50) and from the ADR saying login is public. If this behaviour
  is meant to change, that would be an ADR change first.
- PATCH mass-assignment of `kybScore` and `version` comes from .claude/rules/api.md, and of `meta`
  from .claude/rules/database.md ("never accepted from DTOs"). None of the three is in
  testing.md. They are added because they fall under the same whitelist rule; expected 400.
- Where the cases overlap with the existing specs, the duplication is deliberate: the matrix spec is
  the single place that proves the whole table. Nothing is removed from the existing specs.
- Submit cells enqueue a KYB job. The worker is off and `queue.obliterate` runs in `afterAll`,
  as in the other specs. The response does not depend on the enqueue result.
- Runtime: about 125 cases, each with one fixture create and one or two requests, with no bcrypt
  per case (only the 5 logins in `beforeAll`). That fits well within the 60 s per-test timeout.

## Revision notes
- **Revision 1** (plan review round 1, CHANGES_REQUESTED):
  - Blocker: the leak check is now one self-contained `it`, built like `apps:1937-1983`. It
    creates its own fixture and makes one allowed call per route (GET list, GET :id, PATCH,
    submit, assign, transfer-owner, decision, audit-logs), one denied call (404) and one TAMPERED
    call (401). It then checks `capturedText()`, the audit rows and `responseTexts` for the raw
    IDs, the 5 `beforeAll` tokens and the TAMPERED token. The old wording relied on captures from
    earlier tests, which `beforeEach` clears, so it checked nothing.
  - Login responses never go into `responseTexts`: a separate untracked `login()` helper is used,
    also in `beforeAll`. Tracking and the per-test clearing are now spelled out in their own step.
  - The unknown/malformed-id table now reuses each `RouteCase`'s `call` with the same body. PATCH
    keeps a non-empty body, because an empty one gets 400 "No fields to update" (svc:206-210)
    before the lookup and hides the 404. Decision keeps a valid `{ decision }`, and assign and
    transfer keep valid targets.
  - The row snapshot also includes `business_name`, `kyb_status` and `submission_count`.
  - Citation fix: rejecting `meta` is cited to .claude/rules/database.md, not api.md, in Scope,
    the audit table and Risks.
- **Fix round (security review)**, spec and one ADR sentence only, no `src/` change:
  - M1: no request path logs today (only the KYB queue and worker call `logInfo`/`logError`), so
    the leak test is renamed to `never returns or audits a raw sensitive value, a password, a hash
    or a token`. The not-contain checks on the captured log text stay as a guard, with a comment.
    docs/adrs/sensitive-data.md now says `redact()` and the mask helpers run in
    `logInfo`/`logError` and before audit `meta` is written (there is no interceptor or filter).
  - M2: the leak test also sends one successful and one wrong-password login (untracked), checks
    for `LOGIN_FAILED` and its masked email, and adds the three passwords, `$2b$`,
    `passwordHash`, `password_hash` and the SALES email to the secrets list.
  - L1/L3: `auditRows()` and `applicationRow()` use `SELECT *`, so snapshots cover every column
    (including `actor_label`).
  - L2: the secrets list also holds the cores in front of the shown last digits, and the GET
    response is checked for the masked shape (`/^•+9753$/` etc.).
  - L4: the allowed PATCH, assign, transfer-owner and decision cells check the changed column.
