# Reviewer decision endpoint

## Goal
`POST /applications/:id/decision` lets the **assigned** REVIEWER record `APPROVE`, `REJECT` or
`REQUEST_INFO` on an `UNDER_REVIEW` application. APPROVE also needs `kybStatus = COMPLETED`.
ADMIN and SALES get 403 before any DB work. A non-assigned REVIEWER, an unknown id or a malformed
id all get the same 404. A wrong status gets 409 `INVALID_STATE_TRANSITION`, APPROVE without a
completed KYB check gets 409 `KYB_NOT_COMPLETED`, and a lost race gets 409
`CONCURRENT_MODIFICATION`. The write is one conditional UPDATE, and the `DECISION_RECORDED` audit
row goes in the same transaction. The response is the masked application. The loop "request info
→ SALES edits → resubmit → new KYB check → UNDER_REVIEW → approve" is proven end to end. The
contradicting sentence in docs/adrs/workflow.md §1.2 is fixed in the same change.

## Scope
- In: the decision DTO; a `DecisionAction` subset type in the state machine; the repository
  method `decideIfAllowed`; `ApplicationsService.decide`; the controller route; unit tests; a new
  e2e spec; the docs/adrs/workflow.md edit.
- Out: migrations (`decision_note` and `decided_at` already exist); new audit actions
  (`DECISION_RECORDED` already exists); a global exception filter (none exists, so we keep the
  hand-built 409 bodies from `conflict()`); ADMIN decisions; a "retry KYB" endpoint; a decision
  history table; `.env.example` (no package touches it, and no new env variable is needed);
  `test/applications.e2e-spec.ts` (left unchanged; the decision tests go in their own spec).

## ADR references
- docs/adrs/workflow.md §1.1 / §1.2: the transitions come only from `TRANSITIONS`. `nextStatus(app.status, action)`
  returning `null` (anything other than `UNDER_REVIEW`, e.g. `RISK_REVIEW`, `DRAFT`, `APPROVED`)
  → 409 `INVALID_STATE_TRANSITION`. The APPROVE guard `kybStatus = COMPLETED` is enforced in the
  service and again in the UPDATE's WHERE. "ADMIN cannot record decisions" → 403.
  "Decisions are allowed only in UNDER_REVIEW" comes from the table itself. `KYB_COMPLETE` stays
  unreachable: the DTO enum has only the three decision values, the mapping is typed
  `DecisionAction`, and `nextStatus` only searches USER rows.
- docs/adrs/workflow.md §1.3: REJECT and REQUEST_INFO are allowed for any `kybStatus`, including
  `FAILED`. The existing resubmit (SUBMIT from `INFO_REQUESTED`) already resets the KYB fields
  and enqueues a new job after commit. This change does not touch it.
- docs/adrs/auth.md matrix row `POST /applications/:id/decision`: ADMIN 403, REVIEWER "if
  assigned", SALES 403. These come from `@Roles(UserRole.REVIEWER)` plus a service check
  (`isRoleAllowed`). "If assigned" comes from `findAccessible` (REVIEWER scope =
  `assigned_reviewer_id = actor.id`), so out of scope → 404. Concurrency paragraph: version + status
  conditional UPDATE, and the loser gets 409.
- docs/adrs/database.md `merchant_applications` / `audit_logs`: we write `status`,
  `decision_note`, `decided_at`, `version`, `updated_at`. The audit row is in the same
  transaction, and its `meta` is `{ decision, from, to }` with no note (free text may hold PII;
  meta must never hold PII).
- docs/adrs/sensitive-data.md: the response is built by `toApplicationResponse` (masked
  allow-list). Nothing is logged.
- docs/adrs/testing.md: "SALES cannot ... decide (403)", "a non-assigned REVIEWER cannot decide
  (404)", "ADMIN cannot decide (403)", "deciding while in RISK_REVIEW" and "approving with
  kybStatus=FAILED" → 409, "request info → resubmit → back to RISK_REVIEW with a new KYB check",
  and the lifecycle happy path ending in APPROVED. The fake `KybProvider` keeps it deterministic.

## ADR conflicts
- docs/adrs/workflow.md §1.2, the paragraph after the transition table. "APPROVE can still be
  possible even if `kybStatus != COMPLETED`, so nothing is blocked in real world." This
  contradicts the table's APPROVE guard `kybStatus = COMPLETED` and testing.md's "approving with
  `kybStatus=FAILED` → 409". **Decision (orchestrator default): keep the guard.** Proposed edit
  (step 6), replacing the sentences from "APPROVE can still be possible…" through "…is needed."
  with:
  > APPROVE requires `kybStatus = COMPLETED`; approving with any other `kybStatus` (e.g.
  > `FAILED`) returns **409** with code `KYB_NOT_COMPLETED`. This is the one exception to
  > "anything not in the table returns `INVALID_STATE_TRANSITION`": the row is in the table, but
  > its guard failed. The reviewer can still REJECT or
  > REQUEST_INFO; after a request info, the resubmit starts a new KYB check. So nothing is
  > blocked, and no extra "retry KYB check" endpoint is needed.

  The same edit also adds a short "Decision details" note under §1.2 recording the defaults below.
  These are the note rules, what REQUEST_INFO keeps, and the `KYB_NOT_COMPLETED` code.

## Steps
1. `src/applications/application-state-machine.ts`: add
   `export type DecisionAction = TransitionAction.APPROVE | TransitionAction.REJECT | TransitionAction.REQUEST_INFO;`
   and `export const DECISION_ACTIONS: readonly DecisionAction[]`. Also add
   `export function requiresCompletedKyb(action: DecisionAction): boolean` (true only for APPROVE),
   so the guard is data/pure logic rather than only description text. Update the header comment:
   the APPROVE guard is enforced by `ApplicationsService.decide` and
   `ApplicationsRepository.decideIfAllowed`. Do not change the `TRANSITIONS` rows.
   `src/applications/application-state-machine.spec.ts`: add cases. `DECISION_ACTIONS` equals
   exactly APPROVE/REJECT/REQUEST_INFO and contains neither SUBMIT nor KYB_COMPLETE. Each decision
   action leads from UNDER_REVIEW to APPROVED/REJECTED/INFO_REQUESTED, and from every other status
   to `null`. `isRoleAllowed(action, role)` is true only for REVIEWER (false for ADMIN, SALES).
   `requiresCompletedKyb` is true for APPROVE only.
2. `src/applications/dto/record-decision.dto.ts` (new): `export enum DecisionType { APPROVE, REJECT, REQUEST_INFO }`
   (string values equal to the action names). Add
   `export const DECISION_TO_ACTION: Readonly<Record<DecisionType, DecisionAction>>`. It is an
   explicit map, typed so it cannot hold SUBMIT or KYB_COMPLETE. Add
   `export const DECISION_NOTE_MAX_LENGTH = 2000`. `RecordDecisionDto` has two fields:
   - `decision!: DecisionType`, with `@IsEnum(DecisionType)` and `@ApiProperty({ enum: DecisionType })`.
   - `note?: string`, with `@Transform` (trims strings and turns empty-after-trim into `undefined`),
     then `@ValidateIf((_o: unknown, v: unknown) => v !== undefined)` (the `whenPresent` pattern
     from `update-application.dto.ts` lines 25-27), `@IsString()` and
     `@MaxLength(DECISION_NOTE_MAX_LENGTH)` checked after the trim, plus
     `@ApiPropertyOptional({ maxLength: 2000 })`. Do **not** use `@IsOptional()`: it skips every
     validator for `null` as well, so `note: null` would pass. With `ValidateIf`, `null` is still
     validated and `@IsString` rejects it with 400. Only a missing key (or a whitespace-only
     note) means "no note".
   Unknown keys are rejected by the global `ValidationPipe` (`forbidNonWhitelisted`).
   `src/applications/dto/record-decision.dto.spec.ts` (new): see Tests.
3. `src/applications/applications.repository.ts`: add `decideIfAllowed(id, expectedVersion,
   action: DecisionAction, to: ApplicationStatus, note: string | null, actor, manager): Promise<boolean>`.
   It runs one `UPDATE merchant_applications SET status = :to, decision_note = :note,
   decided_at = now(), version = version + 1, updated_at = now()` with these WHERE conditions:
   `id = :id`, `version = :expectedVersion` and `status IN (:...fromStatuses(action))` (=
   UNDER_REVIEW). When `requiresCompletedKyb(action)` is true it also adds
   `.andWhere('kyb_status = :kybCompleted', { kybCompleted: KybStatus.COMPLETED })`. It is a bound
   parameter, never a literal in the SQL. It ends with `applyScope(query, actor, '')`. It returns
   `affected === 1`. It touches no other column (no ownership, assignment, KYB or
   `submission_count`). Add it to the class doc's list of conditional updates.
   `src/applications/applications.repository.spec.ts`: see Tests.
4. `src/applications/applications.service.ts`: add constants `KYB_NOT_COMPLETED_CODE =
   'KYB_NOT_COMPLETED'`, `KYB_NOT_COMPLETED_MESSAGE = 'Application can only be approved after
   the KYB check has completed'` and `NOT_DECIDABLE_MESSAGE = 'A decision can only be recorded in
   UNDER_REVIEW'`. Add `async decide(id: string, dto: RecordDecisionDto, actor: AuthUser):
   Promise<ApplicationResponseDto>`, which runs in this order:
   1. `action = DECISION_TO_ACTION[dto.decision]`. If `!isRoleAllowed(action, actor.role)`, throw
      `ForbiddenException` (before any DB work).
   2. `dataSource.transaction`. `findAccessible(id, actor, manager)`. On `null`, throw
      `NotFoundException(APPLICATION_NOT_FOUND_MESSAGE)`.
   3. `to = nextStatus(app.status, action)`. On `null`, throw
      `conflict(NOT_DECIDABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE)`.
   4. If `requiresCompletedKyb(action) && app.kybStatus !== KybStatus.COMPLETED`, throw
      `conflict(KYB_NOT_COMPLETED_MESSAGE, KYB_NOT_COMPLETED_CODE)`.
   5. `decideIfAllowed(app.id, app.version, action, to, dto.note ?? null, actor, manager)`. On
      false, throw `conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE)`.
   6. `auditLogService.record({ actorType: USER, actorId, actorRole, action:
      AuditAction.DECISION_RECORDED, entityType: AUDIT_ENTITY_TYPE, entityId: app.id, meta: {
      decision: action, from: app.status, to } }, manager)`, with a comment saying the note is
      deliberately not in meta (free text, may hold PII).
   7. Return `toApplicationResponse(await this.reReadInTransaction(...))`.
   Nothing enqueues and nothing logs. Update the class doc comment to mention `decide`.
   `src/applications/applications.service.spec.ts`: see Tests.
5. `src/applications/applications.controller.ts`: add `@Post(':id/decision')`,
   `@HttpCode(HttpStatus.OK)`, `@Roles(UserRole.REVIEWER)` and `@ApiOperation({ summary: 'Record
   a decision (assigned REVIEWER)' })`. Responses: `@ApiOkResponse({ type: ApplicationResponseDto })`;
   BadRequest (validation); Forbidden (wrong role); NotFound (unknown id or not assigned to the
   caller); Conflict (`INVALID_STATE_TRANSITION`, `KYB_NOT_COMPLETED`, `CONCURRENT_MODIFICATION`).
   `decide(@Param('id') id, @Body() dto: RecordDecisionDto, @CurrentUser() actor)` delegates to
   the service, with no ParseUUIDPipe (malformed → 404 like the other routes).
   `ApplicationsModule` needs no change: the controller and service are already registered.
6. `docs/adrs/workflow.md`: replace the contradicting sentence (see ADR conflicts) and fix the
   "Noextra" typo in that sentence. Add a "Decision details" paragraph under §1.2 with these points:
   - `note` is optional for all three decisions, trimmed, and at most 2000 characters.
   - Every decision overwrites `decision_note` (with `null` when no note is given) and sets
     `decided_at`.
   - REQUEST_INFO keeps `assigned_reviewer_id`, so the same reviewer gets the application back
     after the resubmit's KYB check.
   - Resubmit leaves `decision_note`/`decided_at` alone until the next decision, so SALES can
     still read the request.
   - The note is returned in responses but never written to audit meta or logs.
   - `decision_note` is free text that the SALES owner, the assigned REVIEWER and ADMIN can all
     see. It is returned unmasked: it is not in sensitive-data.md's masked list. Reviewers should
     therefore not paste raw tax IDs or national IDs into it.
7. `test/reviewer-decision.e2e-spec.ts` (new): real Postgres + Redis, `AppModule` with
   `overrideProvider(KYB_PROVIDER).useValue(new FakeKybProvider())`, and the processor via
   `app.get(KybCheckProcessor).handle(craftedJob(...))` (handler-direct, as in
   `test/kyb-worker.e2e-spec.ts`). Fixtures: users SALES, SALES B, REVIEWER, REVIEWER 2, ADMIN
   (`@example.com`, passwords from `SEED_*` via ConfigService). Helpers are local copies:
   `forceState` (status / assignedReviewerId / kybStatus, parameterised UPDATE), `applicationRow`,
   `auditRows`, and the capturedText spies. The queue is obliterated in `afterAll`. The cases are
   listed under Tests.

## Tests
- Unit, `application-state-machine.spec.ts`: the step 1 cases, including
  "`KYB_COMPLETE` is not in `DECISION_ACTIONS` and `nextStatus(UNDER_REVIEW, 'KYB_COMPLETE' as never)` is null".
- Unit, `record-decision.dto.spec.ts` (validate with `plainToInstance` + `validate`, with
  whitelist/forbidNonWhitelisted options):
  - Valid: each of APPROVE / REJECT / REQUEST_INFO without a note, and with a note.
  - The note is trimmed (`'  more docs  '` → `'more docs'`). A whitespace-only note becomes
    `undefined`. Exactly 2000 characters is valid.
  - Invalid: a missing `decision`; `decision: 'KYB_COMPLETE'`; `'SUBMIT'`; `'approve'`
    (lowercase); a number. A note of 2001 characters (after trim); a non-string note; `note: null`.
  - Extra keys `status`, `kybStatus`, `assignedReviewerId`, `decidedAt` are each rejected.
  - `DECISION_TO_ACTION` maps each enum value to the same-named TransitionAction.
- Unit, `applications.repository.spec.ts`, `decideIfAllowed` (with the same query-capture approach the spec already uses):
  - The SET contains only status, decisionNote, decidedAt, version and updatedAt.
  - The WHERE has id, version, `status IN (UNDER_REVIEW)` and the REVIEWER scope
    `assigned_reviewer_id = :actorId`.
  - APPROVE adds the `kyb_status` condition as a bound parameter: the captured SQL contains
    `kyb_status = :kybCompleted` (or its positional form) and not the literal `'COMPLETED'`, and
    the parameters include `KybStatus.COMPLETED`. REJECT and REQUEST_INFO have no `kyb_status`
    condition.
  - It returns false when affected is 0. The ADMIN/SALES/unknown-role scopes apply (unknown → `1 = 0`).
  - It never touches salesOwnerId, assignedReviewerId, the KYB columns, submissionCount or createdById.
- Unit, `applications.service.spec.ts`, `decide` (mocked repo/audit/dataSource):
  - Denied: ADMIN → ForbiddenException, and SALES → ForbiddenException, both with no
    transaction/findAccessible call.
  - Denied: findAccessible null → NotFoundException.
  - Each non-UNDER_REVIEW status (DRAFT, RISK_REVIEW, INFO_REQUESTED, APPROVED, REJECTED) → 409
    INVALID_STATE_TRANSITION, with no write.
  - APPROVE with kybStatus PENDING / FAILED / NOT_STARTED → 409 KYB_NOT_COMPLETED, with no write.
  - Order: APPROVE on a DRAFT with kybStatus NOT_STARTED → 409 INVALID_STATE_TRANSITION, not
    KYB_NOT_COMPLETED. This shows the KYB guard is checked after `nextStatus`.
  - `decideIfAllowed` receives the trimmed note: a DTO run through `plainToInstance` with
    `'  more docs  '` → `'more docs'`. A whitespace-only note → `null`.
  - REJECT and REQUEST_INFO with kybStatus FAILED → succeed.
  - decideIfAllowed false → 409 CONCURRENT_MODIFICATION, with no audit row.
  - Success: the audit meta is exactly `{ decision, from: 'UNDER_REVIEW', to }` and does not
    contain the note. The note passed to the repo is `null` when absent.
  - The response is masked (no raw taxId/ownerNationalId) and has no `version`/`meta`.
  - The kybQueue is never called.
- Integration, `test/reviewer-decision.e2e-spec.ts`:
  - Happy paths. Each needs status UNDER_REVIEW, the assigned reviewer, and kybStatus COMPLETED
    for approve:
    - APPROVE → 200 APPROVED, `decidedAt` set, decisionNote as sent.
    - REJECT → 200 REJECTED.
    - REQUEST_INFO → 200 INFO_REQUESTED.
    - In each case one DECISION_RECORDED audit row with actor REVIEWER and meta exactly
      `{ decision, from, to }`, and the note text appears in no audit row.
  - REJECT and REQUEST_INFO with kybStatus FAILED → 200.
  - Denied (authz, docs/adrs/testing.md):
    - SALES owner → 403, and ADMIN → 403. The row and audit rows are unchanged in both cases.
      Each role is tested with a valid body and with an invalid body. The invalid body also gets
      403, because Nest runs RolesGuard before ValidationPipe; the test comment says so. The
      service-level `isRoleAllowed` 403 is covered by the unit tests, not here.
    - A non-assigned REVIEWER (REVIEWER 2) → 404 with the same body as an unknown UUID and a
      malformed id `not-a-uuid`.
    - A REVIEWER on an unassigned UNDER_REVIEW application → 404.
    - After ADMIN reassigns from REVIEWER to REVIEWER 2, REVIEWER gets 404 and REVIEWER 2 can decide.
    - No token / tampered token → 401.
  - Denied (validation) → 400:
    - `decision: 'KYB_COMPLETE'`, `'SUBMIT'` and a missing decision.
    - A 2001-character note.
    - Extra keys `status` and `kybStatus`.
  - Invalid state → 409:
    - Deciding in RISK_REVIEW (via a real submit, assigned during RISK_REVIEW) → INVALID_STATE_TRANSITION.
    - Deciding in DRAFT, INFO_REQUESTED, APPROVED and REJECTED → INVALID_STATE_TRANSITION.
    - A second decision after APPROVE → INVALID_STATE_TRANSITION.
    - APPROVE with kybStatus FAILED → KYB_NOT_COMPLETED, and with PENDING → KYB_NOT_COMPLETED.
      The row is unchanged and there is no audit row.
  - Concurrency:
    - Two concurrent decisions from the assigned reviewer (`Promise.all`, APPROVE + REJECT) →
      statuses sorted `[200, 409]`. The loser's code is one of CONCURRENT_MODIFICATION /
      INVALID_STATE_TRANSITION. Exactly one DECISION_RECORDED row, and the final status matches
      the winner.
    - A deterministic lost race: spy `findAccessible` once and bump `version` on a separate
      connection → 409 CONCURRENT_MODIFICATION body.
    - The APPROVE WHERE guard: spy `findAccessible` once and set `kyb_status = 'FAILED'` without
      bumping version → 409 CONCURRENT_MODIFICATION, status still UNDER_REVIEW.
  - Audit rollback: `AuditLogService.record` rejects once → 500 with the standard internal
    error body. The row is unchanged (status UNDER_REVIEW, version, decision_note, decided_at)
    and there is no DECISION_RECORDED row.
  - Full loop:
    1. SALES creates and submits. `handle(id, 0, 1)` → completed. ADMIN assigns REVIEWER (here
       the assignment happens after the first check).
    2. REVIEWER REQUEST_INFO with a note → INFO_REQUESTED, decision_note stored, reviewer kept.
    3. SALES PATCH `businessName` → 200. SALES resubmit → 200, RISK_REVIEW, submission_count 2,
       kyb_status PENDING, and a job `kyb-check:{id}:2` exists in the queue.
    4. GET shows `decisionNote` still present.
    5. `handle(id, 0, 2)` → completed. UNDER_REVIEW, kyb_status COMPLETED, assigned reviewer
       unchanged.
    6. REVIEWER APPROVE → 200 APPROVED.
    7. The audit actions, in order: CREATED, SUBMITTED, KYB_CHECK_COMPLETED, REVIEWER_ASSIGNED,
       DECISION_RECORDED, UPDATED, SUBMITTED, KYB_CHECK_COMPLETED, DECISION_RECORDED.
  - Leak check, in two parts:
    - Every response body in the spec and the captured stdout/stderr/console contain none of
      the raw taxId, ownerNationalId, ownerEmail, ownerPhone or the tokens. Positive check: the
      masked `••••` value is present.
    - The decision-note marker text is checked only against the captured
      stdout/stderr/console output and every `audit_logs` row (`meta` included). It must appear
      in none of them. It is not checked against response bodies, because the note is returned
      to viewers by design.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2  | src/applications/application-state-machine.ts, src/applications/application-state-machine.spec.ts, src/applications/dto/record-decision.dto.ts, src/applications/dto/record-decision.dto.spec.ts | — |
| B  | 3     | src/applications/applications.repository.ts, src/applications/applications.repository.spec.ts | A |
| C  | 4, 5  | src/applications/applications.service.ts, src/applications/applications.service.spec.ts, src/applications/applications.controller.ts | A, B |
| Z  | 6, 7  | docs/adrs/workflow.md, test/reviewer-decision.e2e-spec.ts | A, B, C |

## Security notes
- Authz: `@Roles(UserRole.REVIEWER)` plus a service-level `isRoleAllowed` check give 403 for
  ADMIN and SALES before any DB access. The only read is the scoped `findAccessible` (there is no
  unscoped `findOne({ id })`), so non-assigned, unknown and malformed ids all get the same 404.
  The UPDATE repeats the scope through `applyScope`. Only the assigned REVIEWER can decide.
- Mass assignment: the DTO is whitelisted. `decision` is enum-validated against exactly three
  values, and `DECISION_TO_ACTION` is typed `DecisionAction`, so `KYB_COMPLETE`/`SUBMIT` cannot
  be reached through the body (type + validation + state machine).
- Sensitive data:
  - The response goes through `toApplicationResponse` (masked allow-list).
  - Audit meta holds `{ decision, from, to }` only. The note is free text that may contain PII,
    so it is never put in meta and never logged.
  - Tests use `@example.com` users, fake ids and passwords from `SEED_*` env. Nothing reads `.env`.
- Concurrency: a single conditional UPDATE (id + version + status + scope, plus `kyb_status`
  for APPROVE) means a concurrent decision, reassignment or KYB change cannot slip through.

## Risks / open questions
Resolved with the safest ADR-consistent default (unattended). Each is recorded in workflow.md:
- APPROVE guard kept: `kybStatus != COMPLETED` → 409 `KYB_NOT_COMPLETED` (orchestrator default).
  Its message is distinct from `INVALID_STATE_TRANSITION`, so clients can tell "wrong status"
  from "KYB not done". If the user wants the opposite, revert step 6 and drop the guard.
- The note is optional for all three decisions (max 2000, trimmed; whitespace-only → no note).
  Requiring it for REJECT/REQUEST_INFO is a possible later product rule that no ADR states.
- REQUEST_INFO keeps `assigned_reviewer_id`. `decision_note`/`decided_at` survive the resubmit
  and are overwritten by the next decision (a decision without a note stores `null`).
- The response is the base `ApplicationResponseDto`, as for the other actions, not the detail
  DTO with `kybCheck`.
- The api.md rule mentions a "global filter", but none exists in the code. We keep the existing
  hand-built `{ statusCode, error, message, code }` bodies via `conflict()`. 403/404 keep the Nest
  default bodies, as the other routes do.
- Concurrent-decision e2e: the loser may see either CONCURRENT_MODIFICATION (blocked UPDATE) or
  INVALID_STATE_TRANSITION (read after the commit). The test accepts both, and the deterministic
  spy test pins CONCURRENT_MODIFICATION.
- `decision_note` is returned to everyone who can view the application, including SALES, so they
  can act on a request. It is not masked: it is reviewer-authored text, not a sensitive field in
  sensitive-data.md.

## Revision notes
- Initial version.
- Revision 1 (plan review round 1):
  - Step 2: `note` now uses `@ValidateIf(v !== undefined)` instead of `@IsOptional()`. Reason:
    `@IsOptional()` also skips `null`, which would have let `note: null` through. This matches
    the `whenPresent` pattern in `update-application.dto.ts`.
  - The leak check is split. The note marker is checked only in captured logs and `audit_logs`
    rows. Reason: the note is returned in responses by design, so the old wording contradicted
    the happy-path and full-loop assertions. The raw sensitive-field and token checks still
    cover every response body.
  - Step 6 ADR text:
    - States that `KYB_NOT_COMPLETED` is the one exception to the "INVALID_STATE_TRANSITION for
      anything not in the table" rule.
    - Adds the line that `decision_note` is unmasked free text, visible to the owner, the
      assigned reviewer and ADMIN, and must not hold raw tax or national IDs.
  - Service unit tests now assert the trimmed note reaches `decideIfAllowed`, and that the KYB
    guard runs after `nextStatus` (APPROVE on a DRAFT → INVALID_STATE_TRANSITION).
  - Step 3 and the repository spec: the `kyb_status` condition is a bound parameter
    (`:kybCompleted` = `KybStatus.COMPLETED`), never a SQL literal.
  - E2E: the 403-with-invalid-body case is explained by RolesGuard running before
    ValidationPipe. The service-level `isRoleAllowed` 403 is left to the unit tests.
- Fix round (security review):
  - `decide` rejects with 400 (`note must not contain the tax ID or national ID`, never echoing
    the note or the ID) a note that contains the application's own raw `taxId` or
    `ownerNationalId`. The check compares case-insensitively with spaces and dashes removed on
    both sides, runs inside the transaction after the scoped read and the state/KYB checks, and
    happens before the update, so a rejection writes nothing and adds no audit row. The last 4
    digits alone are allowed.
  - `RecordDecisionDto.note` gets `@Matches(/^[^\u0000]*$/)` with a fixed message, so a NUL
    byte gives 400 instead of a 500 from Postgres.
  - docs/adrs/sensitive-data.md gets a `decision_note` bullet linking to workflow.md §1.2, and
    the workflow.md "Decision details" line now says the API rejects such a note.
