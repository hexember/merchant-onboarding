# Assign reviewer and transfer owner (ADMIN)

## Goal
ADMIN can call `POST /applications/:id/assign` with `{ reviewerId }` and
`POST /applications/:id/transfer-owner` with `{ salesOwnerId }`. Each one changes a single ownership
or assignment column with one conditional UPDATE (guarded by id + version + status IN the allowed
statuses from the operations table + actor scope, and it bumps `version`). It writes a
`REVIEWER_ASSIGNED` / `OWNERSHIP_TRANSFERRED` audit row in the same transaction and returns the
masked application. SALES and REVIEWER get 403. An unknown or malformed application id gets 404. A
target user who is unknown, malformed or has the wrong role gets 400. A status the operation is not
allowed in gets 409 `INVALID_STATE_TRANSITION`, and a lost race gets 409 `CONCURRENT_MODIFICATION`.
When this lands, the bypass cases from docs/adrs/testing.md for this scope pass end to end: SALES
cannot assign or transfer (403), ADMIN cannot transfer to a non-SALES user (400), and after a
transfer from A to B, A gets 404 and B has access. An assign during `RISK_REVIEW` does not stop the
KYB worker from completing.

## Scope
- In:
  - Two conditional updates in `ApplicationsRepository`: `assignReviewerIfAllowed` and `transferOwnerIfAllowed`.
  - Two body DTOs: `AssignReviewerDto` and `TransferOwnerDto`.
  - Two service methods: `ApplicationsService.assignReviewer` and `ApplicationsService.transferOwner`.
  - Two controller routes (`@Roles(UserRole.ADMIN)`, `@HttpCode(200)`, Swagger decorators).
  - Unit tests for each package. E2E cases in `test/applications.e2e-spec.ts`, plus an
    assign-then-worker e2e in `test/kyb-worker.e2e-spec.ts`.
  - Comment refreshes in `UsersRepository.existsWithRole`, the `ApplicationsRepository` class
    comment and the e2e `forceState` comment.
- Out:
  - Unassigning a reviewer (`reviewerId: null`). The ADR has no unassign operation.
  - The decision endpoint and the audit-log endpoint (later backlog items).
  - Any global exception filter. Conflicts keep the hand-built `conflict()` body.
  - Migrations: the columns, FKs and indexes already exist.
  - New audit actions: both are already in `AuditAction`.
  - `.env.example`: the agent cannot read or write it, and no new env variables are needed.
  - `docs/backlog.md`: the ship flow records it.

## ADR references
- docs/adrs/workflow.md §1.2 "Operations that do not change status": `ASSIGN` is allowed in `RISK_REVIEW`,
  `UNDER_REVIEW` and `INFO_REQUESTED`, and `TRANSFER_OWNER` in every non-terminal status, both ADMIN only. The plan
  reads both lists from `OPERATIONS` / `allowedStatuses()` / `isOperationAllowed()` in
  `application-state-machine.ts`, so the table stays the single source. Anything else gets 409
  `INVALID_STATE_TRANSITION`.
- docs/adrs/workflow.md §1.2 "ADMIN can assign during RISK_REVIEW": assign is allowed in
  `RISK_REVIEW`. The worker's guarded UPDATE keeps working (see Security notes / Risks, and the
  e2e in step 7).
- docs/adrs/workflow.md §1.1 status table: the "ADMIN: assign / reassign reviewer, transfer owner"
  cells are what these endpoints provide. Reassigning is the same call with another `reviewerId`.
- docs/adrs/auth.md matrix: for `POST /applications/:id/assign` and `/transfer-owner`, ADMIN gets ✓,
  REVIEWER 403 and SALES 403. This is enforced by `@Roles(UserRole.ADMIN)`, plus a service-level role check as
  defence in depth (the same pattern as `submit`).
- docs/adrs/auth.md "Scoped data access": the lookup goes through
  `applicationsRepository.findAccessible(id, actor, manager)` (ADMIN sees all, so unknown or
  malformed ids get 404). The write repeats the scope through the private `applyScope`.
- docs/adrs/auth.md DTO paragraph: "After creation, `salesOwnerId` changes only through the ADMIN
  transfer endpoint". `TransferOwnerDto` is the only DTO besides create that accepts it, and the
  route is ADMIN only. Both DTOs are whitelisted, so any other field gets 400.
- docs/adrs/auth.md "Concurrency": optimistic `version` in the WHERE clause. The loser gets 409.
- docs/adrs/database.md `merchant_applications`: `sales_owner_id` is "changeable only by ADMIN
  transfer" and "the service checks that the target user has the SALES role". `created_by_id`
  never changes, and the plan does not touch it. `assigned_reviewer_id` drives REVIEWER scope.
- docs/adrs/database.md `audit_logs`: `REVIEWER_ASSIGNED` and `OWNERSHIP_TRANSFERRED` rows are
  written in the same transaction through `AuditLogService.record(entry, manager)`. Their `meta`
  holds ids only, and it is redacted, masked and capped by `buildAuditMeta`.
- docs/adrs/sensitive-data.md: the response comes from `toApplicationResponse` (masked allow-list).
  Nothing new is logged.
- docs/adrs/testing.md bypass list: "after ADMIN transfers … A gets 404 and B has access", "SALES
  cannot transfer ownership (403)", "ADMIN cannot transfer to a non-SALES user (400)", "SALES
  cannot assign … (403)" and "an application ID that does not exist → 404" are all in the e2e plan below.

## ADR conflicts
None.

(This is a pre-existing gap, not caused by this plan: `.claude/rules/api.md` and
docs/adrs/sensitive-data.md mention a global exception filter, but none exists. The existing
`conflict()` helper builds `{ statusCode: 409, error: 'Conflict', message, code }` by hand. Per the
task constraints, this plan reuses that helper and adds no filter.)

## Steps
1. `src/applications/applications.repository.ts`: add two public conditional updates. Both use
   the same pattern as `updateIfEditable`/`submitIfAllowed`:
   ```ts
   assignReviewerIfAllowed(id: string, expectedVersion: number, reviewerId: string,
     actor: AuthUser, manager: EntityManager): Promise<boolean>
   transferOwnerIfAllowed(id: string, expectedVersion: number, salesOwnerId: string,
     actor: AuthUser, manager: EntityManager): Promise<boolean>
   ```
   - `.update(MerchantApplication).set({ assignedReviewerId: reviewerId /* or salesOwnerId */,
     version: () => 'version + 1', updatedAt: () => 'now()' })`.
   - `.where('id = :id')`, `.andWhere('version = :expectedVersion')`,
     `.andWhere('status IN (:...assignableStatuses)', { assignableStatuses: [...allowedStatuses(ApplicationOperation.ASSIGN)] })`
     (`transferableStatuses` / `TRANSFER_OWNER` for transfer).
   - Then `this.applyScope(query, actor, '')`.
   - Return `result.affected === 1`.
   - Each method sets exactly one ownership/assignment column. Neither touches `status`, the
     `kyb_*` columns, `submission_count` or `created_by_id`.
   - Update the class comment: there are now four conditional updates. Each must be called only
     with an id `findAccessible` returned in the same transaction, and each bumps `version`. The
     existing "every write to an ownership or assignment column must bump version" sentence stays,
     and these two are the methods it now applies to.
2. `src/applications/dto/assign-reviewer.dto.ts` (new): `export class AssignReviewerDto { reviewerId!: string }`
   with `@ApiProperty({ format: 'uuid', description: 'A user with role REVIEWER' })`,
   `@IsString()` and `@IsNotEmpty()`. There is deliberately no `@IsUUID()`: the service runs
   `existsWithRole`, which returns false for a non-UUID without querying. A malformed id, an
   unknown id and a non-REVIEWER id then all get the same 400 message (the same approach as
   create's `salesOwnerId`). The global ValidationPipe (`whitelist`, `forbidNonWhitelisted`)
   rejects any other key with 400.
3. `src/applications/dto/transfer-owner.dto.ts` (new): `export class TransferOwnerDto { salesOwnerId!: string }`,
   with the same decorators and reasoning as step 2 (`description: 'A user with role SALES'`).
   Unlike `CreateApplicationDto`, it uses `@IsString()` instead of `@Allow()`. Create uses `@Allow()` only so
   that SALES can reach the service and get a 403. Here the route is ADMIN-only, and guards run before pipes, so
   SALES gets 403 before the body is validated.
4. `src/applications/applications.service.ts`: add the new constants and two methods.
   - Exported constants:
     - `REVIEWER_NOT_REVIEWER_MESSAGE = 'reviewerId must be a REVIEWER user'`
     - `NOT_ASSIGNABLE_MESSAGE = 'A reviewer can only be assigned in RISK_REVIEW, UNDER_REVIEW or INFO_REQUESTED'`
     - `NOT_TRANSFERABLE_MESSAGE = 'Ownership can only be transferred while the application is not APPROVED or REJECTED'`
     - For the transfer target, reuse the existing `SALES_OWNER_NOT_SALES_MESSAGE`.
   - `async assignReviewer(id: string, dto: AssignReviewerDto, actor: AuthUser): Promise<ApplicationResponseDto>`:
     1. Role check (defence in depth behind `@Roles`): if
        `!OPERATIONS[ApplicationOperation.ASSIGN].roles.includes(actor.role)`, throw
        `ForbiddenException()` before any DB work.
     2. If `!(await this.usersRepository.existsWithRole(dto.reviewerId, UserRole.REVIEWER))`, throw
        `BadRequestException(REVIEWER_NOT_REVIEWER_MESSAGE)`. The check runs before the
        transaction, the same as `create`.
     3. Inside `this.dataSource.transaction(async (manager) => …)`:
        - `findAccessible(id, actor, manager)` returns `null` → `NotFoundException(APPLICATION_NOT_FOUND_MESSAGE)`.
        - `!isOperationAllowed(ApplicationOperation.ASSIGN, app.status)` →
          `this.conflict(NOT_ASSIGNABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE)`.
        - `assignReviewerIfAllowed(app.id, app.version, dto.reviewerId, actor, manager)` returns false →
          `this.conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE)`.
        - `auditLogService.record({ actorType: USER, actorId: actor.id, actorRole: actor.role,
          action: AuditAction.REVIEWER_ASSIGNED, entityType: AUDIT_ENTITY_TYPE, entityId: app.id,
          meta: { from: app.assignedReviewerId, to: dto.reviewerId } }, manager)`. `from` is
          `null` when no reviewer was assigned.
        - `return toApplicationResponse(await this.reReadInTransaction(app.id, actor, manager))`.
   - `async transferOwner(id: string, dto: TransferOwnerDto, actor: AuthUser): Promise<ApplicationResponseDto>`:
     the same shape, with `ApplicationOperation.TRANSFER_OWNER`,
     `existsWithRole(dto.salesOwnerId, UserRole.SALES)` → 400 `SALES_OWNER_NOT_SALES_MESSAGE`,
     `NOT_TRANSFERABLE_MESSAGE`, `transferOwnerIfAllowed`, and
     `AuditAction.OWNERSHIP_TRANSFERRED` with meta `{ from: app.salesOwnerId, to: dto.salesOwnerId }`.
   - Same target again (assigning the current reviewer, or transferring to the current owner):
     there is no special branch. The call follows the normal path: 200, `version` bump, and an
     audit row with `from === to` (see Risks).
   - Add both methods to the class doc comment. Import `OPERATIONS` from the state machine.
     Neither method logs anything.
   - Keep the role check inline as `OPERATIONS[ApplicationOperation.X].roles.includes(actor.role)`.
     The existing `isRoleAllowed` only takes transition actions, so it does not fit. Add no helper
     to `application-state-machine.ts`, which is in no work package.
5. `src/applications/applications.controller.ts`: add two routes, placed after `submit`.
   - `@Post(':id/assign') @HttpCode(HttpStatus.OK) @Roles(UserRole.ADMIN)`
     `assign(@Param('id') id, @Body() dto: AssignReviewerDto, @CurrentUser() actor)`, which calls
     `applicationsService.assignReviewer`. Swagger:
     - `@ApiOperation({ summary: 'Assign or reassign the reviewer (ADMIN)' })`
     - `@ApiOkResponse({ type: ApplicationResponseDto })`
     - `@ApiBadRequestResponse` (validation, or the target is not a REVIEWER)
     - `@ApiForbiddenResponse` (wrong role)
     - `@ApiNotFoundResponse`
     - `@ApiConflictResponse` (INVALID_STATE_TRANSITION / CONCURRENT_MODIFICATION)
   - `@Post(':id/transfer-owner')`, the same way, calls `applicationsService.transferOwner`.
   - No `ParseUUIDPipe` on `:id`, for the reason the existing controller comment gives.
6. `src/users/users.repository.ts`: comment only. `existsWithRole` is now "used for an ADMIN's
   `salesOwnerId` on create and transfer, and `reviewerId` on assign". No code change.
7. `test/applications.e2e-spec.ts` and `test/kyb-worker.e2e-spec.ts`: the e2e cases listed under
   Tests.
   - In `applications.e2e-spec.ts`:
     - Add `reviewer2Id`.
     - Add the helpers `assign(token, id, body)` and `transferOwner(token, id, body)`. Both are
       tracked for the leak check.
     - Add the body constants `NOT_ASSIGNABLE_BODY`, `NOT_TRANSFERABLE_BODY`,
       `REVIEWER_NOT_REVIEWER_BODY` (`{ statusCode: 400, error: 'Bad Request', message }`) and
       `SALES_OWNER_NOT_SALES_BODY`.
     - Update the `forceState` comment: the assign endpoint now exists, but tests still use
       `forceState` to reach `UNDER_REVIEW`/terminal statuses without the worker or the decision
       endpoint.
   - In `kyb-worker.e2e-spec.ts`:
     - In `beforeAll`, also insert three more fake users:
       - An ADMIN (`kyb-admin@example.com`, 'Ari Admin'), with its password from `SEED_ADMIN_PASSWORD`.
       - A REVIEWER (`kyb-reviewer@example.com`, 'Rae Reviewer'), with its password from `SEED_REVIEWER_PASSWORD`.
       - A second SALES user (`kyb-sales-b@example.com`, 'Kai Sales'). Its password comes from
         `SEED_SALES_PASSWORD`, and it reuses the existing SALES `passwordHash`.

       Every password is read through `ConfigService.getOrThrow` and none is hardcoded. Log each
       of the three in to get `adminToken`, `reviewerToken` and `salesBToken`. Record `reviewerId`
       and `salesBId` with a `SELECT id FROM users WHERE email = $1` helper, as
       `applications.e2e-spec.ts` does.
     - Add `assigned_reviewer_id` and `sales_owner_id` to its `applicationRow` select.

## Tests
- Unit (`src/applications/applications.repository.spec.ts`):
  - `assignReviewerIfAllowed`:
    - The SET has `assignedReviewerId`, `version: version + 1` and `updatedAt: now()`, and nothing else.
    - The WHERE has id, `version = :expectedVersion` and `status IN (:...assignableStatuses)`, with exactly
      `[RISK_REVIEW, UNDER_REVIEW, INFO_REQUESTED]`.
    - ADMIN adds no scope clause. SALES adds `sales_owner_id = :actorId`, REVIEWER adds
      `assigned_reviewer_id = :actorId`, and an unknown role adds `1 = 0`.
    - It returns true for `affected: 1` and false for `affected: 0`.
  - `transferOwnerIfAllowed`: the same cases, with `salesOwnerId` in the SET and the
    `[DRAFT, RISK_REVIEW, UNDER_REVIEW, INFO_REQUESTED]` list.
  - Neither SET contains `status`, `kybStatus`, `submissionCount` or `createdById`.
- Unit (`src/applications/dto/assign-reviewer.dto.spec.ts`, `transfer-owner.dto.spec.ts`): run
  `validate` with `whitelist` + `forbidNonWhitelisted`, as the existing DTO specs do.
  - Valid: a UUID string.
  - Denied:
    - The field is missing.
    - An empty string.
    - A number.
    - `null`.
    - An extra key (`status`, `assignedReviewerId`, `salesOwnerId` on assign, `reviewerId` on transfer).
  - A non-UUID string passes the DTO. The service rejects it.
- Unit (`src/applications/applications.service.spec.ts`): extend the `Mocks` with
  `assignReviewerIfAllowed` / `transferOwnerIfAllowed`.
  - `assignReviewer`:
    - ADMIN in each of `RISK_REVIEW`, `UNDER_REVIEW` and `INFO_REQUESTED` → the repository is called with
      `(app.id, app.version, reviewerId, ADMIN, manager)`. The audit entry is `REVIEWER_ASSIGNED` with meta
      `{ from: null, to }`, recorded with the transaction manager, and the response is masked.
    - Reassign → meta `{ from: previousReviewerId, to }`.
    - The same reviewer again → write + audit with `from === to`.
    - Denied:
      - SALES → 403 and REVIEWER → 403. For each, assert that `existsWithRole` is not called,
        `transaction` is not called and there is no write.
      - Target not a REVIEWER (`existsWithRole` false) → 400 `REVIEWER_NOT_REVIEWER_MESSAGE`, with no
        transaction. `existsWithRole` is called with `UserRole.REVIEWER`.
      - Not found → 404.
      - `DRAFT`, `APPROVED` and `REJECTED` → 409 with `code: INVALID_STATE_TRANSITION_CODE`, and no write.
      - The repository returns false → 409 `CONCURRENT_MODIFICATION_CODE`, and no audit.
      - The audit `record` rejects → the error propagates out of the transaction.
  - `transferOwner`: the mirror cases.
    - ADMIN in each non-terminal status → `OWNERSHIP_TRANSFERRED` with meta `{ from: oldOwner, to }`.
    - Transfer to the current owner → write + audit.
    - Denied:
      - SALES → 403 and REVIEWER → 403. For each, assert that `existsWithRole` is not called,
        `transaction` is not called and there is no write.
      - The target is not SALES (`existsWithRole(..., UserRole.SALES)` false) → 400 `SALES_OWNER_NOT_SALES_MESSAGE`.
      - 404.
      - `APPROVED`/`REJECTED` → 409 `INVALID_STATE_TRANSITION`.
      - Lost race → 409 `CONCURRENT_MODIFICATION`.
- Integration (`test/applications.e2e-spec.ts`, real Postgres + Redis):
  - `describe('POST /applications/:id/assign')`:
    - ADMIN assigns in `RISK_REVIEW` (real submit) → 200. The test gets a one-line comment: it
      relies on the worker being off in this spec (`KybCheckProcessor` uses `autorun: false`, and
      `test/setup/test-env.ts` sets `KYB_WORKER_ENABLED=false`), so the row stays in
      `RISK_REVIEW` after submit. The body keys are exactly
      `RESPONSE_KEYS`, the body is masked, and `assignedReviewerId = reviewerId`. In the row,
      `version` is +1 and `status`/`kyb_status`/`submission_count` are unchanged. There is one
      `REVIEWER_ASSIGNED` audit row with `actor_type USER` and `actor_role ADMIN`, and its meta
      `toEqual({ from: null, to: reviewerId })`.
    - ADMIN assigns in `UNDER_REVIEW` and in `INFO_REQUESTED` (`forceState`) → 200.
    - Access after assign: the assigned REVIEWER can `GET /applications/:id` (200, detail keys)
      and sees it in `GET /applications`. reviewer-2 gets 404 on GET.
    - Reassign to reviewer-2 → 200, with meta `{ from: reviewerId, to: reviewer2Id }`. Then the
      previous reviewer gets 404 on GET (`NOT_FOUND_BODY`) and no longer sees it in the list, while
      reviewer-2 gets 200.
    - The same reviewer again → 200, with a second audit row where `from === to`.
    - Denied:
      - **SALES (the owner) cannot assign → 403** (`FORBIDDEN_BODY`), including with an invalid body
        (the guard runs before the pipe).
      - REVIEWER (even the assigned one) → 403.
      - No token → 401.
      - The row is unchanged and there are no audit rows for all of these.
    - Denied target → 400: a SALES user's id, the ADMIN's id, an unknown UUID (`FAKE_UUID`) and
      `'not-a-uuid'` all give `REVIEWER_NOT_REVIEWER_BODY`. A missing `reviewerId`, an extra key
      (`assignedReviewerId`, `status`) and a numeric `reviewerId` give a 400 from the
      ValidationPipe. In all these cases the row is unchanged and there is no audit row.
    - Denied: unknown application id → 404, and a malformed application id → 404, both with the
      same `NOT_FOUND_BODY`.
    - Denied wrong state: `DRAFT`, `APPROVED` and `REJECTED` → 409 `NOT_ASSIGNABLE_BODY`
      (`INVALID_STATE_TRANSITION`), and the row is unchanged.
    - Lost race: spy on `findAccessible` and bump `version` between the read and the write (the
      existing pattern) → 409 `CONCURRENT_MODIFICATION`. `assigned_reviewer_id` is still null and
      there is no `REVIEWER_ASSIGNED` row.
  - `describe('POST /applications/:id/transfer-owner')`:
    - **ADMIN transfers A→B** (in `DRAFT`) → 200, with `salesOwnerId = salesBId` and
      `createdById` still `salesAId`. There is one `OWNERSHIP_TRANSFERRED` row with meta
      `{ from: salesAId, to: salesBId }`. Then:
      - **SALES A gets 404** on GET, PATCH and submit, and the application is no longer in A's list.
      - **SALES B has access**: GET 200, PATCH 200, the application is in B's list, and submit 200.
    - Transfer in `RISK_REVIEW`, `UNDER_REVIEW` and `INFO_REQUESTED` → 200.
    - Transfer to the current owner → 200 + an audit row with `from === to`.
    - Denied:
      - **SALES cannot transfer ownership → 403**. This includes the owner transferring to
        another SALES user and SALES transferring to themselves.
      - REVIEWER → 403.
      - No token → 401.
    - Denied target: **ADMIN cannot transfer to a non-SALES user → 400**. A REVIEWER id and the
      ADMIN's own id give `SALES_OWNER_NOT_SALES_BODY`, and so do an unknown UUID and
      `'not-a-uuid'`. A missing field and an extra key give a 400 from the ValidationPipe. The row
      is unchanged and there is no audit row.
    - Denied: unknown or malformed application id → 404.
    - Denied wrong state: `APPROVED` and `REJECTED` → 409 `NOT_TRANSFERABLE_BODY`.
    - Lost race → 409 `CONCURRENT_MODIFICATION`, and `sales_owner_id` is unchanged.
  - `describe('same transaction as the audit row')`: add two cases.
    - A failed audit write on assign gives 500 (`INTERNAL_ERROR_BODY`), and the row is
      `toEqual(before)` (no reviewer, same version).
    - A failed audit write on transfer gives 500, and the row is unchanged (the owner is still A).
  - The existing leak checks (response texts, captured logs) also cover the new requests: no raw
    `taxId`/`ownerNationalId`/owner email/phone and no token.
- Integration (`test/kyb-worker.e2e-spec.ts`, fake `KybProvider`, handler-direct):
  - Assign during `RISK_REVIEW`, then the worker completes:
    1. Call `submittedApplication()`, then the ADMIN assigns the REVIEWER (200).
    2. `handle(id)` resolves to `'completed'`.
    3. The row is `UNDER_REVIEW` / `COMPLETED`, `assigned_reviewer_id` is still the reviewer, and
       `version` is greater than after the assign.
    4. The audit actions are `[APPLICATION_CREATED, APPLICATION_SUBMITTED, REVIEWER_ASSIGNED, KYB_CHECK_COMPLETED]`.
    5. The REVIEWER's `GET /applications/:id` is 200 and shows `kybCheck.status: COMPLETED`.
  - Transfer during `RISK_REVIEW`, then the worker completes:
    1. Call `submittedApplication()`, which the original SALES user owns. The ADMIN transfers it
       to `salesBId` (200).
    2. `handle(id)` resolves to `'completed'`.
    3. The row is `UNDER_REVIEW` / `COMPLETED`, and `sales_owner_id` is still `salesBId`.
    4. The audit actions end with `OWNERSHIP_TRANSFERRED, KYB_CHECK_COMPLETED`.
    5. The new owner (`salesBToken`) gets 200 on `GET /applications/:id`, with `kybCheck.status: COMPLETED`.
    6. **The original SALES user (`salesToken`) gets 404.** The existing `kybCheckBody` helper
       expects 200 with `salesToken`, so make the request directly for this assertion.
  - Worker step between the ADMIN's read and write:
    - Take `real = repo.findAccessible.bind(repo)` before spying. Then spy on `findAccessible`
      with **`mockImplementationOnce`**, so that only the first call (the assign's scoped read)
      runs `real(...)` and then `await handle(id)`. Later calls go to the real method and never
      run the worker again: `reReadInTransaction` is not reached on this path, but any later GETs are.
    - Restore the spy in a `finally`.
    - The worker completes on its own connection and bumps `version`, so the assign gets 409
      `CONCURRENT_MODIFICATION`.
    - The worker's result stands (`UNDER_REVIEW` / `COMPLETED`, one `kyb_checks` row).
      `assigned_reviewer_id` is null, and there is no `REVIEWER_ASSIGNED` row. A retry would then
      succeed in `UNDER_REVIEW`.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1     | src/applications/applications.repository.ts, src/applications/applications.repository.spec.ts | — |
| B  | 2, 3  | src/applications/dto/assign-reviewer.dto.ts, src/applications/dto/assign-reviewer.dto.spec.ts, src/applications/dto/transfer-owner.dto.ts, src/applications/dto/transfer-owner.dto.spec.ts | — |
| C  | 4, 5, 6 | src/applications/applications.service.ts, src/applications/applications.service.spec.ts, src/applications/applications.controller.ts, src/users/users.repository.ts | A, B |
| Z  | 7     | test/applications.e2e-spec.ts, test/kyb-worker.e2e-spec.ts | C |

No module wiring changes: `ApplicationsModule` already provides `ApplicationsRepository`,
`UsersRepository` and `AuditLogService`. `.env.example` is assigned to no package.

## Security notes
- **Role 403s:** `@Roles(UserRole.ADMIN)` on both routes, with the role read from the DB by
  `JwtAuthGuard`. The service repeats the check against `OPERATIONS[op].roles` before any DB work.
  SALES and REVIEWER get 403, as in the matrix. Guards run before the ValidationPipe, so a
  wrong-role caller gets 403 even with a bad body. The response does not reveal whether the body
  was valid.
- **No authz bypass:** the application is loaded only through `findAccessible(id, actor, manager)`,
  and there is no unscoped `findOne({ id })`. The UPDATE repeats `applyScope` (defence in depth) and
  is guarded by `version`, so it can only hit the row that passed the scope check. Unknown or
  malformed ids get 404.
- **Target validation:** `existsWithRole` checks the role in the DB and selects no user data. A
  wrong role, an unknown user or a non-UUID all get one generic 400 message, so the endpoint does
  not tell the caller which users exist with which role beyond yes/no. The caller is ADMIN anyway.
- **Access change takes effect at once:** REVIEWER and SALES scope is evaluated on every request
  from `assigned_reviewer_id` / `sales_owner_id`. After a reassign or transfer, the previous
  reviewer or owner gets 404 on the next request. The e2e tests prove both.
- **Mass assignment:** both DTOs are whitelisted with one field each. `status`, `kyb*`, `version`
  and `createdById` are rejected with 400. `salesOwnerId` is accepted only on the ADMIN-only
  transfer route, as `.claude/rules/api.md` and auth.md require.
- **Audit and sensitive data:** the audit row is in the same transaction (the rollback e2e proves it).
  `meta` holds ids only (`from`, `to`), no names and no emails, and it still passes through
  `redact()`/`maskSensitiveFields()`. Responses use `toApplicationResponse` (masked). No new log
  lines. Test users are fake `@example.com` addresses, and their passwords come from `SEED_*` env
  through `ConfigService`.
- **KYB worker safety:** the worker's writes are guarded on `id`, `submission_count` and
  `status = RISK_REVIEW`, not on `version`, and they never set `assigned_reviewer_id` or
  `sales_owner_id`. Assign and transfer change neither `status` nor `submission_count`, so a
  worker UPDATE after an assign still matches and keeps the new reviewer or owner. If the two
  UPDATEs hit the row together, Postgres row locking serializes them. Under READ COMMITTED, the
  second statement re-checks its WHERE against the committed row:
  - The worker's guard still holds after an assign, so the worker proceeds.
  - The assign's `version` condition fails after a worker bump, so the ADMIN gets a retryable
    409 `CONCURRENT_MODIFICATION`.

  Either way nothing is lost or stuck.

## Risks / open questions
These are resolved with the safest default that fits the ADRs. The implementer should follow them as written.
- **Same target again** (assigning the current reviewer, or transferring to the current owner):
  the call returns **200, does the normal write (version bump) and writes an audit row with
  `from === to`**. Reasons:
  - It is a single code path with no extra branch.
  - Every successful ADMIN mutation leaves an audit trail.
  - The end state is the same, so the call is idempotent from the client's view.

  Alternatives considered:
  - A 409 would make an idempotent retry fail.
  - A 400 would treat a valid request as invalid input.
  - A silent no-op would add an un-audited success path.

  The cost is a needless `version` bump, which can make a concurrent PATCH get 409. That is
  acceptable.
- **Response shape:** both endpoints return `ApplicationResponseDto` (`toApplicationResponse`),
  not the detail shape. This is consistent with the other mutations (POST, PATCH and submit all
  return the base shape). Only `GET /applications/:id` adds `kybCheck`. Clients poll GET for KYB
  progress.
- **Error precedence:** role (403) → body validation (400 from the pipe) → target role (400, before the
  transaction, the same as create) → application lookup (404) → status (409) → race (409). So an
  unknown application with a bad target gets 400. That leaks nothing, because only ADMIN reaches
  this point and ADMIN can see every application.
- **Target role check before the transaction:** the target's role could change between the
  check and the commit. There is no role-change endpoint and the window is tiny, so this matches
  how `create` handles `salesOwnerId`. The FKs guarantee the user row exists.
- **No unassign:** the ADR defines no unassign. `reviewerId: null` gets 400 from the DTO.
- **Status code 200 (not 201):** these are actions on an existing resource, the same as submit.
- **Pre-existing doc gap:** `.claude/rules/api.md` / sensitive-data.md mention a global exception
  filter that does not exist. This task does not change that, per the constraints.

## Revision notes
- **Revision 1** (plan review round 1):
  - Blocker: the transfer-then-worker e2e needed a second SALES user. Step 7 now adds one to the
    `beforeAll` of `kyb-worker.e2e-spec.ts`: `kyb-sales-b@example.com`, with a made-up name. Its
    password comes from `SEED_SALES_PASSWORD` through `ConfigService` and it reuses the existing
    hash. The step logs it in and records `salesBId`. The ADMIN and REVIEWER emails and names are
    now spelled out, and `reviewerId` is recorded too.
  - The transfer-then-worker test now asserts three things after `handle(id)` returns
    `'completed'`: `sales_owner_id` is still `salesBId`, the new owner gets 200 on GET, and the
    original SALES user gets 404.
  - Interleave test: the `findAccessible` spy uses `mockImplementationOnce` around the real
    method, so only the first call runs `handle(id)`, and it is restored in a `finally`.
  - Applications e2e: the "assign in RISK_REVIEW (real submit)" case gets a comment saying it
    relies on the worker being off (`autorun: false`, `KYB_WORKER_ENABLED=false` in
    `test/setup/test-env.ts`). I checked both in the code.
  - Service unit spec: the SALES 403 cases on both methods now also assert that
    `existsWithRole` is not called and no transaction starts, the same as REVIEWER.
  - Step 4: the role check stays inline as `OPERATIONS[op].roles.includes(actor.role)`, and no
    helper is added to `application-state-machine.ts`. `isRoleAllowed` only takes transition
    actions, so it does not fit.
