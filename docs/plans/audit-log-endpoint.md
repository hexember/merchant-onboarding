# ADMIN audit-log endpoint for an application

## Goal
`GET /applications/:id/audit-logs?page&limit` returns the audit history of one merchant
application to ADMIN only, as `{ items, page, limit, total }`. Items come oldest first. Each item is
an explicit allow-list (`id, action, actorType, actorId, actorRole, actorLabel, createdAt, meta`), and
`meta` is redacted and masked again on read. REVIEWER and SALES get 403 before any DB work. An
unknown or malformed application id gets the same 404 as every other application endpoint, through
the scoped `ApplicationsRepository.findAccessible`, and that check runs before any audit row is
read. The query only returns rows with `entity_type = 'merchant_application' AND entity_id = <that
application's id>`, so LOGIN_* rows (`entity_type = 'user'`) and other applications' rows can never
appear. `audit_logs` stays append-only: the new code only reads.

## Scope
- In: a read-only `AuditLogQueryService` in `src/audit`, the response DTOs and mapper, a shared
  entity-type constant (also adopted by the KYB worker), a query DTO, `ApplicationsService.listAuditLogs`, the controller route with
  Swagger decorators, module wiring, unit tests and one e2e spec.
- Out: filters on action/actor/date, reading `user` audit rows (LOGIN_*), any write, update or
  delete on `audit_logs`, new indexes or migrations, a global exception filter, `.env.example`
  (no new env variables are needed), and changes to the ADRs.

## ADR references
- docs/adrs/auth.md matrix row `GET /applications/:id/audit-logs` (ADMIN ✓, REVIEWER 403, SALES
  403): `@Roles(UserRole.ADMIN)` on the route, plus a role check in the service (defence in depth,
  the same pattern as `assignReviewer`).
- docs/adrs/auth.md §Authorization, layer 2: the application is looked up with
  `applicationsRepository.findAccessible(id, actor)` (ADMIN scope = all rows). A miss or a
  malformed id returns 404 `Application not found`. There is no unscoped find-by-id.
- docs/adrs/database.md §`meta` columns ("It is not returned in API responses, except in the ADMIN
  audit-log endpoint"): this is that endpoint. No other response gains `meta`.
- docs/adrs/database.md §`audit_logs` (append-only; index `(entity_type, entity_id, created_at)`):
  the query uses only `SELECT`/`COUNT`, and the existing index covers it (see Steps 3).
- docs/adrs/sensitive-data.md (masked in API responses and audit `meta`; `redact()` key denylist):
  `meta` goes through the same `buildAuditMeta` (redact → mask → plain JSON → 8 KB cap) on read.
- docs/adrs/workflow.md §1.4 ("The audit trail shows each system step as an entry with
  `actor_type = SYSTEM` and `actor_label = 'kyb-worker'`"): SYSTEM rows are returned with
  `actorLabel`, plus `actorId`/`actorRole` as null.
- docs/adrs/testing.md: the denied cases for this route (REVIEWER 403, SALES 403, unknown id 404,
  no or tampered token 401) are each tested.

## ADR conflicts
None.

## Steps
1. `src/audit/audit.enums.ts`: add
   `export const MERCHANT_APPLICATION_ENTITY_TYPE = 'merchant_application' as const;`. This is the
   single source of the entity type, so the writers (applications service, KYB worker) and the
   reader (audit) cannot drift apart. Both writers switch to it (Steps 5 and 10). It lives in
   `src/audit` so that the audit module never imports from applications, which would create a
   cycle.
2. `src/audit/dto/audit-log-response.dto.ts` (new):
   - `AuditLogResponseDto`, with Swagger `@ApiProperty` on each field: `id` (uuid),
     `action` (enum `AuditAction`), `actorType` (enum `AuditActorType`), `actorId` (uuid, nullable),
     `actorRole` (enum `UserRole`, nullable), `actorLabel` (string, nullable, example `kyb-worker`),
     `createdAt` (Date), and `meta` (`type: 'object'`, `additionalProperties: true`, description
     "Server-written context; redacted and masked", example `{ "from": "DRAFT", "to": "RISK_REVIEW",
     "submissionNo": 1 }`). `entityType` and `entityId` are deliberately left out, because the
     path already names the application.
   - `AuditLogListResponseDto { items: AuditLogResponseDto[]; page; limit; total }`. It copies the
     shape and examples of `ApplicationListResponseDto` but does **not** import it: nothing in
     `src/audit` imports from `src/applications`.
   - `toAuditLogResponse(row: AuditLog): AuditLogResponseDto`: copies the fields one by one and
     never spreads the entity, and sets `meta: buildAuditMeta(row.meta)` (imported from
     `../audit-log.service`). Why the meta is sanitised again on read when it was already sanitised
     at write time: (a) rows written by any path that skipped `record()` (a seed, a manual SQL fix,
     a future writer bug) are still masked; (b) a key added later to the redact denylist or to
     `MASKERS` then also covers older rows; (c) the response is a new trust boundary, and this is
     the only API that returns `meta`. The pipeline is idempotent on the values `record()` normally
     stores (`maskLast4('••••••1234')`, `maskEmail('j•••@example.com')`, `maskPhone('••••••123')`
     and `'[REDACTED]'` all map to themselves). It is **not** idempotent on a bare `MASK`: a stored
     `'••••••'` (written for an input of 4 characters or fewer, or a non-string) is longer than 4
     characters, so on read `maskLast4` returns `MASK + '••••'` (10 bullets). That still reveals
     nothing, and the plan accepts it. The 8 KB cap cannot change a row that `record()` wrote; it
     only matters for a row that skipped `record()`.
3. `src/audit/audit-log-query.service.ts` (new): `@Injectable() AuditLogQueryService`, which
   injects `@InjectRepository(AuditLog) Repository<AuditLog>`. It has one public method:
   ```ts
   findApplicationHistoryPage(applicationId: string, page: number, limit: number):
     Promise<{ items: AuditLog[]; total: number }>
   ```
   - It runs `repository.findAndCount({ where: { entityType: MERCHANT_APPLICATION_ENTITY_TYPE,
     entityId: applicationId }, order: { createdAt: 'ASC', id: 'ASC' }, skip: (page - 1) * limit,
     take: limit })`.
   - The entity type is hard-coded and the method takes no `entityType` argument, so no caller
     can read `user` rows (LOGIN_SUCCEEDED / LOGIN_FAILED) or any other entity's rows.
   - Read-only by construction: the service has no insert, save, update or delete calls. Its doc
     comment says `audit_logs` is append-only and that writes go only through
     `AuditLogService.record`. `AuditLogService` itself is not changed, so it stays insert-only.
   - Callers must pass an id that the scoped `findAccessible` returned (this goes in the doc
     comment). The service itself does no authorization.
   - Order is **ASC** (`created_at ASC, id ASC`): the response is a history and reads as a
     timeline, page 1 is the start, and pages stay stable as new rows are appended at the end.
     `id` breaks ties so the order is deterministic, though not causal. Rows written in one
     transaction share `created_at` (`now()` is the transaction start time). Today
     `KybCheckProcessor.recordFinalFailure` writes `KYB_CHECK_ATTEMPT_FAILED` and then
     `KYB_CHECK_FAILED` in one transaction, so those two can come back in either order. This is
     accepted and documented in the doc comment (see Risks).
   - Index: `IDX_audit_logs_entity (entity_type, entity_id, created_at)` covers the equality
     filter on both columns and the `created_at` sort, and `COUNT(*)` uses the same index prefix.
     Only the `id` tie-break among equal timestamps may need an incremental sort. **No new index or
     migration.**
4. `src/applications/dto/list-audit-logs-query.dto.ts` (new): `ListAuditLogsQueryDto`, with only
   `page` and `limit`. It uses the same decorators and imports `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`
   and `MAX_PAGE` from `./list-applications-query.dto`, so the defaults (1 / 20), the caps (100 /
   10000) and the conversion with `@Type(() => Number)` stay identical. There is no `status`, and
   no `entityType` or other filter. Unknown keys are rejected by the global ValidationPipe
   (`forbidNonWhitelisted`) with 400.
5. `src/applications/applications.service.ts`:
   - Replace the literal with `export const AUDIT_ENTITY_TYPE = MERCHANT_APPLICATION_ENTITY_TYPE;`.
     The export name stays the same, so existing imports keep working.
   - Add `export const AUDIT_LOG_READ_ROLES: readonly UserRole[] = [UserRole.ADMIN];`.
   - Inject `AuditLogQueryService` as a new constructor parameter.
   - Add `async listAuditLogs(id: string, query: ListAuditLogsQueryDto, actor: AuthUser):
     Promise<AuditLogListResponseDto>`, in this order:
     (1) if `!AUDIT_LOG_READ_ROLES.includes(actor.role)`, throw `new ForbiddenException()`, before
     any DB call;
     (2) `const app = await this.applicationsRepository.findAccessible(id, actor)`, and if it is
     `null`, throw `new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE)` (a malformed id also
     returns null without a query);
     (3) `auditLogQueryService.findApplicationHistoryPage(app.id, query.page, query.limit)`. It
     uses `app.id`, never the raw path value;
     (4) return `{ items: items.map(toAuditLogResponse), page: query.page, limit: query.limit,
     total }`.
     No transaction is needed: it is a read-only pair, and applications are never deleted. Nothing
     is logged. Update the class doc comment to list the new method.
6. `src/applications/applications.service.spec.ts`: add a `findApplicationHistoryPage` mock to the
   factory, passed as `{ findApplicationHistoryPage } as unknown as AuditLogQueryService`. Add the
   unit cases listed under Tests.
7. `src/applications/applications.controller.ts`: add the route
   ```ts
   @Get(':id/audit-logs')
   @Roles(UserRole.ADMIN)
   @ApiOperation({ summary: 'Audit history of one application, oldest first (ADMIN)' })
   @ApiOkResponse({ type: AuditLogListResponseDto })
   @ApiBadRequestResponse({ description: 'Invalid query parameters' })
   @ApiForbiddenResponse({ description: 'Wrong role' })
   @ApiNotFoundResponse({ description: 'Unknown id' })
   listAuditLogs(@Param('id') id: string, @Query() query: ListAuditLogsQueryDto,
     @CurrentUser() actor: AuthUser): Promise<AuditLogListResponseDto>
   ```
   It has no `ParseUUIDPipe`, for the same reason as the other `:id` routes (a malformed id must
   get 404). `:id/audit-logs` has two path segments, so it does not clash with `GET :id`.
8. `src/audit/audit.module.ts`: add `AuditLogQueryService` to `providers` and `exports`.
   `TypeOrmModule.forFeature([AuditLog])` is already imported. `ApplicationsModule` already imports
   `AuditModule`, so it needs no change.
9. `test/audit-log-endpoint.e2e-spec.ts` (new): the e2e cases listed under Tests. The setup copies
   `test/reviewer-decision.e2e-spec.ts`: users with fake `@example.com` addresses, passwords from
   `SEED_*_PASSWORD` through `ConfigService`, a `FakeKybProvider` override, stdout/stderr/console
   spies with `configureLogger({ production: false })`, `resetTables` in `beforeAll` and
   `resetApplicationData` in `beforeEach`, and a `responseTexts` collector for the leak checks.
   That setup never serves Swagger, so the main app also calls
   `setupSwagger(app, true)` (from `src/common/swagger`) **before** `app.init()`, which makes
   `/docs-json` available for the Swagger case. This is the same order as `createApp(true)` in
   `test/swagger.e2e-spec.ts`.
10. `src/kyb/kyb-check.processor.ts`: replace the local `const AUDIT_ENTITY_TYPE =
    'merchant_application';` (line 24) with an import of `MERCHANT_APPLICATION_ENTITY_TYPE` from
    `../audit/audit.enums`, keeping the local name as an alias or replacing its four uses. This
    one-line change does not change behaviour, and the existing kyb-worker e2e and unit tests cover
    it.

## Tests
- Unit, `src/audit/dto/audit-log-response.dto.spec.ts`:
  - `toAuditLogResponse` returns exactly the keys `[id, action, actorType, actorId, actorRole,
    actorLabel, createdAt, meta]`, in that order. A row object with extra properties
    (`entityType`, `entityId`, an extra `secretField`) does not leak them.
  - A SYSTEM row maps to `actorId: null`, `actorRole: null`, `actorLabel: 'kyb-worker'`.
  - Defensive masking: a row whose stored meta is raw (`{ taxId: 'PAN123456789', ownerNationalId:
    'NID-FAKE-9876', ownerEmail: 'raw@example.com', ownerPhone: '+977-0000000456', password: 'x',
    accessToken: 'y', nested: { authorization: 'Bearer z' } }`) comes out masked and redacted
    (`••••••6789`, `••••••9876`, `r•••@example.com`, `••••••456`, `[REDACTED]` ×3).
  - Idempotent: already-masked meta with masked values longer than 4 characters (`••••••6789`,
    `r•••@example.com`, `••••••456`, `[REDACTED]`) comes out deep-equal.
  - A stored bare `MASK` (`{ taxId: '••••••' }`) comes back as the known 10-bullet value
    `MASK + '••••'`. This pins the documented non-idempotent case.
  - The input row's `meta` object is not mutated.
  - Oversized stored meta (> `AUDIT_META_MAX_BYTES`) comes back as
    `{ truncated: true, originalBytes }`.
- Unit, `src/audit/audit-log-query.service.spec.ts`, with a mocked `Repository<AuditLog>`:
  - It calls `findAndCount` once, with `where { entityType: 'merchant_application', entityId }`,
    `order { createdAt: 'ASC', id: 'ASC' }`, and `skip`/`take` for (page 1, limit 20) → 0/20,
    (page 3, limit 10) → 20/10, and (page 10000, limit 100) → 999900/100.
  - It returns `{ items, total }` from the tuple.
  - Read-only: the mock repository exposes only `findAndCount`, and the test asserts that no
    other method (`insert`, `save`, `update`, `delete`, `remove`, `query`) is defined or called.
- Unit, `src/applications/dto/list-audit-logs-query.dto.spec.ts` (`plainToInstance` +
  `validate`):
  - Defaults are `page = 1`, `limit = 20`. The strings `'2'` / `'50'` convert to numbers.
  - `limit = 100` and `page = 10000` are valid.
  - Invalid: `limit` 0, 101, -1, `'abc'`, 1.5; `page` 0, 10001, `'x'`.
  - The DTO has no `status` or `entityType` property (whitelist → these are rejected at the pipe;
    the e2e asserts the 400).
- Unit, `src/applications/applications.service.spec.ts` → `listAuditLogs`:
  - REVIEWER → `ForbiddenException`, and SALES → `ForbiddenException`. For both, neither
    `findAccessible` nor `findApplicationHistoryPage` is called.
  - ADMIN with `findAccessible` → null: `NotFoundException(APPLICATION_NOT_FOUND_MESSAGE)`, and
    `findApplicationHistoryPage` is not called.
  - ADMIN happy path: `findAccessible(id, actor)` is called first, then
    `findApplicationHistoryPage(app.id, page, limit)` (call order checked with
    `mock.invocationCallOrder`). It uses the id returned from the DB even when the path id has
    different case. The result is `{ items: mapped, page, limit, total }`.
  - Items go through `toAuditLogResponse`: a raw `taxId` in a mocked row's meta comes back masked.
  - No transaction is opened (`dataSource.transaction` is not called).
  - `AUDIT_ENTITY_TYPE === MERCHANT_APPLICATION_ENTITY_TYPE`.
- Ordering rule for every test (unit and e2e): never assert the relative order of rows written in
  the same transaction (today that means `KYB_CHECK_ATTEMPT_FAILED` and `KYB_CHECK_FAILED` from
  `recordFinalFailure`). For such rows, assert only that both are present and that both come after
  every row written in an earlier request or job.
- Integration, `test/audit-log-endpoint.e2e-spec.ts` (real Postgres + Redis):
  - ADMIN gets the full history in order. SALES creates, PATCHes (including `taxId`) and submits.
    The processor is run with the fake provider (completed). ADMIN assigns, and the REVIEWER
    decides. The response has 200, the `items[].action` sequence `APPLICATION_CREATED,
    APPLICATION_UPDATED, APPLICATION_SUBMITTED, KYB_CHECK_COMPLETED, REVIEWER_ASSIGNED,
    DECISION_RECORDED`, and `createdAt` is non-decreasing. Each item has exactly the 8 allowed
    keys. The `KYB_CHECK_COMPLETED` item has `actorType: 'SYSTEM'`, `actorLabel: 'kyb-worker'`, and
    `actorId`/`actorRole` null. USER items carry the actor's id and role.
  - Masked meta: a row inserted directly with `AuditLogService.record` with
    `meta { taxId: RAW_TAX_ID, ownerEmail: RAW_OWNER_EMAIL, password: <fixture> }` is returned as
    `••••••<last4>`, `<first char>•••@example.com` and `[REDACTED]`. A row inserted by raw SQL
    (bypassing `record`, with resetApplicationData cleaning up afterwards) that has raw `taxId` and
    `ownerNationalId` is returned masked, which proves the read-side defence.
  - Pagination: seed N = 25 rows for one application (through `record`). The default request
    returns `limit 20`, `page 1`, `total 25` and 20 items. `?page=2&limit=20` returns 5 items. The
    pages are disjoint, and the ids of page 1 followed by page 2 equal
    `SELECT id FROM audit_logs WHERE entity_type = 'merchant_application' AND entity_id = $1 ORDER
    BY created_at, id` (not insertion order, because rows may share `created_at`). `?limit=100` → 200.
    `?page=999&limit=20` → 200 with `items: []` and `total 25`.
  - Caps and validation (400): `?limit=101`, `?limit=0`, `?page=0`, `?page=10001`, `?limit=abc`,
    `?entityType=user`, `?status=DRAFT`.
  - Denied: REVIEWER (the one assigned to the application) → 403 `FORBIDDEN_BODY`. SALES (the
    owner) → 403. No audit read is attempted: spy on `AuditLogQueryService.findApplicationHistoryPage`
    and assert it was not called.
  - No token → 401, and a tampered token → 401.
  - Unknown UUID (`00000000-0000-4000-8000-000000000004`) → 404 `NOT_FOUND_BODY`. The malformed
    ids `not-a-uuid` and `1' OR '1'='1` → 404 with the same body.
  - Isolation: two applications A and B, both with history. A's response contains only rows with
    `entityId` A (checked in the DB by id: every returned `id` belongs to a row with
    `entity_id = A`), and B's ids never appear. `total` counts A's rows only.
  - `user` rows excluded. `resetApplicationData` empties `audit_logs` in `beforeEach`, so the
    `beforeAll` logins leave nothing behind. The test therefore does all of this itself, after
    creating application A:
    - one fresh successful login (LOGIN_SUCCEEDED) and one failed login with a wrong password
      (LOGIN_FAILED);
    - one row inserted through `AuditLogService.record` with `entityType: 'user'` and
      `entityId: <A's id>` (USER actor, action `LOGIN_SUCCEEDED`). This proves the `entity_type`
      filter, not only the `entity_id` filter.

    It first asserts that these rows exist in the DB. Then it asserts that A's response contains
    neither that row's id nor any `LOGIN_SUCCEEDED`/`LOGIN_FAILED` action, and that `total` equals
    `SELECT count(*) FROM audit_logs WHERE entity_type = 'merchant_application' AND entity_id = A`
    (which is less than the count for `entity_id = A` alone).
  - Append-only untouched: the `audit_logs` row count is the same before and after the GETs, and
    each row's meta is byte-identical (the read never writes).
  - No leaks: no response text contains `RAW_TAX_ID`, `RAW_NATIONAL_ID`, `RAW_OWNER_EMAIL`,
    `RAW_OWNER_PHONE`, any access token, the fixture password, or `passwordHash`. The captured
    stdout/stderr/console text contains none of those values and no `Bearer ` token.
  - KYB final failure, if covered: run the processor until the retries are used up. The response
    contains both `KYB_CHECK_ATTEMPT_FAILED` (the final one) and `KYB_CHECK_FAILED`, both after
    `APPLICATION_SUBMITTED`. The test does not assert their order relative to each other.
  - Swagger: `GET /docs-json` → 200 (served because `setupSwagger(app, true)` ran before
    `app.init()`, Step 9). `paths['/applications/{id}/audit-logs'].get.responses` has the keys
    `200`, `400`, `401`, `403` and `404`.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2, 3 | src/audit/audit.enums.ts, src/audit/dto/audit-log-response.dto.ts, src/audit/dto/audit-log-response.dto.spec.ts, src/audit/audit-log-query.service.ts, src/audit/audit-log-query.service.spec.ts | — |
| B  | 4, 5, 6, 7 | src/applications/dto/list-audit-logs-query.dto.ts, src/applications/dto/list-audit-logs-query.dto.spec.ts, src/applications/applications.service.ts, src/applications/applications.service.spec.ts, src/applications/applications.controller.ts | A |
| Z  | 8, 9, 10 | src/audit/audit.module.ts, src/kyb/kyb-check.processor.ts, test/audit-log-endpoint.e2e-spec.ts | A, B |

`.env.example` is in no package (no new variables are needed).

## Security notes
- **No authz bypass:** the route has `@Roles(UserRole.ADMIN)`, and the service checks the role
  again before any DB work (wrong role → 403). The application is resolved only through the scoped
  `findAccessible` (unknown or malformed → 404). The audit query is keyed on the id that call
  returned, with the entity type hard-coded, so neither a path trick nor a query parameter can reach
  another entity's rows or the `user` LOGIN_* rows. No unscoped `findOne({ id })` is added.
- **Sensitive data in responses:** the items use an explicit allow-list and never spread the
  entity. `meta` is redacted and masked again on read through the same `buildAuditMeta` used on
  write, so raw `taxId`/`ownerNationalId`/`ownerEmail`/`ownerPhone` (and variants such as
  `oldTaxId`, `nationalId` or `ownerPhoneNumber`, because keys match by substring), passwords,
  hashes, tokens, credentials, private keys and Bearer/JWT-shaped values cannot be returned even
  from a bad row. `actorLabel` is returned only for SYSTEM rows whose label is in
  `KNOWN_SYSTEM_ACTOR_LABELS` (built from `KYB_WORKER_LABEL`); USER rows and unknown labels → null. `decision_note` is never in audit meta (that rule already
  holds at write time), and the e2e checks that the note marker is absent.
- **Never log sensitive data:** the new code logs nothing. The e2e checks the captured logs for
  raw values and tokens.
- **Append-only:** only `findAndCount` is used. `AuditLogService` stays insert-only, and the DB
  triggers still reject UPDATE/DELETE/TRUNCATE.
- **Fake data / no secrets:** test fixtures use `@example.com` and `FAKE` ids, and passwords come
  from `SEED_*` env via `ConfigService`.
- **Mass assignment:** the query DTO is whitelisted (page/limit only). `meta` is never accepted
  from a client.

## Risks / open questions
- **Order ASC vs DESC**, resolved as ASC (chronological history; stable pages while rows are
  appended). If a client wants newest first, that would be a later `order` parameter, not built
  here.
- **Equal `created_at` within one transaction (accepted):** the column defaults to `now()`, which
  is the transaction start time. `KybCheckProcessor.recordFinalFailure` writes
  `KYB_CHECK_ATTEMPT_FAILED` and then `KYB_CHECK_FAILED` in one transaction, so both get the same
  `created_at`. With the `id ASC` tie-break, the final failure is listed before its attempt about
  half the time. The order is stable across requests but not causal. No test asserts the order of
  rows from one transaction (see Tests).
  Follow-up (not in this task): change the `audit_logs.created_at` default to `clock_timestamp()`
  in a new migration, so rows inside one transaction get increasing timestamps.
- **Response omits `entityType`/`entityId`:** this is redundant with the path, and leaving them
  out keeps the allow-list minimal. Add them only if a client asks.
- **`actorId` of the actor is returned:** user UUIDs are not PII (database.md: UUIDs are not
  guessable), and ADMIN already sees `createdById`/`salesOwnerId`/`assignedReviewerId`. No name or
  email is joined in.
- **No transaction around the two reads:** applications are never deleted, and new audit rows
  appearing between the lookup and the page query only affect `total` by the rows just appended.
  This is acceptable for a history view.
- **Error bodies:** there is no global exception filter, so the Nest default bodies
  (`FORBIDDEN_BODY`, `NOT_FOUND_BODY`) are used, consistent with the other endpoints.

## Revision notes
### Revision 1 (plan review round 1)
- **Same-transaction ordering (blocker 1).** The old risk claimed that no transaction writes two
  rows, which is wrong: `recordFinalFailure` writes `KYB_CHECK_ATTEMPT_FAILED` and
  `KYB_CHECK_FAILED` together. This is now accepted and documented in Step 3 and Risks. A Tests
  rule forbids asserting the relative order of rows from one transaction; such tests assert only
  that both rows are present and come after earlier rows. An optional e2e case for the final KYB
  failure was added. The `clock_timestamp()` migration is listed as a follow-up.
- **LOGIN exclusion test (blocker 2).** The old test passed even with a broken filter, because
  `beforeEach` truncates `audit_logs` and login rows carry the user's id. It now does a fresh
  successful and failed login inside the test. It also records a row with `entityType: 'user'` and
  `entityId = A`. It asserts that none of them appear and that `total` equals the
  `merchant_application`-and-A count.
- **Swagger case (blocker 3).** The path is pinned to `/docs-json`. Step 9 now calls
  `setupSwagger(app, true)` before `app.init()`, and the test asserts that 200/400/401/403/404 are
  documented.
- **Idempotency claim corrected.** A stored bare `MASK` becomes 10 bullets on read. The unit
  fixtures for the idempotent case use masked values longer than 4 characters, and one case pins
  the 10-bullet result. The text now says the 8 KB cap cannot change a row that `record()` wrote.
- **Single source of the entity type.** Step 10 was added, and `src/kyb/kyb-check.processor.ts`
  joins package Z so that the KYB worker uses `MERCHANT_APPLICATION_ENTITY_TYPE`.
- **Pagination e2e.** The concatenated pages are compared with
  `SELECT id … ORDER BY created_at, id`, not with insertion order.
- **No import across modules.** The plan now states that `AuditLogListResponseDto` copies the
  `ApplicationListResponseDto` shape without importing it.

### Fix round (security review)
- **Read-side masking matched exact key names only (medium).** `src/common/mask.ts` now picks
  the masker by substring of the normalised key (`taxid`/`nationalid` → last 4, `email` → email
  mask, `phone` → last 3 digits); a non-string value under such a key is still `MASK`. This also
  tightens the write path. Unit cases in `mask.spec.ts` and read-side cases in
  `audit-log-response.dto.spec.ts` (`oldTaxId`, `ownerPhoneNumber`, `nationalId`).
- **Redact denylist gaps (low).** `src/common/redact.ts` adds `jwt|bearer|credential|privatekey`
  to the key pattern (bare `auth`, `otp`, `pin` are left out on purpose: `authorId`, `pinCode`,
  `shipping`). String values matching `/^Bearer\s/i` or the JWT shape are redacted under any key.
- **`actorLabel` returned uncleaned (low).** `toAuditLogResponse` returns the label only for a
  SYSTEM row whose label is in `KNOWN_SYSTEM_ACTOR_LABELS`; otherwise null. Unit cases plus one
  e2e case with a raw-SQL SYSTEM row carrying an unknown label.
- `docs/adrs/sensitive-data.md` records the substring matching and the value redaction.
