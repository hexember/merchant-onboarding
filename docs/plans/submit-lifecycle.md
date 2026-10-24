# Submit lifecycle

## Goal
The state machine from docs/adrs/workflow.md §1.2 lives in one pure, data-driven module
(`src/applications/application-state-machine.ts`, no Nest/TypeORM imports). It holds the
transition table, the table of operations that do not change status, and the lookup functions
built on them. Unit tests cover every (status, action) and (status, operation) pair and prove
that `KYB_COMPLETE` cannot be reached from any user-facing action. The stand-in
`application-status.ts` (`EDITABLE_STATUSES` / `isEditable`) is removed and the PATCH path reads
the `UPDATE` row of the operations table, with the same behaviour. `POST /applications/:id/submit`
(ADMIN, or the owner SALES; REVIEWER → 403) moves an application from `DRAFT` or `INFO_REQUESTED`
to `RISK_REVIEW` in one transaction. That transaction runs a single conditional `UPDATE`: it sets
`kyb_status = PENDING`, clears `kyb_level`, `kyb_score` and `kyb_last_attempt_at`, sets
`kyb_attempts = 0`, `submission_count + 1`, `submitted_at = now()` and `version + 1`, and is
guarded by `version`, `status IN (DRAFT, INFO_REQUESTED)` and the actor scope. The same
transaction writes an `APPLICATION_SUBMITTED` audit row with meta `{ from, to, submissionNo }`.
Out of scope, unknown and malformed IDs get the same 404. Any other status gets 409
`INVALID_STATE_TRANSITION`, and a lost race gets 409 `CONCURRENT_MODIFICATION`. The response is
the existing masked application shape. Nothing is enqueued yet: a commented seam after the commit
marks where the kyb-worker item adds the job.

## Scope
- In:
  - New pure module `src/applications/application-state-machine.ts` + spec.
  - Remove `src/applications/application-status.ts` + spec; migrate their callers
    (`ApplicationsRepository.updateIfEditable`, `ApplicationsService.update`).
  - `ApplicationsRepository.submitIfAllowed(...)` (conditional UPDATE reusing `applyScope`).
  - `ApplicationsService.submit(...)`, `ApplicationsController.submit(...)`.
  - Unit tests for the module, repository and service; e2e cases in `test/applications.e2e-spec.ts`.
- Out:
  - BullMQ / Redis / any enqueue (the kyb-worker item adds it after the commit; only a comment seam
    is left here).
  - `kyb_checks`, the worker, the `kybCheck` response block (kyb-worker item).
  - Assign, transfer-owner, decision endpoints (later items). Their rows are in the tables as data
    only. The APPROVE guard `kybStatus = COMPLETED` is stored as description text and is not
    evaluated here.
  - New migration: not needed. `kyb_status`, `kyb_level`, `kyb_score`, `kyb_attempts`,
    `kyb_last_attempt_at`, `submission_count`, `submitted_at` and `version` already exist in
    `1792800000002-CreateMerchantApplications.ts` and in the entity.
  - Response shape changes (no KYB fields or `submissionCount` added).
  - A global exception filter (not reintroduced). `.env.example` (no new env, no package owns it).
  - New dependencies; `ApplicationsModule` / `AppModule` changes (the controller is already registered).

## ADR references
- docs/adrs/workflow.md §1.2 transition table: encoded verbatim as `TRANSITIONS` (from, action, to,
  actor type, roles, "Who" text, "Extra guard" text). `KYB_COMPLETE` is the only `SYSTEM` row and
  is not part of the `UserTransitionAction` type. "Anything not in the table returns 409
  `INVALID_STATE_TRANSITION`" becomes `nextStatus(...) === null` → 409 in the service.
  "`KYB_COMPLETE` has no HTTP endpoint at all" holds: no controller route takes an action
  parameter, and the user-facing functions reject the SYSTEM row both in the types and at runtime.
- docs/adrs/workflow.md §1.2 operations table: encoded as `OPERATIONS` (`UPDATE` in `DRAFT`,
  `INFO_REQUESTED`; `ASSIGN` in `RISK_REVIEW`, `UNDER_REVIEW`, `INFO_REQUESTED`; `TRANSFER_OWNER`
  in every non-terminal status), with roles and "Who" text. PATCH now reads the `UPDATE` row.
- docs/adrs/workflow.md §1.1: terminal statuses `APPROVED`, `REJECTED` have no outgoing transition
  (asserted by a unit test). Resubmit from `INFO_REQUESTED` keeps `assigned_reviewer_id` ("lands in
  their queue").
- docs/adrs/workflow.md §1.3 and docs/adrs/kyb-check.md: on every SUBMIT, the same transaction sets
  `status = RISK_REVIEW`, `kyb_status = PENDING`, clears `kyb_level`/`kyb_score`, resets
  `kyb_attempts` to 0, increments `submission_count` (to `n`) and writes the audit row. The enqueue
  "after the commit" is left as a seam for the kyb-worker item. `n` goes into the audit meta as
  `submissionNo`, the value the later job ID `kyb-check:{applicationId}:{n}` uses.
- docs/adrs/auth.md matrix: `POST /applications/:id/submit` → ADMIN ✓, REVIEWER 403, SALES if owner
  (`@Roles(ADMIN, SALES)` + scoped lookup). §Authorization: lookup through
  `findAccessible(id, actor, manager)`, out of scope = unknown = 404. Concurrency paragraph:
  conditional `UPDATE ... WHERE version = :read AND status IN (...)`; the loser gets 409.
- docs/adrs/database.md §`merchant_applications`: `submission_count` is the idempotency key and
  `kyb_attempts` is per submission ("reset on SUBMIT"). `version` is the optimistic lock.
  §`audit_logs`: `APPLICATION_SUBMITTED`, same transaction, meta through `record()` (redact, mask,
  cap). §`meta`: meta holds statuses and a counter only, no PII.
- docs/adrs/sensitive-data.md: the response uses `toApplicationResponse` (masked); nothing new is
  logged.
- docs/adrs/testing.md: unit test of the state machine, every allowed and rejected transition,
  `KYB_COMPLETE` unreachable from user actions. Integration: "SALES A cannot ... submit SALES B's
  application by ID (404)", unknown ID → 404 (same body), no token → 401, invalid transitions →
  409. The request-info → resubmit → back to `RISK_REVIEW` path is covered up to the point this
  item can reach. A *new KYB check* needs the worker.
- .claude/rules/api.md: thin controller; the transition table is data; 409 for invalid transitions
  and conflicts.
- .claude/rules/database.md: no schema change, so no migration; state change + audit row in one
  transaction.
- .claude/rules/typescript.md: explicit return types, no `any`/`!`/`@ts-ignore`, constructor
  injection, no `process.env`.
- .claude/rules/security.md: scoped lookup, then a scoped conditional write; 404/403 as specified;
  fake data; no sensitive logging.

## ADR conflicts
None for this plan. One existing inconsistency inside docs/adrs/workflow.md (the APPROVE guard) is
listed under Risks. It belongs to the decision item, and this plan only records the guard as text.

## Steps
1. `src/applications/application-state-machine.ts` (new, pure: imports only
   `./application.enums` and `../common/common.enums`; no Nest, no TypeORM, no I/O):
   - `export enum TransitionAction { SUBMIT, KYB_COMPLETE, APPROVE, REJECT, REQUEST_INFO }`
     (string values equal to the names).
   - `export enum TransitionActorType { USER = 'USER', SYSTEM = 'SYSTEM' }`.
   - `export type SystemTransitionAction = TransitionAction.KYB_COMPLETE;`
     `export type UserTransitionAction = Exclude<TransitionAction, SystemTransitionAction>;`
     `export const USER_TRANSITION_ACTIONS: readonly UserTransitionAction[] = [SUBMIT, APPROVE, REJECT, REQUEST_INFO];`
   - `export interface Transition { readonly from: ApplicationStatus; readonly action: TransitionAction; readonly to: ApplicationStatus; readonly actorType: TransitionActorType; readonly roles: readonly UserRole[]; readonly who: string; readonly guard: string | null; }`
   - `export const TRANSITIONS: readonly Transition[]`, exactly the six ADR rows:
     - `DRAFT --SUBMIT--> RISK_REVIEW`, USER, roles `[ADMIN, SALES]`, who `'owner SALES, ADMIN'`, guard `null`
     - `INFO_REQUESTED --SUBMIT--> RISK_REVIEW`, same
     - `RISK_REVIEW --KYB_COMPLETE--> UNDER_REVIEW`, SYSTEM, roles `[]`, who `'system (worker) only'`,
       guard `"job's submission_no = current submission_count"`
     - `UNDER_REVIEW --APPROVE--> APPROVED`, USER, roles `[REVIEWER]`, who `'assigned REVIEWER'`,
       guard `'kybStatus = COMPLETED'`
     - `UNDER_REVIEW --REJECT--> REJECTED`, USER, `[REVIEWER]`, `'assigned REVIEWER'`, `null`
     - `UNDER_REVIEW --REQUEST_INFO--> INFO_REQUESTED`, USER, `[REVIEWER]`, `'assigned REVIEWER'`, `null`
     A header comment says this is docs/adrs/workflow.md §1.2, is the single source of truth, and
     that the `guard` and the owner/assigned part of `who` are descriptive. The scope comes from
     `ApplicationsRepository`, and each guard is enforced by the item that implements the action.
   - `export const TERMINAL_STATUSES: readonly ApplicationStatus[] = [APPROVED, REJECTED];`
   - Private `findTransition(from, action, actorType): Transition | null`: the row matching all
     three, otherwise `null`.
   - `export function nextStatus(from: ApplicationStatus, action: UserTransitionAction): ApplicationStatus | null`:
     looks up with `actorType = USER`, so even a cast `KYB_COMPLETE` returns `null` at runtime.
   - `export function canTransition(from: ApplicationStatus, action: UserTransitionAction): boolean`
     → `nextStatus(from, action) !== null`.
   - `export function nextSystemStatus(from: ApplicationStatus, action: SystemTransitionAction): ApplicationStatus | null`
     (actorType `SYSTEM`; for the later worker). Its comment says never to call it from a
     request path.
   - `export function fromStatuses(action: UserTransitionAction): readonly ApplicationStatus[]`:
     the `from` of every USER row for `action`, in table order (SUBMIT → `[DRAFT, INFO_REQUESTED]`).
     The repository uses it for the `status IN (...)` guard.
   - `export function isRoleAllowed(action: UserTransitionAction, role: UserRole): boolean`: true
     when some USER row for `action` lists `role`. ADMIN is false for APPROVE/REJECT/REQUEST_INFO.
   - `export enum ApplicationOperation { UPDATE = 'UPDATE', ASSIGN = 'ASSIGN', TRANSFER_OWNER = 'TRANSFER_OWNER' }`.
   - `export interface OperationRule { readonly allowedIn: readonly ApplicationStatus[]; readonly roles: readonly UserRole[]; readonly who: string; }`
   - `export const OPERATIONS: Readonly<Record<ApplicationOperation, OperationRule>>`:
     `UPDATE` → `[DRAFT, INFO_REQUESTED]`, `[ADMIN, SALES]`, `'owner SALES, ADMIN'`;
     `ASSIGN` → `[RISK_REVIEW, UNDER_REVIEW, INFO_REQUESTED]`, `[ADMIN]`,
     `'ADMIN (target must have role REVIEWER)'`;
     `TRANSFER_OWNER` → `[DRAFT, RISK_REVIEW, UNDER_REVIEW, INFO_REQUESTED]` (every non-terminal),
     `[ADMIN]`, `'ADMIN (target must have role SALES)'`.
   - `export function isOperationAllowed(operation: ApplicationOperation, status: ApplicationStatus): boolean`
     and `export function allowedStatuses(operation: ApplicationOperation): readonly ApplicationStatus[]`.
   - Every exported function declares its return type. Arrays are `readonly`, and callers spread
     them (`[...x]`) before handing them to TypeORM.
2. `src/applications/application-state-machine.spec.ts` (new): see Tests (unit).
3. `src/applications/application-status.ts`, `src/applications/application-status.spec.ts`:
   **delete** both. The new spec covers the `UPDATE` cases they tested.
4. `src/applications/applications.repository.ts` (+ `applications.repository.spec.ts`):
   - Replace the `EDITABLE_STATUSES` import with `allowedStatuses(ApplicationOperation.UPDATE)` in
     `updateIfEditable` (same parameter name `editableStatuses`, same values, so the SQL is
     unchanged).
   - Add
     `async submitIfAllowed(id: string, expectedVersion: number, to: ApplicationStatus, actor: AuthUser, manager: EntityManager): Promise<boolean>`:
     ```
     manager.createQueryBuilder().update(MerchantApplication).set({
       status: to,
       kybStatus: KybStatus.PENDING,
       kybLevel: null,
       kybScore: null,
       kybAttempts: 0,
       kybLastAttemptAt: null,
       submissionCount: () => 'submission_count + 1',
       submittedAt: () => 'now()',
       version: () => 'version + 1',
       updatedAt: () => 'now()',
     })
     .where('id = :id', { id })
     .andWhere('version = :expectedVersion', { expectedVersion })
     .andWhere('status IN (:...submittableStatuses)', { submittableStatuses: [...fromStatuses(TransitionAction.SUBMIT)] })
     ```
     then `this.applyScope(query, actor, '')`, `execute()`, and return `affected === 1`. Its doc
     comment says: only call with an id `findAccessible` returned in the same transaction; it is
     the single SUBMIT write (docs/adrs/kyb-check.md); it never touches ownership/assignment
     columns.
   - Update the class comment: there are now two conditional updates (`updateIfEditable`,
     `submitIfAllowed`), both repeat the scope through `applyScope`, and both bump `version`.
5. `src/applications/applications.service.ts` (+ `applications.service.spec.ts`):
   - Replace `isEditable(app.status)` with
     `isOperationAllowed(ApplicationOperation.UPDATE, app.status)`. The message and code stay the
     same.
   - New exported constant
     `NOT_SUBMITTABLE_MESSAGE = 'Application can only be submitted from DRAFT or INFO_REQUESTED'`.
   - Pull the two hand-built 409 bodies into one private helper
     `conflict(message: string, code: string): ConflictException` returning
     `new ConflictException({ statusCode: 409, error: 'Conflict', message, code })`. The bodies
     stay exactly as they are; there is still no filter.
   - New `async submit(id: string, actor: AuthUser): Promise<ApplicationResponseDto>`:
     1. `if (!isRoleAllowed(TransitionAction.SUBMIT, actor.role)) throw new ForbiddenException();`
        before any DB work (defence in depth behind `@Roles`).
     2. `const result = await this.dataSource.transaction(async (manager) => { ... })`, where the
        callback does:
        a. `findAccessible(id, actor, manager)`; `null` → `NotFoundException(APPLICATION_NOT_FOUND_MESSAGE)`.
        b. `const to = nextStatus(app.status, TransitionAction.SUBMIT)`; `null` →
           `conflict(NOT_SUBMITTABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE)`.
        c. `submitIfAllowed(app.id, app.version, to, actor, manager)`; `false` →
           `conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE)`.
        d. `const submitted = await this.reReadInTransaction(app.id, actor, manager)`.
        e. `auditLogService.record({ actorType: USER, actorId: actor.id, actorRole: actor.role, action: AuditAction.APPLICATION_SUBMITTED, entityType: AUDIT_ENTITY_TYPE, entityId: app.id, meta: { from: app.status, to, submissionNo: submitted.submissionCount } }, manager)`.
           Exactly these three meta keys. `submissionNo` is read back from the row, not computed.
        f. Return `{ response: toApplicationResponse(submitted), applicationId: app.id, submissionNo: submitted.submissionCount }`
           (a small private interface `SubmitResult`).
     3. After the transaction, a seam comment:
        `// After the commit: the kyb-worker item enqueues jobId kyb-check:{applicationId}:{submissionNo} here (docs/adrs/kyb-check.md). Nothing is enqueued yet.`
        Then `return result.response;`. `applicationId` and `submissionNo` stay on `SubmitResult` so
        the seam has its inputs. No queue import, no extra constructor dependency.
   - Update the class doc comment to mention submit and the state machine module.
6. `src/applications/applications.controller.ts`: add
   ```
   @Post(':id/submit')
   @HttpCode(HttpStatus.OK)
   @Roles(UserRole.ADMIN, UserRole.SALES)
   @ApiOperation({ summary: 'Submit a DRAFT or INFO_REQUESTED application for the KYB check' })
   @ApiOkResponse({ type: ApplicationResponseDto })
   @ApiForbiddenResponse({ description: 'Wrong role' })
   @ApiNotFoundResponse({ description: 'Unknown id or not visible to the caller' })
   @ApiConflictResponse({ description: 'Not submittable in its status (INVALID_STATE_TRANSITION) or changed concurrently (CONCURRENT_MODIFICATION)' })
   submit(@Param('id') id: string, @CurrentUser() actor: AuthUser): Promise<ApplicationResponseDto>
   ```
   No `@Body()` and no `ParseUUIDPipe` (a malformed id → same 404). It only delegates to the service.
7. `test/applications.e2e-spec.ts`: see Tests (integration). Helper changes:
   - `submit(token: string | undefined, id: string)` → `POST /applications/${id}/submit`, tracked.
   - `forceState` gains optional KYB fields (`kybStatus`, `kybLevel`, `kybScore`, `kybAttempts`,
     `kybLastAttemptAt`, `submissionCount`), each its own parameterised test-only `UPDATE`. The
     comment is updated: it sets states the API cannot reach yet (no worker/assign/decision).
   - `applicationRow` also selects `kyb_status, kyb_level, kyb_score, kyb_attempts,
     kyb_last_attempt_at, submission_count, submitted_at`. Existing `toEqual(before)` checks keep
     working because both sides use the same select.
   - Swagger test: five operations, adding `paths['/applications/{id}/submit'].post`.
   - Leak test: also submits one application.

## Tests
- Unit (`npm run test`):
  - `application-state-machine.spec.ts`
    - **Every (status, action) pair:** an `EXPECTED: Record<ApplicationStatus, Partial<Record<UserTransitionAction, ApplicationStatus>>>`
      matrix (`DRAFT: { SUBMIT: RISK_REVIEW }`, `INFO_REQUESTED: { SUBMIT: RISK_REVIEW }`,
      `UNDER_REVIEW: { APPROVE: APPROVED, REJECT: REJECTED, REQUEST_INFO: INFO_REQUESTED }`,
      `RISK_REVIEW: {}`, `APPROVED: {}`, `REJECTED: {}`). `it.each` over
      `Object.values(ApplicationStatus) × USER_TRANSITION_ACTIONS` (24 cases) asserts
      `nextStatus` equals the expected status or `null`, and `canTransition` matches. Named
      rejected examples include: SUBMIT from `RISK_REVIEW`/`UNDER_REVIEW`/`APPROVED`/`REJECTED`,
      APPROVE from `DRAFT`, every decision in `RISK_REVIEW`, and anything from a terminal status.
    - The matrix classifies every status: its keys equal `Object.values(ApplicationStatus)`, so a
      new status fails until it is classified.
    - **`KYB_COMPLETE` unreachable from user actions:** `USER_TRANSITION_ACTIONS` does not contain
      `KYB_COMPLETE`; `USER_TRANSITION_ACTIONS` ∪ `[KYB_COMPLETE]` equals
      `Object.values(TransitionAction)` (no action unclassified); for every status,
      `nextStatus(status, KYB_COMPLETE as unknown as UserTransitionAction)` is `null` (runtime
      guard behind the type); no user action from any status yields `UNDER_REVIEW` (the only way
      into `UNDER_REVIEW` is the SYSTEM row); every `TRANSITIONS` row with action `KYB_COMPLETE`
      has `actorType SYSTEM` and empty `roles`; every SYSTEM row's action is not in
      `USER_TRANSITION_ACTIONS`.
    - `nextSystemStatus(RISK_REVIEW, KYB_COMPLETE)` → `UNDER_REVIEW`; from every other status → `null`.
    - Table integrity: no duplicate `(from, action)` row; no row starts in a terminal status; the
      table has exactly six rows matching the ADR (asserted as data).
    - `fromStatuses(SUBMIT)` → `[DRAFT, INFO_REQUESTED]`; `fromStatuses(APPROVE)` → `[UNDER_REVIEW]`.
    - `isRoleAllowed`: SUBMIT true for ADMIN and SALES, **false for REVIEWER**; APPROVE/REJECT/
      REQUEST_INFO true for REVIEWER, **false for ADMIN and SALES**.
    - **Operations, every (status, operation) pair:** matrix over `Object.values(ApplicationStatus) × Object.values(ApplicationOperation)`
      (18 cases) for `isOperationAllowed`: UPDATE only `DRAFT`, `INFO_REQUESTED`; ASSIGN only
      `RISK_REVIEW`, `UNDER_REVIEW`, `INFO_REQUESTED`; TRANSFER_OWNER every non-terminal status
      and **not** `APPROVED`/`REJECTED`. `allowedStatuses(UPDATE)` → `[DRAFT, INFO_REQUESTED]`.
      Roles: ASSIGN and TRANSFER_OWNER `[ADMIN]` only.
  - `applications.repository.spec.ts`
    - Existing `updateIfEditable` cases unchanged (same `editableStatuses` param and values).
    - `submitIfAllowed`: the `set(...)` argument has exactly the keys `status, kybStatus, kybLevel,
      kybScore, kybAttempts, kybLastAttemptAt, submissionCount, submittedAt, version, updatedAt`
      with `status = RISK_REVIEW` (the passed `to`), `kybStatus = PENDING`, `kybLevel`, `kybScore`
      and `kybLastAttemptAt` `null`, `kybAttempts 0`, and raw expressions `'submission_count + 1'`,
      `'now()'`, `'version + 1'`, `'now()'`. `where('id = :id')`, then the `andWhere` calls in
      order: version, `status IN (:...submittableStatuses)` with `[DRAFT, INFO_REQUESTED]`, then
      the scope: SALES `sales_owner_id = :actorId`, REVIEWER `assigned_reviewer_id = :actorId`,
      ADMIN none, **unknown role `1 = 0` → false**. `affected` 0 / `undefined` → `false`; 1 → `true`.
  - `applications.service.spec.ts` (extend the existing mocks with `submitIfAllowed`; give
    `fakeApplication` a `submissionCount`)
    - Existing `update` cases still pass (now via `isOperationAllowed`).
    - **Denied:** REVIEWER → `ForbiddenException`, `transaction` never called.
    - **Denied:** `findAccessible` → `null` → `NotFoundException` (`APPLICATION_NOT_FOUND_MESSAGE`),
      no `submitIfAllowed`, no audit.
    - **Denied:** `RISK_REVIEW`, `UNDER_REVIEW`, `APPROVED`, `REJECTED` → `ConflictException` whose
      response equals `{ statusCode: 409, error: 'Conflict', message: NOT_SUBMITTABLE_MESSAGE, code: 'INVALID_STATE_TRANSITION' }`,
      no write, no audit.
    - **Denied:** `submitIfAllowed` → `false` → `ConflictException` with `code: 'CONCURRENT_MODIFICATION'`,
      no audit, no re-read.
    - Allowed (`it.each` over `DRAFT`, `INFO_REQUESTED` and actor SALES / ADMIN):
      `submitIfAllowed(APP_ID, readVersion, RISK_REVIEW, actor, manager)`; the re-read (second
      `findAccessible` call, same manager) returns `submissionCount: 3`; the audit entry equals
      `{ actorType: USER, actorId, actorRole, action: APPLICATION_SUBMITTED, entityType: 'merchant_application', entityId: APP_ID, meta: { from: <status>, to: RISK_REVIEW, submissionNo: 3 } }`
      with the transaction manager; meta has exactly those three keys; the response is masked
      (`taxId` `'••••••1234'`) and has no `meta`/`version`/`submissionCount` keys.
    - The audit write fails → rejects. The re-read returns `null` → throws the in-transaction error.
- Integration (`test/applications.e2e-spec.ts`, real Postgres, Supertest, existing users/tokens).
  States the API cannot reach yet are set with test-only SQL through `forceState`.
  - SALES owner submits a DRAFT → 200, masked body (`RESPONSE_KEYS` unchanged), `status RISK_REVIEW`,
    `submittedAt` not null. Row: `status RISK_REVIEW`, `kyb_status PENDING`, `kyb_level`,
    `kyb_score`, `kyb_last_attempt_at` null, `kyb_attempts 0`, `submission_count 1`,
    `version 2`. Audit rows `[APPLICATION_CREATED, APPLICATION_SUBMITTED]`; the second equals
    `{ actor_type USER, actor_id A, actor_role SALES, action APPLICATION_SUBMITTED, entity_type merchant_application, entity_id, meta: { from: 'DRAFT', to: 'RISK_REVIEW', submissionNo: 1 } }`.
  - Resubmit clears the previous result. Force `INFO_REQUESTED` with `kyb_status COMPLETED`,
    `kyb_level HIGH`, `kyb_score 78`, `kyb_attempts 2`, `kyb_last_attempt_at` set,
    `submission_count 1`, `assigned_reviewer_id = reviewer`. ADMIN submits → 200. Row:
    `RISK_REVIEW`, `PENDING`, level/score/last-attempt null, attempts 0, `submission_count 2`,
    `assigned_reviewer_id` unchanged. Audit meta `{ from: 'INFO_REQUESTED', to: 'RISK_REVIEW', submissionNo: 2 }`,
    actor ADMIN.
  - ADMIN submits SALES B's DRAFT → 200.
  - **Denied:** SALES A submits SALES B's application → 404. Its body equals the body for an
    unknown UUID and for `/applications/not-a-uuid/submit` (all `NOT_FOUND_BODY`). B's row and
    the audit rows are unchanged.
  - **Denied:** REVIEWER, even the assigned one → 403 `FORBIDDEN_BODY`, row unchanged; REVIEWER on
    an unknown UUID → 403 too (role check comes first).
  - **Denied:** `RISK_REVIEW`, `UNDER_REVIEW`, `APPROVED`, `REJECTED` (forced) → 409, body
    `{ statusCode: 409, error: 'Conflict', message: NOT_SUBMITTABLE_MESSAGE, code: 'INVALID_STATE_TRANSITION' }`,
    row unchanged, only the `APPLICATION_CREATED` audit row.
  - **Denied:** submitting twice through the API → the second gets 409 `INVALID_STATE_TRANSITION`;
    `submission_count` stays 1; one `APPLICATION_SUBMITTED` row.
  - **Denied:** PATCH after a real submit → 409 `NOT_EDITABLE_BODY` (proves the operations table
    and the transition agree).
  - Lost race, deterministic: `jest.spyOn(app.get(ApplicationsRepository), 'findAccessible')`
    with a `mockImplementationOnce` that calls the real method and then, before returning, bumps
    the row's `version` with test-only SQL on a separate connection (`dataSource.query`; the
    SELECT holds no row lock). Result: 409 with `code: 'CONCURRENT_MODIFICATION'`; row still
    `DRAFT`, `submission_count 0`; no `APPLICATION_SUBMITTED` row. Restore the spy in `finally`.
  - Two concurrent submits (`Promise.all`) of one DRAFT → sorted statuses `[200, 409]`; the 409
    code is `CONCURRENT_MODIFICATION` or `INVALID_STATE_TRANSITION`, depending on timing;
    `submission_count 1`; exactly one `APPLICATION_SUBMITTED` row. Assert only those facts, never
    timing.
  - Same transaction: the audit `record` is mocked to reject once → 500 `INTERNAL_ERROR_BODY`;
    the row is unchanged (`DRAFT`, `NOT_STARTED`, `submission_count 0`, `version 1`); no
    `APPLICATION_SUBMITTED` row.
  - **Denied:** no token → 401 `UNAUTHORIZED_BODY`.
  - Leak test and Swagger test updated as in step 7.
- Gate: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:e2e`.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2  | src/applications/application-state-machine.ts, src/applications/application-state-machine.spec.ts | — |
| B  | 3, 4, 5, 6 | src/applications/application-status.ts (delete), src/applications/application-status.spec.ts (delete), src/applications/applications.repository.ts, src/applications/applications.repository.spec.ts, src/applications/applications.service.ts, src/applications/applications.service.spec.ts, src/applications/applications.controller.ts | A |
| Z  | 7     | test/applications.e2e-spec.ts | A, B |

A only adds files, so the tree compiles throughout. B deletes the stand-in in the same package that
migrates its two callers. Z runs the full gate; if a failure comes from an A or B file, Z reports
it instead of editing that file. No wiring file changes: `ApplicationsModule` already registers the
controller and service, so `app.module.ts`, the migrations index and `package.json` are untouched.
`.env.example` belongs to no package.

## Security notes
- **No authz bypass:** submit reads only through `findAccessible(id, actor, manager)`. The write
  is `submitIfAllowed`, called with that id in the same transaction and guarded by
  `version = :read`, `status IN (DRAFT, INFO_REQUESTED)` and the same `applyScope` (SALES →
  `sales_owner_id`, REVIEWER → `assigned_reviewer_id`, unknown role → `1 = 0`). No unscoped
  find-by-id is added. Out of scope, unknown and malformed IDs all get the same 404. REVIEWER → 403
  from `@Roles`, and again from `isRoleAllowed` in the service.
- **`KYB_COMPLETE` unreachable:** `UserTransitionAction` excludes it at compile time, and
  `nextStatus` filters on `actorType = USER` at runtime. No route accepts an action name. Unit
  tests prove all of this.
- **Concurrency:** one conditional UPDATE. A lost race affects 0 rows → 409, and the transaction
  rolls back, so no audit row is left behind.
- **Sensitive data:** the response comes from `toApplicationResponse` (masked). Audit meta holds
  two status values and a counter only (and still goes through `record()`'s redact/mask/cap).
  Nothing new is logged. The e2e leak test covers submit.
- **Mass assignment:** submit takes no body DTO, so the client cannot set any column. Every value
  written is server-defined.
- **Transactions:** status change, KYB reset and audit row commit together. The e2e audit-failure
  test proves the rollback.
- **Fake data / no secrets:** existing `@example.com` fixtures and `SEED_*` env passwords only.

## Risks / open questions
- **APPROVE guard inconsistency in docs/adrs/workflow.md (not resolved here):** the §1.2 table
  gives APPROVE the guard `kybStatus = COMPLETED`, and docs/adrs/testing.md expects "approving with
  `kybStatus=FAILED` → 409". But the paragraph after the table says "APPROVE can still be possible
  even if `kybStatus != COMPLETED`". This plan stores the guard text from the table and does not
  evaluate it. The decision item must settle it and edit the ADR. The safest default is to keep
  the guard (it matches the table and testing.md) and to reword or delete that sentence.
- **`kyb_last_attempt_at` cleared on SUBMIT (default taken):** kyb-check.md lists only
  `kyb_level`/`kyb_score`/`kyb_attempts`. The task says "cleared KYB fields", and workflow.md §1.3
  says SUBMIT "clears the previous result". Because `kyb_attempts` is per submission, the last
  attempt time is cleared with it.
- **`submitted_at = now()` on every submit (default taken):** the ADR does not say whether it is
  the first or the latest submission. Latest is used (it matches `submission_count`).
- **`decision_note` / `decided_at` untouched on resubmit (default taken):** nothing writes them yet,
  and the ADR is silent. The decision item can decide whether a request-info note survives
  resubmission.
- **`assigned_reviewer_id` kept on resubmit:** follows workflow.md ("lands in their queue").
- **HTTP 200, not 201 (default taken):** submit changes an existing resource, so
  `@HttpCode(HttpStatus.OK)`. The ADR does not specify.
- **Request body ignored:** submit declares no `@Body()`, so a body is neither validated nor read.
  Rejecting a non-empty body would need an empty DTO, and the ADR asks for nothing like that.
- **409 code depends on timing:** a status change between the read and the write gives
  `CONCURRENT_MODIFICATION`; a change seen at read time gives `INVALID_STATE_TRANSITION`. Both are
  409 per auth.md. `CONCURRENT_MODIFICATION` is not an ADR-named code (carried over from
  applications-crud).
- **No queue, no recovery:** after this item an application sits in `RISK_REVIEW` with
  `kyb_status PENDING` until the kyb-worker item lands; nothing moves it on. This is expected. The
  seam comment marks the after-commit enqueue point (kyb-check.md's documented trade-off: no outbox).
- **`submission_count + 1` raw expression:** TypeORM leaves `'submission_count + 1'` as written
  (no property name to rewrite). The repository spec asserts the expression, and the e2e asserts
  the stored counter.
- **Error body shape (carried over):** `.claude/rules/api.md` describes a global filter that does
  not exist. The 409 bodies are built by hand; other errors use Nest defaults.
- **Environment:** no new env. `test:e2e` needs the existing `SEED_*`, `DB_NAME_TEST`, `JWT_SECRET`;
  if they are missing, report e2e as skipped, not passed.
