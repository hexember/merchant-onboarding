# Applications CRUD

## Goal
A committed migration creates `merchant_applications` (with its Postgres enums, FKs to `users` and
the three ADR indexes) exactly as docs/adrs/database.md specifies, and the schema-diff e2e test
stays green. A new `ApplicationsModule` serves `POST /applications`,
`GET /applications?status&page&limit`, `GET /applications/:id` and `PATCH /applications/:id` per
the docs/adrs/auth.md matrix. Every request-reachable application read goes through the scoped
`ApplicationsRepository` (`findAccessible(id, actor)` for single rows, the same scope for the list).
Out-of-scope and unknown IDs both get 404, wrong roles get 403. Responses mask `taxId`,
`ownerNationalId`, `ownerEmail` and `ownerPhone` and never include `meta` or `version`. Mass-assignment
fields are rejected with 400, SALES sending `salesOwnerId` on create gets 403, and ADMIN must name a
SALES user as `salesOwnerId` (otherwise 400). PATCH is allowed only in `DRAFT` / `INFO_REQUESTED`
(otherwise 409 with code `INVALID_STATE_TRANSITION`). `APPLICATION_CREATED` / `APPLICATION_UPDATED`
audit rows are written in the same transaction as the change. Integration tests cover the
SALES-vs-SALES bypass cases from docs/adrs/testing.md.

## Scope
- In:
  - `src/applications/`: enums, entity, editable-status check, DTOs (create, update, list query,
    response), scoped repository, service, controller, module, unit tests.
  - `src/users/users.repository.ts`: one new lookup, `existsWithRole(id, role)`, for the ADMIN
    `salesOwnerId` check.
  - Migration `1792800000002-CreateMerchantApplications.ts`, the migrations index, the entity list
    in `database.options.ts`, `AppModule` registration.
  - Test harness updates (`resetTables`, the migrations revert spec, the schema spec) and a new
    `test/applications.e2e-spec.ts`.
- Out:
  - The state machine / transition table, `POST /applications/:id/submit`, assign, transfer-owner,
    decision, audit-log endpoint (later backlog items).
  - `kyb_checks`, the `kybCheck` response block and its `label` (kyb-worker item).
  - A global exception filter (deliberately not reintroduced).
  - Writing the application's own `meta` column (it stays at its `'{}'` default; see Risks).
  - `.env.example` (no new env variables are needed; no package owns it).
  - New dependencies (none needed: TypeORM, class-validator, class-transformer, Swagger and
    supertest are installed).
  - README changes.

## ADR references
- docs/adrs/database.md (intro): UUID PK with `gen_random_uuid()`, every timestamp `timestamptz`,
  enums created as Postgres enums in the migration (`application_status`, `kyb_status`,
  `kyb_level`, `business_type`).
- docs/adrs/database.md §`merchant_applications`: every column with the listed type, length,
  nullability and default (`currency` default `NPR`, `kyb_attempts` 0, `submission_count` 0,
  `version` via `@VersionColumn`, `meta jsonb NOT NULL DEFAULT '{}'`). Money columns are `bigint`
  minor units. FKs `created_by_id`, `sales_owner_id`, `assigned_reviewer_id` → `users(id)`. Indexes
  `(sales_owner_id, created_at DESC)`, `(assigned_reviewer_id, status)`, `(status, created_at DESC)`.
  SALES create sets `created_by_id = sales_owner_id = actor.id`; ADMIN create sets
  `created_by_id = admin`, `sales_owner_id = dto.salesOwnerId`, and the service checks the target
  has role SALES.
- docs/adrs/database.md §`meta` columns: no DTO declares `meta`, so `forbidNonWhitelisted` rejects
  it (400). `meta` is never in a response. Audit `meta` goes through `AuditLogService.record()`,
  which redacts, masks and caps it; the plan only puts field names and status values in it.
- docs/adrs/database.md §`audit_logs`: audit row written with the transaction's `EntityManager`
  (`record(entry, manager)`), `actor_type USER`, `actor_id`/`actor_role` from the caller,
  `entity_type 'merchant_application'`, `entity_id` = application id.
- docs/adrs/workflow.md §1.1 / §1.3: initial values `status = DRAFT`, `kybStatus = NOT_STARTED`,
  `kybLevel = null`, `kybScore = null`. §1.2 "Operations that do not change status": `UPDATE` only in
  `DRAFT`, `INFO_REQUESTED` by owner SALES or ADMIN; anything else → 409 `INVALID_STATE_TRANSITION`.
  Implemented as a small `EDITABLE_STATUSES` check, not the full transition table.
- docs/adrs/auth.md §Authorization: role guard layer via `@Roles(...)` (REVIEWER on POST/PATCH →
  403); scoped data layer via `ApplicationsRepository.findAccessible(id, actor)` (SALES →
  `sales_owner_id = actor.id`, REVIEWER → `assigned_reviewer_id = actor.id`, ADMIN → no filter);
  out of scope = unknown = 404. The matrix rows for the four endpoints are followed exactly.
  DTO whitelist blocks `createdById`, `status`, `kybStatus`, `kybLevel`, `assignedReviewerId`;
  `salesOwnerId` is declared on the create DTO only and the service rejects it from SALES with 403;
  it is not declared on the update DTO, so PATCH with it → 400. Concurrency: PATCH uses a
  conditional `UPDATE ... WHERE version = :read AND status IN (editable)`.
- docs/adrs/sensitive-data.md: responses mask `taxId`/`ownerNationalId` with `maskLast4`,
  `ownerEmail` with `maskEmail`, `ownerPhone` with `maskPhone` (`src/common/mask.ts`), including the
  response to the creator right after the write. No raw sensitive value is logged or written to
  audit meta.
- docs/adrs/testing.md: integration bypass cases "SALES A cannot GET/PATCH SALES B's application by
  ID (404)", "SALES cannot set `salesOwnerId` on create (403)", "mass-assignment fields (`createdById`,
  `status`, `kybStatus`, `kybLevel`, and `salesOwnerId` on PATCH) are rejected (400)", "an
  application ID that does not exist → 404 (same response as out of scope)", "no token or a tampered
  token → 401". Policy/scoping logic gets unit tests. Submit-related cases belong to the
  submit-lifecycle item.
- .claude/rules/database.md: `synchronize: false`; a new migration, committed ones untouched;
  `bigint` money; state change + audit row in one transaction.
- .claude/rules/api.md: thin controller; DTO whitelist; never settable `createdById`, `status`,
  `kybStatus`, `kybLevel`, `kybScore`, `version`; masked responses.
- .claude/rules/typescript.md: one module per feature, constructor injection, explicit return types,
  class-validator DTO classes for body and query, no `any`/`!`, no `process.env`.

## ADR conflicts
None. The ADR text is followed as written. Two rule/doc mismatches already known from auth-login
are listed under Risks (api.md error-body shape; sensitive-data.md mentioning an exception filter);
this plan does not change them.

## Steps
1. `src/applications/application.enums.ts` — the shared contract:
   - `export enum ApplicationStatus { DRAFT, RISK_REVIEW, UNDER_REVIEW, INFO_REQUESTED, APPROVED, REJECTED }`
     (string values equal to the names), Postgres enum name `application_status`.
   - `export enum KybStatus { NOT_STARTED, PENDING, COMPLETED, FAILED }` → `kyb_status`.
   - `export enum KybLevel { LOW, MEDIUM, HIGH }` → `kyb_level` (the later `kyb_checks.level`
     reuses this type).
   - `export enum BusinessType { SOLE_PROPRIETORSHIP, PARTNERSHIP, PRIVATE_LIMITED, PUBLIC_LIMITED, NON_PROFIT }`
     → `business_type`.
   - Export the enum-name constants (`APPLICATION_STATUS_ENUM = 'application_status'`, etc.) so the
     entity and later entities share them.
2. `src/applications/application-status.ts` (+ `application-status.spec.ts`):
   `export const EDITABLE_STATUSES: readonly ApplicationStatus[] = [DRAFT, INFO_REQUESTED]` and
   `export function isEditable(status: ApplicationStatus): boolean`. A comment says the full
   transition table comes with the submit-lifecycle item and must absorb this.
3. `src/applications/merchant-application.entity.ts` — `@Entity('merchant_applications')`, class
   `MerchantApplication`:
   - `@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_merchant_applications' }) id`.
   - `createdById` (`created_by_id`, `uuid`), `salesOwnerId` (`sales_owner_id`, `uuid`),
     `assignedReviewerId` (`assigned_reviewer_id`, `uuid`, nullable) as plain `@Column`s, each
     paired with a `@ManyToOne(() => User, { nullable, onDelete: 'RESTRICT' })` +
     `@JoinColumn({ name, foreignKeyConstraintName })` relation property (`createdBy?`,
     `salesOwner?`, `assignedReviewer?`) that exists only so the migration gets the FK. Names:
     `FK_merchant_applications_created_by`, `FK_merchant_applications_sales_owner`,
     `FK_merchant_applications_assigned_reviewer`. Relations are never loaded (no `eager`).
   - `businessName`, `legalBusinessName` varchar(200); `businessType` enum `business_type`;
     `registrationNumber`, `taxId` varchar(50); `ownerFullName` varchar(200); `ownerEmail`
     varchar(254); `ownerPhone` varchar(30); `ownerNationalId` varchar(50);
     `merchantCategoryCode` `char(4)`; `websiteUrl` varchar(500) nullable.
   - `expectedMonthlyVolumeMinor`, `averageTicketSizeMinor`: `bigint` with an exported
     `bigintNumberTransformer` (`to: (v: number) => v`, `from: (v: string | null) => v === null ? null : Number(v)`)
     typed `number`. The DTO caps input at `Number.MAX_SAFE_INTEGER`, so the round trip is exact.
   - `currency` `char(3)` default `'NPR'`.
   - `status` enum `application_status` (no DB default; the service sets `DRAFT`), `kybStatus`
     (`kyb_status`) enum `kyb_status`, `kybLevel` (`kyb_level`) enum nullable, `kybScore`
     (`kyb_score`) smallint nullable, `kybAttempts` (`kyb_attempts`) smallint default 0,
     `kybLastAttemptAt` timestamptz nullable, `submissionCount` (`submission_count`) int default 0,
     `decisionNote` text nullable, `submittedAt`, `decidedAt` timestamptz nullable.
   - `@VersionColumn({ type: 'int' }) version`; `meta` jsonb `default: () => "'{}'"`
     `Record<string, unknown>`; `@CreateDateColumn`/`@UpdateDateColumn` timestamptz.
   - Indexes: `@Index('IDX_merchant_applications_reviewer_status', ['assignedReviewerId', 'status'])`.
     The two `DESC` indexes cannot be expressed by TypeORM's `@Index`, so they are declared with
     `{ synchronize: false }` (`IDX_merchant_applications_sales_owner_created`,
     `IDX_merchant_applications_status_created`) and written by hand in the migration (step 9);
     the schema builder then ignores them and the schema-diff test stays empty.
4. `src/applications/dto/create-application.dto.ts` (+ `create-application.dto.spec.ts`):
   `CreateApplicationDto` with `@ApiProperty` (fake examples only) and class-validator:
   - Required strings: `businessName`, `legalBusinessName`, `ownerFullName` (`@IsString @IsNotEmpty @MaxLength(200)`);
     `registrationNumber`, `taxId`, `ownerNationalId` (`@MaxLength(50)`); `ownerEmail`
     (`@IsEmail @MaxLength(254)`); `ownerPhone` (`@Matches(/^\+?[0-9][0-9 ()-]{5,28}$/) @MaxLength(30)`);
     `merchantCategoryCode` (`@Matches(/^\d{4}$/)`); `businessType` (`@IsEnum(BusinessType)`).
   - Money: `expectedMonthlyVolumeMinor`, `averageTicketSizeMinor`:
     `@IsInt @Min(0) @Max(Number.MAX_SAFE_INTEGER)`.
   - Optional: `websiteUrl` (`@ValidateIf((_, v) => v !== undefined && v !== null) @IsUrl({ protocols: ['http','https'], require_protocol: true }) @MaxLength(500)`,
     type `string | null`); `currency` (`@ValidateIf((_, v) => v !== undefined) @Matches(/^[A-Z]{3}$/)`,
     so `null` → 400 rather than a NOT NULL violation).
   - `salesOwnerId` is declared with `@Allow()` and **no format check**, and documented with
     `@ApiPropertyOptional({ type: String, format: 'uuid', description: 'ADMIN only; required for ADMIN, rejected (403) for SALES' })`.
     `forbidNonWhitelisted` rejects properties that have no class-validator decorator at all, so
     `@Allow()` keeps the key whitelisted. Its TypeScript type is `salesOwnerId?: unknown`, not
     `string`, because nothing checks the value's shape before the service. The service narrows it
     with `typeof === 'string'` (step 10). With no DTO format check, any value SALES sends
     (`null`, `'not-a-uuid'`, a number, a valid UUID) reaches the service and gets 403. For ADMIN
     the service does the validation and returns 400.
   - Not declared (→ 400 by `forbidNonWhitelisted`): `id`, `createdById`, `assignedReviewerId`,
     `status`, `kybStatus`, `kybLevel`, `kybScore`, `kybAttempts`, `submissionCount`, `version`,
     `meta`, timestamps, `decisionNote`.
5. `src/applications/dto/update-application.dto.ts` (+ `update-application.dto.spec.ts`):
   `UpdateApplicationDto` with the same editable fields and rules as create, minus `salesOwnerId`
   (so PATCH with it → 400 for every role). Every non-nullable field uses
   `@ValidateIf((_, v) => v !== undefined)` instead of `@IsOptional()`, because `@IsOptional()`
   lets `null` through and would hit a NOT NULL column (500). Only `websiteUrl` accepts `null`
   (clears it). Export `UPDATABLE_FIELDS: readonly (keyof UpdateApplicationDto)[]` used by the
   service to build the change set from present keys only.
6. `src/applications/dto/list-applications-query.dto.ts` (+ spec):
   `ListApplicationsQueryDto` — `status?` (`@IsOptional @IsEnum(ApplicationStatus)`), `page`
   (`@Type(() => Number) @IsInt @Min(1)`, default 1), `limit` (`@Type(() => Number) @IsInt @Min(1) @Max(100)`,
   default 20). Export `DEFAULT_PAGE_SIZE = 20`, `MAX_PAGE_SIZE = 100`. Unknown query keys → 400
   (global `forbidNonWhitelisted`).
7. `src/applications/dto/application-response.dto.ts` (+ `application-response.dto.spec.ts`):
   - `ApplicationResponseDto` (`@ApiProperty` on each field): `id`, `createdById`, `salesOwnerId`,
     `assignedReviewerId`, `businessName`, `legalBusinessName`, `businessType`,
     `registrationNumber`, `taxId` (masked), `ownerFullName`, `ownerEmail` (masked), `ownerPhone`
     (masked), `ownerNationalId` (masked), `merchantCategoryCode`, `websiteUrl`,
     `expectedMonthlyVolumeMinor`, `averageTicketSizeMinor`, `currency`, `status`, `decisionNote`,
     `submittedAt`, `decidedAt`, `createdAt`, `updatedAt`. No `meta`, `version`, KYB fields or
     `submissionCount` (see Risks).
   - `ApplicationListResponseDto { items: ApplicationResponseDto[]; page; limit; total }`.
   - `export function toApplicationResponse(app: MerchantApplication): ApplicationResponseDto`
     builds the object field by field (explicit allow-list, never a spread of the entity) and
     applies `maskLast4` / `maskEmail` / `maskPhone` from `src/common/mask.ts`.
8. `src/applications/applications.repository.ts` (+ `applications.repository.spec.ts`):
   `@Injectable() ApplicationsRepository` with `@InjectRepository(MerchantApplication)`. The only
   request-reachable reads:
   - `private scopedQuery(actor: AuthUser, manager?: EntityManager): SelectQueryBuilder<MerchantApplication>`:
     `switch (actor.role)` — SALES → `andWhere('app.sales_owner_id = :actorId', { actorId: actor.id })`,
     REVIEWER → `andWhere('app.assigned_reviewer_id = :actorId', { actorId: actor.id })`, ADMIN →
     no filter, `default` → `andWhere('1 = 0')`
     (fail closed for any future role). Uses `manager.getRepository(...)` when a manager is passed.
   - `findAccessible(id: string, actor: AuthUser, manager?: EntityManager): Promise<MerchantApplication | null>`:
     returns `null` without querying when `!isUUID(id)` (so `/applications/not-a-uuid` is 404, not a
     Postgres error), otherwise `scopedQuery(...).andWhere('app.id = :id', { id }).getOne()`.
   - `findAccessiblePage(actor: AuthUser, filter: { status?: ApplicationStatus; page: number; limit: number }): Promise<{ items: MerchantApplication[]; total: number }>`:
     scoped query, optional `andWhere('app.status = :status', { status })`, ordered by property
     paths `orderBy('app.createdAt', 'DESC').addOrderBy('app.id', 'DESC')` (TypeORM resolves
     property paths with `skip`/`take`; raw column names can break its pagination subquery),
     `skip((page-1)*limit).take(limit)`, `getManyAndCount()`.
   - Writes: `insert(values: NewApplication, manager: EntityManager): Promise<string>` (returns
     the new id) and
     `updateIfEditable(id: string, expectedVersion: number, changes: Partial<…editable fields…>, manager: EntityManager): Promise<boolean>`:
     `UPDATE merchant_applications SET <changes>, version = version + 1, updated_at = now() WHERE id = :id AND version = :expectedVersion AND status IN (:...EDITABLE_STATUSES)`;
     returns `affected === 1`. It is built with
     `manager.createQueryBuilder().update(MerchantApplication).set({ ...changes, version: () => 'version + 1', updatedAt: () => 'now()' })`.
     When `version` and `updatedAt` are set explicitly, TypeORM's automatic version/update-date
     handling skips them, so each appears exactly once in the SQL. The repository spec asserts the
     `set(...)` argument as written here and expects no extra auto-generated version clause. It is
     only called with an id that `findAccessible` returned in the same transaction, and the class
     comment says so. No other find method exists; there is no
     unscoped `findOne({ id })`.
9. `src/users/users.repository.ts` (+ `users.repository.spec.ts`): add
   `existsWithRole(id: string, role: UserRole): Promise<boolean>` — `false` for a non-UUID,
   otherwise `repository.exists({ where: { id, role } })` (`exists`, not the deprecated `exist`;
   selects nothing sensitive and returns no row). The parameter is typed `id: string`; the service
   only calls it after `typeof === 'string'`. Method comment: target-role check for ADMIN
   `salesOwnerId` (later also transfer/assign); never returns user data to a caller. Also update
   the class comment ("Only the lookups the seed and auth need…") so it lists the target-role check
   as the third allowed use, and say that there is still no general find-by-id.
10. `src/applications/applications.service.ts` (+ `applications.service.spec.ts`):
    `@Injectable() ApplicationsService(DataSource, ApplicationsRepository, UsersRepository, AuditLogService)`.
    - `create(dto, actor): Promise<ApplicationResponseDto>`:
      1. SALES and `dto.salesOwnerId !== undefined` (any value, including `null` and malformed) →
         `ForbiddenException()` before any DB work. This is the only place the SALES rule is
         enforced, because the DTO does no format check (step 4).
      2. ADMIN: `salesOwnerId` `undefined` or `null` → `BadRequestException('salesOwnerId is required')`;
         not a string, or `!(await users.existsWithRole(value, UserRole.SALES))` →
         `BadRequestException('salesOwnerId must be a SALES user')`. `existsWithRole` returns
         `false` for a non-UUID without querying, so a malformed id, an unknown UUID and a
         non-SALES user all get the same message.
      3. Any other role → `ForbiddenException()` (defence in depth; the guard already blocks REVIEWER).
      4. `dataSource.transaction(async (manager) => …)`: insert with `createdById = actor.id`,
         `salesOwnerId` (actor.id for SALES, dto value for ADMIN), `assignedReviewerId = null`,
         `status = DRAFT`, `kybStatus = NOT_STARTED`, `kybLevel = null`, `kybScore = null`,
         `currency = dto.currency ?? 'NPR'`, `websiteUrl = dto.websiteUrl ?? null`; then
         `audit.record({ actorType: USER, actorId, actorRole, action: APPLICATION_CREATED, entityType: 'merchant_application', entityId, meta: { status: 'DRAFT', salesOwnerId } }, manager)`;
         then re-read with `findAccessible(id, actor, manager)` and return `toApplicationResponse`.
    - `list(query, actor): Promise<ApplicationListResponseDto>` → `findAccessiblePage`, mapped.
    - `get(id, actor): Promise<ApplicationResponseDto>` → `findAccessible`; `null` →
      `NotFoundException('Application not found')`.
    - `update(id, dto, actor): Promise<ApplicationResponseDto>`:
      1. Build `changes` from `UPDATABLE_FIELDS` whose value is not `undefined`; empty →
         `BadRequestException('No fields to update')`.
      2. In a transaction: `findAccessible(id, actor, manager)`; `null` → 404 (same message as
         `get`).
      3. `!isEditable(app.status)` → `new ConflictException({ statusCode: 409, error: 'Conflict', message: 'Application can only be edited in DRAFT or INFO_REQUESTED', code: 'INVALID_STATE_TRANSITION' })`
         (Nest uses an object response as the whole body, so `statusCode`/`error` are spelled out).
      4. `updateIfEditable(id, app.version, changes, manager)`; `false` →
         `ConflictException({ statusCode: 409, error: 'Conflict', message: 'Application was changed by another request', code: 'CONCURRENT_MODIFICATION' })`.
      5. `audit.record({ …, action: APPLICATION_UPDATED, meta: { changedFields: Object.keys(changes).sort(), status: app.status } }, manager)`
         — field **names** only, never values.
      6. Re-read with `findAccessible(id, actor, manager)` and return the masked response.
    - Export the error messages/codes as constants so tests assert on them. No logging of DTOs.
11. `src/applications/applications.controller.ts`: thin controller, `@ApiTags('applications')`,
    `@ApiBearerAuth(SWAGGER_BEARER_AUTH_NAME)`, `@Controller('applications')`:
    - `@Post() @Roles(UserRole.ADMIN, UserRole.SALES)` → 201, `@ApiCreatedResponse({ type: ApplicationResponseDto })`.
    - `@Get() @Roles(ADMIN, REVIEWER, SALES)` with `@Query() query: ListApplicationsQueryDto`.
    - `@Get(':id') @Roles(ADMIN, REVIEWER, SALES)` with `@Param('id') id: string` (no
      `ParseUUIDPipe`: a malformed ID must be 404 like any unknown ID).
    - `@Patch(':id') @Roles(ADMIN, SALES)` → 200.
    - Each passes `@CurrentUser() actor: AuthUser` to the service. Swagger 400/401/403/404/409
      response decorators as applicable.
12. `src/applications/applications.module.ts`: imports `TypeOrmModule.forFeature([MerchantApplication])`,
    `UsersModule`, `AuditModule`; provides `ApplicationsRepository`, `ApplicationsService`;
    controller `ApplicationsController`. Exports `ApplicationsRepository` (later items reuse the
    scope).
13. `src/database/database.options.ts`: add `MerchantApplication` to `entities`.
14. `src/database/migrations/1792800000002-CreateMerchantApplications.ts`,
    `src/database/migrations/index.ts`:
    - Procedure (docs/plans/database-foundation.md step 13): with the dev DB at the latest
      migration (`npm run migration:run`), run
      `npm run migration:generate -- src/database/migrations/CreateMerchantApplications`, rename the
      file/class to `1792800000002-CreateMerchantApplications.ts` / `CreateMerchantApplications1792800000002`
      (`name` equal to the class name), and keep the generated statements verbatim: the four
      `CREATE TYPE`s, `CREATE TABLE "merchant_applications"` with `PK_merchant_applications`, the
      `IDX_merchant_applications_reviewer_status` index, and the three `ALTER TABLE ... ADD CONSTRAINT FK_...`.
      If the generator emits anything touching `users` or `audit_logs`, stop and report it.
    - Hand-written additions at the end of `up()`:
      `CREATE INDEX "IDX_merchant_applications_sales_owner_created" ON "merchant_applications" ("sales_owner_id", "created_at" DESC)`
      and `CREATE INDEX "IDX_merchant_applications_status_created" ON "merchant_applications" ("status", "created_at" DESC)`.
    - `down()` in reverse: drop the two hand-written indexes, the FKs, the generated index, the
      table, then the four types.
    - Index: append `CreateMerchantApplications1792800000002` after `CreateAuditLogs1792800000001`.
    - Check: generate again → "No changes in database schema were found"; revert once + run.
      If the dev DB is not at the latest migration or has unexpected tables, stop and ask; never
      drop the dev volume.
15. `src/app.module.ts`: import `ApplicationsModule`.
16. `test/utils/test-db.ts`: `resetTables` truncates `"audit_logs", "merchant_applications", "users"`
    (FKs require `merchant_applications` in the same TRUNCATE). Add
    `resetApplicationData(ds)`: same trigger-disable pattern, `TRUNCATE TABLE "audit_logs", "merchant_applications"`
    (keeps users, so the applications spec logs in once).
17. `test/migrations.e2e-spec.ts`: undo three migrations; assert `merchant_applications` is gone
    and the four new types (`application_status`, `kyb_status`, `kyb_level`, `business_type`) are
    gone alongside the existing checks; re-run restores all three tables.
    `test/database.e2e-spec.ts`: add enum-value checks for `application_status` and
    `business_type`; the existing schema-diff test now covers the new entity.
18. `test/applications.e2e-spec.ts`: see Tests.

## Tests
- Unit (`npm run test`):
  - `application-status.spec.ts`: `isEditable` true for `DRAFT`, `INFO_REQUESTED`; false for
    `RISK_REVIEW`, `UNDER_REVIEW`, `APPROVED`, `REJECTED` (table-driven over every enum value, so a
    new status fails the test until classified).
  - `create-application.dto.spec.ts` (`plainToInstance` + `validate` with
    `{ whitelist: true, forbidNonWhitelisted: true }`): valid body passes; each required field
    missing → error; `merchantCategoryCode` `'541'`/`'54a1'` → error; negative, fractional and
    `> MAX_SAFE_INTEGER` amounts → error; `currency` `'npr'`/`null` → error; malformed `ownerEmail`
    and `ownerPhone` → error; `businessName` of 201 chars → error; `websiteUrl` `ftp://…` and no
    protocol → error, `null` passes; `salesOwnerId` `null`, `'not-a-uuid'` and a valid UUID each
    produce **no** validation error (the key is whitelisted and the service decides); **denied:**
    `createdById`, `status`, `kybStatus`, `kybLevel`, `kybScore`, `version`, `meta`,
    `assignedReviewerId` each → whitelist error.
  - `update-application.dto.spec.ts`: `{}` passes validation (service rejects it); single field
    passes; `null` for `businessName`/`taxId`/`currency` → error; `websiteUrl: null` passes;
    **denied:** `salesOwnerId`, `createdById`, `status`, `kybStatus`, `kybLevel`, `meta` → whitelist
    error.
  - `list-applications-query.dto.spec.ts`: defaults `page=1`, `limit=20`; string `'2'` → 2;
    `status=BOGUS`, `page=0`, `page=abc`, `limit=0`, `limit=101`, `limit=1.5` → error;
    `limit=100` passes.
  - `application-response.dto.spec.ts`: `taxId` `'PAN-FAKE-00001234'` → `'••••••1234'`,
    `ownerNationalId` last 4, `ownerEmail` → `'o•••@example.com'`, `ownerPhone` → `'••••••123'`;
    no `meta`, `version`, `kybStatus` or relation keys in the output (exact key list asserted);
    `websiteUrl` `null` stays `null`; amounts are numbers.
  - `applications.repository.spec.ts` (mocked query builder): `findAccessible('not-a-uuid', …)` →
    `null` and no query built; SALES adds `sales_owner_id = :actorId` with the actor id;
    REVIEWER adds `assigned_reviewer_id = :actorId`; ADMIN adds no scope clause; an unknown role
    adds `1 = 0`; `findAccessiblePage` applies the same scope, the status filter only when given,
    `created_at DESC, id DESC`, `skip`/`take` from page/limit; `updateIfEditable` includes the
    version and editable-status conditions and returns `false` when `affected` is 0.
  - `applications.service.spec.ts` (mocked repo, users repo, audit, `DataSource.transaction`
    calling back with a fake manager): **denied:** SALES with `salesOwnerId` (own id, other id,
    `null`, `'not-a-uuid'`, `123`) → `ForbiddenException`, `transaction` and `existsWithRole` never
    called; ADMIN without `salesOwnerId` and with `null` → `BadRequestException` "salesOwnerId is
    required"; ADMIN with a non-string (`123`) → `BadRequestException` and `existsWithRole` not
    called; ADMIN with `'not-a-uuid'`, or a target where `existsWithRole` → `false` →
    `BadRequestException` "salesOwnerId must be a SALES user";
    REVIEWER → `ForbiddenException`. Allowed: SALES create sets `createdById = salesOwnerId =
    actor.id`, status `DRAFT`, `kybStatus NOT_STARTED`; ADMIN create sets `createdById = admin`,
    `salesOwnerId = target`; audit `record` gets `APPLICATION_CREATED` and the transaction manager;
    an audit failure rejects the call. `get`/`update` with `findAccessible` → `null` →
    `NotFoundException`. `update`: empty dto → `BadRequestException` before any lookup;
    `UNDER_REVIEW` → `ConflictException` whose response has `code: 'INVALID_STATE_TRANSITION'` and
    no write/audit; `updateIfEditable` → `false` → `ConflictException` `CONCURRENT_MODIFICATION`;
    success audits `APPLICATION_UPDATED` with sorted `changedFields` and no field values.
  - `users.repository.spec.ts`: `existsWithRole('not-a-uuid', SALES)` → `false` with no query;
    a UUID calls `exists({ where: { id, role } })` and returns its result.
- Integration (`test/applications.e2e-spec.ts`, real Postgres, Supertest). Users inserted in
  `beforeAll` (after `resetTables`) from `SEED_*` passwords hashed once: `sales-a@example.com`,
  `sales-b@example.com` (both `SEED_SALES_PASSWORD`), `reviewer@example.com`,
  `reviewer-2@example.com` (`SEED_REVIEWER_PASSWORD`), `admin@example.com`
  (`SEED_ADMIN_PASSWORD`); tokens via `POST /auth/login` once in `beforeAll`;
  `resetApplicationData` in `beforeEach`. Fake payload only (`owner@example.com`,
  `PAN-FAKE-00001234`, `NID-FAKE-5678`, `+977-0000000123`, MCC `5411`). States the API cannot
  reach yet (assigned reviewer, non-DRAFT statuses) are set with test-only SQL, commented as such.
  - POST: SALES A creates → 201, masked body, `status DRAFT`, `createdById = salesOwnerId = A`, no
    `meta`/`version` keys; DB row holds the full `tax_id`; one audit row `APPLICATION_CREATED`
    (USER, SALES, entity id) whose meta has no raw sensitive value. ADMIN creates for SALES B →
    201, `createdById = admin`, `salesOwnerId = B`; B can GET it, A gets 404.
  - **Denied POST:** SALES with `salesOwnerId` set to its own id, to B's id, to `null` and to
    `'not-a-uuid'` → 403 each, no row, no audit; REVIEWER → 403; ADMIN without `salesOwnerId` →
    400; ADMIN with `salesOwnerId: null` → 400; ADMIN with `'not-a-uuid'` → 400; ADMIN with the
    reviewer's id → 400; ADMIN with an unknown UUID → 400 (every ADMIN case: no row, no audit);
    mass-assignment `createdById`, `status`, `kybStatus`, `kybLevel`,
    `kybScore`, `assignedReviewerId`, `version`, `meta` → 400 each, no row; invalid MCC / negative
    amount → 400; no token → 401; tampered token → 401.
  - GET list: SALES A sees only A's (B's absent, `total` counts only A's); REVIEWER sees only rows
    assigned to them, `reviewer-2` sees none; ADMIN sees all; `?status=INFO_REQUESTED` filters;
    `page=2&limit=1` returns the second-newest and correct `total`; items masked.
    **Denied/invalid:** `status=BOGUS`, `limit=0`, `limit=101`, `page=0`, unknown param `foo=1` →
    400.
  - GET by id: **SALES A → B's application → 404**, and the body equals the body for a random
    unknown UUID and for `/applications/not-a-uuid` (all 404, identical); assigned REVIEWER → 200;
    **non-assigned REVIEWER → 404**; ADMIN → 200; no token → 401.
  - PATCH: SALES owner in `DRAFT` → 200, field changed, masked response, DB `version` 1 → 2, audit
    `APPLICATION_UPDATED` with `changedFields` and no values; `INFO_REQUESTED` → 200; ADMIN on
    B's application → 200; `websiteUrl: null` clears it.
  - **Denied PATCH:** **SALES A → B's application → 404**, and its body equals the body of a PATCH
    to a random unknown UUID; B's row and audit unchanged; unknown UUID → 404; REVIEWER (even assigned) → 403; `RISK_REVIEW`, `UNDER_REVIEW`, `APPROVED`,
    `REJECTED` → 409 with body `{ statusCode: 409, error: 'Conflict', message, code: 'INVALID_STATE_TRANSITION' }`,
    row unchanged, no audit; mass-assignment `salesOwnerId` (from SALES and from ADMIN),
    `createdById`, `status`, `kybStatus`, `kybLevel`, `assignedReviewerId` → 400; empty body → 400;
    `businessName: null` → 400.
  - Same transaction: `jest.spyOn(app.get(AuditLogService), 'record').mockRejectedValueOnce(...)`
    on POST → 500 and zero application rows; on PATCH → 500 and the row unchanged. Restore the spy.
  - No leaks: stdout/stderr captured (as in `test/auth.e2e-spec.ts`), every response body and
    `audit_logs` rows never contain the raw `taxId`, `ownerNationalId`, `ownerEmail`, `ownerPhone`
    or a token.
  - Swagger: `/docs-json` lists the four operations with the `bearer` security requirement.
  - Out of this task (later items): submit, transfer, assign, decide bypass cases.
- `test/migrations.e2e-spec.ts`, `test/database.e2e-spec.ts`: as in step 17.
- Gate: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:e2e`.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1–7   | src/applications/application.enums.ts, src/applications/application-status.ts, src/applications/application-status.spec.ts, src/applications/merchant-application.entity.ts, src/applications/dto/create-application.dto.ts, src/applications/dto/create-application.dto.spec.ts, src/applications/dto/update-application.dto.ts, src/applications/dto/update-application.dto.spec.ts, src/applications/dto/list-applications-query.dto.ts, src/applications/dto/list-applications-query.dto.spec.ts, src/applications/dto/application-response.dto.ts, src/applications/dto/application-response.dto.spec.ts | — |
| B  | 9     | src/users/users.repository.ts, src/users/users.repository.spec.ts | — |
| C  | 8, 10, 11, 12 | src/applications/applications.repository.ts, src/applications/applications.repository.spec.ts, src/applications/applications.service.ts, src/applications/applications.service.spec.ts, src/applications/applications.controller.ts, src/applications/applications.module.ts | A, B |
| Z  | 13–18 | src/database/database.options.ts, src/database/migrations/1792800000002-CreateMerchantApplications.ts, src/database/migrations/index.ts, src/app.module.ts, test/utils/test-db.ts, test/migrations.e2e-spec.ts, test/database.e2e-spec.ts, test/applications.e2e-spec.ts | A, B, C |

A and B run in parallel. Z generates the migration from A's entity and runs the full gate; if a
failure comes from an A/B/C file, Z reports it instead of editing that file. `.env.example` belongs
to no package and needs no change.

## Security notes
- **No authz bypass:** the only request-reachable application reads are
  `ApplicationsRepository.findAccessible` and `findAccessiblePage`, both built on one
  `scopedQuery(actor)` (SALES → `sales_owner_id`, REVIEWER → `assigned_reviewer_id`, ADMIN → all,
  unknown role → no rows). There is no unscoped `findOne({ id })`. The write path
  (`updateIfEditable`) is only called with an id just returned by `findAccessible` in the same
  transaction, and its version condition means nothing changed in between. Out of scope, unknown
  and malformed IDs all return the same 404. Wrong role → 403 via `@Roles`. Decisions are not part
  of this task.
- **Mass assignment:** DTO allow-lists plus `forbidNonWhitelisted`; `salesOwnerId` only on create
  and only honoured for ADMIN. SALES gets 403 for any value, because the DTO has no format check
  that could turn it into 400 first. PATCH with it → 400. No DTO accepts `meta`.
- **Sensitive data:** responses built by an explicit field list with the shared mask helpers, also
  for the creator right after the write. Audit meta holds only field names, status and the owner
  id (passed through `record()`'s redact + mask + cap anyway). The service logs nothing about the
  payload. E2E asserts no raw value reaches stdout/stderr, responses or `audit_logs`.
- **No secrets in git:** test passwords come from `SEED_*` env via `ConfigService`; no literals.
- **Fake data only:** `@example.com` emails, made-up names and `FAKE` IDs.
- **Transactions:** application insert/update and its audit row share one `EntityManager`; the
  e2e spy test proves a failed audit write rolls the change back.

## Risks / open questions
- **Error body shape (api.md mismatch, carried over from auth-login):** `.claude/rules/api.md` says
  a global filter maps errors to `{ statusCode, error, message, code }`; there is no filter. The 409s
  build that shape by hand inside `ConflictException`; other errors are Nest defaults (no `code`).
  The user should update the rule or add a filter item.
- **Required fields on create (default taken):** the ADR marks every column except `website_url`
  (and the server-managed ones) NOT NULL, so create requires all of them. A partial "draft" with
  missing fields would need nullable columns and a completeness check on submit; not done.
- **Response shape (default taken):** KYB fields (`kybStatus`, `kybLevel`, `kybScore`, attempts),
  `submissionCount`, `version` and `meta` are not returned; the kyb-worker item adds the `kybCheck`
  block from workflow.md §1.4. `ownerFullName` is PII but not in the ADR's mask list, so it is
  returned in full.
- **List response envelope (default taken):** `{ items, page, limit, total }`, default limit 20,
  max 100, newest first. The ADR names only the query parameters.
- **Validation formats (default taken):** MCC `^\d{4}$`; currency any 3 uppercase letters (default
  `NPR`, not restricted to it); phone `^\+?[0-9][0-9 ()-]{5,28}$`; `websiteUrl` http/https only;
  amounts integers `0..MAX_SAFE_INTEGER`. No DB CHECK constraints are added for these (the ADR lists
  none). Owner email is stored as sent (not lowercased).
- **Empty PATCH body → 400 (default taken)** instead of a no-op 200 without an audit row.
- **Concurrent PATCH:** a lost race returns 409 with code `CONCURRENT_MODIFICATION`, a code the ADRs
  do not name (they only say "409"). The status-check race returns `INVALID_STATE_TRANSITION` only
  when detected before the write; if the status changed between read and write the client gets
  `CONCURRENT_MODIFICATION`. The submit-lifecycle item should settle the codes.
- **`salesOwnerId` from SALES, any value → 403 (orchestrator decision, review round 1):** the DTO
  whitelists the key with `@Allow()` and does no format check. So `null`, a malformed string, a
  non-string and a valid UUID from SALES all reach the service and get 403, never 400. The cost:
  for ADMIN, format errors on this one field come from the service ("salesOwnerId must be a SALES
  user"), not from the ValidationPipe's message list, and Swagger's `format: 'uuid'` is
  documentation only. If the body also has another invalid field, the ValidationPipe still
  returns 400 first, for every role.
- **`kybCheck` block deferred:** the `kybCheck` progress block from docs/adrs/workflow.md §1.4
  (with the derived `label`) is not returned by `GET /applications/:id` yet. The kyb-worker
  backlog item adds it.
- **Target-user check vs FK race:** `existsWithRole` runs before the transaction; if the target is
  deleted in between, the FK fails and the request gets a 500. Users are seed-only and cannot be
  deleted through the API, so this is accepted.
- **Application `meta`:** left at `'{}'`. The ADR example (`source`, `requestId`) would need a
  request-id source that does not exist yet.
- **Malformed `:id` → 404** (no `ParseUUIDPipe`), so malformed and unknown IDs are
  indistinguishable, matching the ADR's 404 rule.
- **`DESC` indexes with `synchronize: false`:** declared in the entity for documentation but
  maintained only by the migration. If the schema-diff test still reports a diff, Z regenerates
  rather than editing the assertion, and reports anything it cannot resolve.
- **`docs/adrs/sensitive-data.md` line 6** still mentions an exception filter (known, not touched).
- **Environment:** no new env variables. `test:e2e` needs the existing `SEED_*`, `DB_NAME_TEST` and
  `JWT_SECRET` values in `.env`; if missing, report the e2e run as skipped, not passed.

## Revision notes
- **Revision 1 (review round 1, CHANGES_REQUESTED):**
  - Blocker, `salesOwnerId` from SALES returned 400 instead of 403 (step 4, step 10, Tests,
    Risks): the global ValidationPipe runs before the service, so `@IsUUID()` turned `null` or a
    malformed value from SALES into 400. Following the orchestrator's decision, the create DTO
    now declares `salesOwnerId` with `@Allow()` only (whitelisted, no format check; TS type
    `unknown`, Swagger `type: String, format: 'uuid'`). Any value from SALES reaches the service
    and gets 403. For ADMIN the service returns 400: "salesOwnerId is required" for missing or
    `null`, and "salesOwnerId must be a SALES user" for a non-string, a non-UUID
    (`existsWithRole` → `false` without querying), an unknown id or a non-SALES user. New e2e
    cases: SALES with `null` → 403, SALES with `'not-a-uuid'` → 403, ADMIN with `null` → 400, ADMIN
    with `'not-a-uuid'` → 400, each with no row and no audit. The unit tests were updated to
    match, and the DTO spec now expects no error for these values. The default is recorded under
    Risks.
  - Step 8: `scopedQuery` binds `{ actorId: actor.id }` explicitly; `findAccessible` binds
    `{ id }`; the status filter binds `{ status }`.
  - Step 8: `findAccessiblePage` orders by property paths `app.createdAt`, `app.id`.
  - Step 8: `updateIfEditable` sets `version: () => 'version + 1'` and `updatedAt: () => 'now()'`
    explicitly. The repository spec asserts exactly that `set(...)` and expects no duplicate
    auto-generated version clause.
  - Step 9 / Tests: `exists({ where: { id, role } })` replaces the deprecated `exist`. The
    `UsersRepository` class comment is updated to name the target-role check.
  - Tests: the PATCH SALES A → B 404 body must equal the unknown-UUID PATCH 404 body.
  - Risks: the `kybCheck` block (workflow.md §1.4) is noted as deferred to the kyb-worker item.
- **Fix round (security review):**
  - `page` is capped with `@Max(MAX_PAGE)` (`MAX_PAGE = 10000`, exported), so `?page=1e20` gets
    400 instead of a 500 from `OFFSET 2e+21`, and OFFSET scans stay bounded. Unit cases: 10000
    ok, 10001 and 1e20 rejected; e2e: `?page=1e20` → 400.
  - `updateIfEditable(id, expectedVersion, changes, actor, manager)` repeats the actor's scope in
    the UPDATE (`sales_owner_id = :actorId` for SALES, `assigned_reviewer_id = :actorId` for
    REVIEWER, nothing for ADMIN, `1 = 0` for any other role). Reads and the update share one
    private `applyScope` helper. The class comment states that every write to an ownership or
    assignment column must bump `version`. Repository and service specs assert this per role.
  - `taxId` and `ownerNationalId` require `@MinLength(MIN_ID_LENGTH)` (`MIN_ID_LENGTH = 8`,
    exported) in the create and update DTOs, so the last-4 mask hides at least half the value.
    `mask.ts` is unchanged. Unit cases: 7 characters rejected, 8 accepted.
  - The fixture and Swagger example phone is now `+977-0000000123` (not a real mobile format).
