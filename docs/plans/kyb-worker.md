# KYB worker

## Goal
Once this lands, every SUBMIT (first submit and resubmit) enqueues one BullMQ job **after the
transaction commits**. The job has `jobId = kyb-check:{applicationId}:{n}`, `attempts = 5` and
`backoff = { type: 'exponential', delay: 2000 }`. If the enqueue fails, the request still succeeds
and the failure is logged without PII; this is the trade-off kyb-check.md already documents (no
outbox). A system-only worker (`KybCheckProcessor`, actor `SYSTEM` / `kyb-worker`) carries out the
idempotent flow from docs/adrs/kyb-check.md:
1. Stale check.
2. Existing-row check.
3. Increment `kyb_attempts` and set `kyb_last_attempt_at`, then call the injectable `KybProvider`.
4. A failed attempt writes a `KYB_CHECK_ATTEMPT_FAILED` audit row and rethrows.
5. On success, one transaction does `INSERT kyb_checks ... ON CONFLICT (application_id, submission_no) DO NOTHING`,
   a conditional `UPDATE` to `UNDER_REVIEW` / `COMPLETED` and a `KYB_CHECK_COMPLETED` audit row.
6. On the final failed attempt, the application moves to `UNDER_REVIEW` / `FAILED` and a
   `KYB_CHECK_FAILED` audit row is written. This happens whether the last attempt failed on a
   provider error or on a failed success transaction.

A new `kyb_checks` table (migration `1792800000003`) has `UNIQUE (application_id, submission_no)`.
The provider is a `SimulatedKybProvider` in the app and a deterministic `FakeKybProvider` in tests.
`GET /applications/:id` gains the `kybCheck` block from workflow.md §1.4. Its `label` is derived
in the response DTO and is not stored. No HTTP route can trigger `KYB_COMPLETE`.

## Scope
- In:
  - Dependencies `bullmq` and `@nestjs/bullmq`.
  - New env variables in `validateEnv`: `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`,
    `KYB_WORKER_ENABLED`, `KYB_FAILURE_RATE`, `KYB_SCORE_MEDIUM_MIN`, `KYB_SCORE_HIGH_MIN`.
  - New feature module `src/kyb/`: entity, provider interface, simulated provider, test fake,
    level mapping, job contract, producer, worker-only repository, processor, module.
  - Migration `1792800000003-CreateKybChecks.ts` and its registration.
  - `ApplicationsService.submit` enqueues after the commit. `GET /applications/:id` returns the
    `ApplicationDetailResponseDto` with `kybCheck`.
  - `BullModule.forRootAsync` in `AppModule`. `ApplicationsModule` imports `KybModule`.
  - Test harness: queue prefix per run, worker off by default in e2e, `kyb_checks` added to the
    truncate helpers. New `test/kyb-worker.e2e-spec.ts`.
- Out:
  - Any ADR edit (no conflict; docs/adrs/testing.md is satisfied as written).
  - Transactional outbox or sweeper (documented trade-off; not built).
  - Any endpoint that triggers, retries or reads raw KYB checks.
  - `kybCheck` on the list, create, PATCH or submit responses: the ADR names only
    `GET /applications/:id` (default taken, see Risks).
  - Assign, transfer and decision endpoints. The APPROVE guard question is left to the
    reviewer-decision item.
  - A global exception filter (not added). Bull Board or any other queue UI. A Redis password or TLS.
  - `.env.example`: no package owns it. The lines the user should add by hand are listed under Risks.
  - README changes.

## ADR references
- docs/adrs/kyb-check.md
  - *Enqueue after commit*: `ApplicationsService.submit` calls `KybCheckQueue.enqueue(id, n)`
    only after `dataSource.transaction(...)` resolves, using the `submissionNo` read back from the
    row.
  - *Job options*: `jobId = kyb-check:{applicationId}:{n}`, `attempts: 5`,
    `backoff: { type: 'exponential', delay: 2000 }`. These are fixed constants, not env settings,
    because the ADR fixes them.
  - *Step 1 (stale)*: no row, `submission_count != n` or `status != RISK_REVIEW` → ack, no work.
  - *Step 2 (existing row)*: a `kyb_checks` row for `(id, n)` already exists → ack.
  - *Step 3 (attempt)*: `kyb_attempts + 1` and `kyb_last_attempt_at = now()` are written (guarded)
    **before** the provider call. On a failed attempt the worker writes `KYB_CHECK_ATTEMPT_FAILED`
    and rethrows, so BullMQ schedules the retry.
  - *Step 4 (success)*: one transaction runs the `INSERT ... ON CONFLICT (application_id, submission_no) DO NOTHING`,
    the conditional `UPDATE ... WHERE id=? AND submission_count=n AND status='RISK_REVIEW'` and the
    `KYB_CHECK_COMPLETED` audit row (`actor_type=SYSTEM`).
  - *Step 5 (final failure)*: `UNDER_REVIEW` + `FAILED` under the same `WHERE` guard, plus
    `KYB_CHECK_FAILED`.
  - *Three layers of idempotency*: the job ID, the stale check, and the unique constraint backed by
    the conditional `UPDATE`.
  - *Provider*: injectable `KybProvider`, a simulated provider (MCC and volume plus randomness, with
    a configurable failure rate), and a deterministic fake in tests.
- docs/adrs/database.md §`kyb_checks`: columns `id`, `application_id`, `submission_no`,
  `provider_reference`, `score` (smallint, 0–100), `level` (reuses the `kyb_level` enum), `reasons`
  jsonb (no PII), `meta` jsonb default `'{}'`, `created_at` timestamptz, and
  `UNIQUE (application_id, submission_no)`.
- docs/adrs/database.md §`meta` columns: `kyb_checks.meta` holds only server-written fixed fields
  (`providerVersion`, `latencyMs`, `attempt`), passed through `buildAuditMeta` (redact, mask,
  8 KB cap). It is never returned.
- docs/adrs/database.md §`audit_logs`: SYSTEM rows have `actor_id = null`, `actor_role = null` and
  `actor_label = 'kyb-worker'`. Each state change and its audit row share one transaction.
- docs/adrs/workflow.md §1.2: `KYB_COMPLETE` (`RISK_REVIEW → UNDER_REVIEW`) is system only. The
  worker gets the target status from `nextSystemStatus(RISK_REVIEW, KYB_COMPLETE)`, so the
  transition table stays the single source. The guard "job's `submission_no` = current
  `submission_count`" is the `WHERE` clause. There is no HTTP endpoint.
- docs/adrs/workflow.md §1.3: `COMPLETED` comes with `LOW` / `MEDIUM` / `HIGH` from the score
  thresholds in config (`KYB_SCORE_MEDIUM_MIN`, `KYB_SCORE_HIGH_MIN`). `FAILED` comes with level
  `null`.
- docs/adrs/workflow.md §1.4: `kybCheck { status, level, label, score, attempts, lastAttemptAt }`
  on `GET /applications/:id`. The label mapping is `LOW → "Good to go"`, `MEDIUM → "Fair deal"`,
  `HIGH → "Needs double check"`, `null → null`, computed in the DTO and not stored.
- docs/adrs/testing.md
  - Unit: the `kybLevel → label` mapping (including `null`), and worker idempotency (duplicate job,
    stale job, retry, final failure).
  - Integration: KYB success, retry then success, and retries used up → `UNDER_REVIEW` + `FAILED`.
  - Determinism: a deterministic fake `KybProvider`.
- docs/adrs/sensitive-data.md: the provider input carries no PII (MCC, volume, ticket size and
  business type only). Logs go through `logInfo` / `logError` with ids, counters and the error only.
  Masking of the response is unchanged.
- docs/adrs/auth.md: `GET /applications/:id` keeps its scoped `findAccessible` lookup. The worker is
  not a user, so it does not use `applyScope`. It uses a separate worker-only repository that
  `KybModule` never exports.
- .claude/rules/queue.md: enqueue only after commit, job ID format, stale skip, unique constraint as
  the final guard, worker is the only `RISK_REVIEW → UNDER_REVIEW` actor and audits as SYSTEM, and
  the provider is called only from the processor.
- .claude/rules/database.md: new migration, no edit to an existing one, `synchronize: false`, meta
  rules, and state change plus audit row in one transaction.
- .claude/rules/typescript.md: no `process.env` outside config and test setup, constructor
  injection (the provider and the random source come in by injection tokens), explicit return
  types, and no `any` or `!`.
- .claude/rules/testing.md: fake provider, no sleeps, the single Redis wait is bounded by a timeout.
- .claude/rules/general.md: two new dependencies, justified (BullMQ is the queue the ADR names, and
  `@nestjs/bullmq` gives the Nest DI/lifecycle integration). No other dependency.

## ADR conflicts
None. docs/adrs/testing.md's "KYB processing end to end (success, retry then success, retries used
up → UNDER_REVIEW + FAILED)" on real Postgres + Redis is met as written. All three paths run
through real Redis with the shipped job options. The backoff wait is skipped by promoting the
delayed job (`job.promote()`), not by changing the options. The handler-direct cases are extra
coverage.

## Steps
1. `package.json`, `package-lock.json`: add `"bullmq": "^5"` and `"@nestjs/bullmq": "^11"` to
   `dependencies` (through `npm install`, so the lock file matches). Nothing else changes.
2. `src/config/env.validation.ts` (+ `env.validation.spec.ts`): extend `AppEnv` and `validateEnv`.
   Every error names the variable and never the value. Use the existing helpers where they fit:
   - `REDIS_HOST: string`: `readRequiredString` (required, like `DB_HOST`).
   - `REDIS_PORT: number`: `readPort`, default `6379`.
   - `QUEUE_PREFIX: string`: optional, default `'bull'`. Must match `/^[A-Za-z0-9_-]{1,50}$/`
     (no `:`, which BullMQ uses as its key separator). New helper `readPattern(raw, name, pattern, default, invalid)`.
   - `KYB_WORKER_ENABLED: boolean`: `readBoolean`, default `true`.
   - `KYB_FAILURE_RATE: number`: new helper `readRate(raw, name, default, invalid)`. A decimal
     string or number in `[0, 1]`, default `0.2`. Rejects `NaN`, negatives, values above 1 and
     non-numeric text.
   - `KYB_SCORE_MEDIUM_MIN: number`, `KYB_SCORE_HIGH_MIN: number`: new helper
     `readIntInRange(raw, name, default, min, max, invalid)` with `0..100`, defaults `40` and `70`.
     After both are read, if `MEDIUM_MIN >= HIGH_MIN`, push `KYB_SCORE_HIGH_MIN`.
   - Export `DEFAULT_REDIS_PORT`, `DEFAULT_QUEUE_PREFIX`, `DEFAULT_KYB_FAILURE_RATE`,
     `DEFAULT_KYB_SCORE_MEDIUM_MIN`, `DEFAULT_KYB_SCORE_HIGH_MIN` for the tests.
3. `src/kyb/kyb-job.ts` (+ `kyb-job.spec.ts`): the shared job contract.
   - `export const KYB_CHECK_QUEUE = 'kyb-check'` and `export const KYB_CHECK_JOB_NAME = 'kyb-check'`.
   - `export const KYB_JOB_ATTEMPTS = 5` and
     `export const KYB_JOB_BACKOFF = { type: 'exponential', delay: 2000 } as const`.
   - `export const KYB_WORKER_LABEL = 'kyb-worker'`.
   - `export interface KybCheckJobData { applicationId: string; submissionNo: number }`.
   - `export function kybCheckJobId(applicationId: string, submissionNo: number): string`, which
     returns `` `kyb-check:${applicationId}:${submissionNo}` ``.
   - `export function parseKybCheckJobData(data: unknown): KybCheckJobData | null`: a plain object
     with a UUID `applicationId` (`isUUID`) and an integer `submissionNo >= 1`, otherwise `null`.
4. `src/kyb/kyb-provider.ts`: the provider contract (types and tokens only).
   - `export interface KybProviderInput { applicationId: string; merchantCategoryCode: string; businessType: BusinessType; expectedMonthlyVolumeMinor: number; averageTicketSizeMinor: number }`.
     There is deliberately no owner, tax or contact field.
   - `export interface KybProviderResult { providerReference: string; score: number; reasons: string[]; providerVersion: string }`.
   - `export interface KybProvider { check(input: KybProviderInput): Promise<KybProviderResult> }`.
   - `export const KYB_PROVIDER = Symbol('KYB_PROVIDER')` and
     `export const KYB_RANDOM = Symbol('KYB_RANDOM')` (type `export type RandomSource = () => number`).
   - `export class KybProviderError extends Error` (name `'KybProviderError'`).
5. `src/kyb/kyb-level.ts` (+ `kyb-level.spec.ts`):
   `export interface KybScoreThresholds { mediumMin: number; highMin: number }` and
   `export function scoreToLevel(score: number, thresholds: KybScoreThresholds): KybLevel`. The
   result is `HIGH` when `score >= highMin`, `MEDIUM` when `score >= mediumMin`, else `LOW`. A higher
   score means higher risk (the ADR example is 78 → HIGH). The function is pure.
6. `src/kyb/simulated-kyb-provider.ts` (+ `simulated-kyb-provider.spec.ts`):
   `@Injectable() export class SimulatedKybProvider implements KybProvider`, constructed with
   `(config: ConfigService<AppEnv, true>, @Inject(KYB_RANDOM) random: RandomSource)`.
   `check(input)` works like this:
   1. If `random() < KYB_FAILURE_RATE`, throw `new KybProviderError('Simulated provider unavailable')`.
   2. Otherwise start the score at `10`.
   3. Add `+40` and reason `HIGH_RISK_MCC` when the MCC is in
      `HIGH_RISK_MCCS = ['4829', '5967', '5993', '6051', '7995']`.
   4. Add `+20` and `HIGH_VOLUME` when `expectedMonthlyVolumeMinor > 10_000_000_00`.
   5. Add `+10` and `HIGH_TICKET_SIZE` when `averageTicketSizeMinor > 50_000_00`.
   6. Add `Math.floor(random() * 21)` (0–20).
   7. Clamp the score to 0–100 and return
      `{ providerReference: 'sim-' + randomUUID(), score, reasons, providerVersion: 'sim-1' }`.

   The constants are named and commented as made-up simulation values. The provider does no I/O
   and writes no logs.
7. `src/kyb/testing/fake-kyb-provider.ts` (+ `fake-kyb-provider.spec.ts`):
   `export class FakeKybProvider implements KybProvider`, test-only and never registered in
   `KybModule` (a header comment says so).
   - Outcomes are scripted: `failNext(times = 1)`, `succeedWith(result: Partial<KybProviderResult>)`
     (sticky default) and `alwaysFail()`.
   - Default result: `{ providerReference: 'fake-ref-' + callCount, score: 78, reasons: ['FAKE_REASON'], providerVersion: 'fake-1' }`.
   - It records `calls: KybProviderInput[]`, and `reset()` clears everything.
   - A failure throws `KybProviderError('Fake provider failure')`. No randomness and no timers.
   - `tsconfig.build.json`: add `"src/**/testing/**"` to `exclude`, so the fake never ships in
     `dist/`. `tsconfig.json` has no `include` or `exclude`, so `npm run typecheck`
     (`tsc --noEmit -p tsconfig.json`) still type-checks it. ESLint (`eslint .`) still lints it.
     ts-jest compiles it for the specs. The implementer of A confirms that `npm run build` emits no
     `dist/kyb/testing/` and that typecheck and lint still report on that folder.
8. `src/kyb/kyb-check.entity.ts`: `@Entity('kyb_checks')` with:
   - `@Unique('UQ_kyb_checks_application_submission', ['applicationId', 'submissionNo'])`
   - `@Check('CHK_kyb_checks_score_range', '"score" >= 0 AND "score" <= 100')`
   - `id` (uuid PK `PK_kyb_checks`)
   - `applicationId` (`application_id` uuid), plus a `ManyToOne(() => MerchantApplication, { onDelete: 'RESTRICT' })`
     with FK `FK_kyb_checks_application` that is never loaded
   - `submissionNo` (`submission_no` int)
   - `providerReference` (`provider_reference` varchar(100))
   - `score` (smallint)
   - `level` (enum `KybLevel`, `enumName: KYB_LEVEL_ENUM`, reusing the existing type)
   - `reasons` (jsonb, default `'[]'`, `string[]`)
   - `meta` (jsonb, default `'{}'`)
   - `createdAt` (`created_at` timestamptz `CreateDateColumn`)

   A comment points to docs/adrs/database.md §`kyb_checks`.
9. `src/database/migrations/1792800000003-CreateKybChecks.ts`: class `CreateKybChecks1792800000003`.
   - `up`: `CREATE TABLE "kyb_checks" (...)`, with column types matching the entity (generated
     style, like `1792800000002`). It includes `CONSTRAINT "UQ_kyb_checks_application_submission" UNIQUE ("application_id", "submission_no")`,
     `CONSTRAINT "CHK_kyb_checks_score_range" CHECK ("score" >= 0 AND "score" <= 100)` and
     `"level" "public"."kyb_level" NOT NULL`. **No `CREATE TYPE`**: `kyb_level` is owned by
     `1792800000002`. Then `ALTER TABLE ... ADD CONSTRAINT "FK_kyb_checks_application" FOREIGN KEY ("application_id") REFERENCES "merchant_applications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`.
   - `down`: drop the FK, then the table. It does not drop the type.
   - No other migration is edited.
10. `src/kyb/kyb-check.queue.ts` (+ `kyb-check.queue.spec.ts`): the producer.
    `@Injectable() export class KybCheckQueue`, constructed with
    `(@InjectQueue(KYB_CHECK_QUEUE) private readonly queue: Queue<KybCheckJobData>)`.
    - `export const KYB_ENQUEUE_TIMEOUT_MS = 2000`.
    - `async enqueue(applicationId: string, submissionNo: number): Promise<boolean>`:
      - Runs `queue.add(KYB_CHECK_JOB_NAME, { applicationId, submissionNo }, { jobId: kybCheckJobId(...), attempts: KYB_JOB_ATTEMPTS, backoff: KYB_JOB_BACKOFF })`.
      - It races the add against a timeout of `KYB_ENQUEUE_TIMEOUT_MS`. The timer is always
        cleared in `finally`, so no handle stays open.
      - It **never rejects**. On error or timeout it calls
        `logError('kyb-queue', 'KYB check could not be enqueued; application stays in RISK_REVIEW', { applicationId, submissionNo, error })`
        and returns `false`. Success returns `true`.
    - The doc comment says to call it only after the submit transaction has committed, and refers
      to the kyb-check.md trade-off (no outbox; Redis down → stuck in `RISK_REVIEW`).
    - Export `export function kybQueueConnection(env: Pick<AppEnv, 'REDIS_HOST' | 'REDIS_PORT'>): ConnectionOptions`,
      which returns `{ host: env.REDIS_HOST, port: env.REDIS_PORT, maxRetriesPerRequest: null }`.
      - This is the single connection policy for the queue **and** the worker.
      - `maxRetriesPerRequest: null` is required by BullMQ workers.
      - There is deliberately no `enableOfflineQueue: false`. A worker that inherits the queue's
        options must keep queueing commands through a Redis reconnect, otherwise it would stall
        jobs.
      - The 2000 ms timeout race is the only bound on the request.
      - It is pure and unit-tested. Steps 16 and 17 both use it.
11. `src/applications/dto/application-response.dto.ts` (+ `application-response.dto.spec.ts`):
    - `export const KYB_LEVEL_LABELS: Readonly<Record<KybLevel, string>> = { LOW: 'Good to go', MEDIUM: 'Fair deal', HIGH: 'Needs double check' }`.
    - `export function kybLevelLabel(level: KybLevel | null): string | null`.
    - `export class KybCheckResponseDto` with `status` (`KybStatus` enum), `level`
      (`KybLevel | null`), `label` (`string | null`), `score` (`number | null`), `attempts`
      (`number`) and `lastAttemptAt` (`Date | null`), each with `@ApiProperty` (nullable where
      needed, examples from the ADR).
    - `export class ApplicationDetailResponseDto extends ApplicationResponseDto { kybCheck!: KybCheckResponseDto }`.
    - `export function toApplicationDetailResponse(app): ApplicationDetailResponseDto` returns
      `{ ...toApplicationResponse(app), kybCheck: { status: app.kybStatus, level: app.kybLevel, label: kybLevelLabel(app.kybLevel), score: app.kybScore, attempts: app.kybAttempts, lastAttemptAt: app.kybLastAttemptAt } }`.
      The spread is of the already allow-listed DTO, never of the entity.
    - `toApplicationResponse` is unchanged. Update the class comment: KYB fields appear only
      through `kybCheck` on the detail response.
12. `src/applications/applications.service.ts` (+ `applications.service.spec.ts`):
    - Add the constructor dependency `private readonly kybCheckQueue: KybCheckQueue`.
    - `get()` returns `Promise<ApplicationDetailResponseDto>` through `toApplicationDetailResponse`,
      with the same scoped `findAccessible` and the same 404.
    - `submit()`: replace the seam comment with
      `await this.kybCheckQueue.enqueue(result.applicationId, result.submissionNo);` after the
      transaction. Its comment says: after the commit, never inside the transaction; the result is
      ignored on purpose (the request succeeds even if Redis is down; docs/adrs/kyb-check.md
      trade-off).
    - The class doc comment mentions the enqueue.
13. `src/applications/applications.controller.ts`: `GET :id` →
    `@ApiOkResponse({ type: ApplicationDetailResponseDto })` and return type
    `Promise<ApplicationDetailResponseDto>`. Nothing else changes, and no new route is added.
14. `src/kyb/kyb-worker-applications.repository.ts` (+ `kyb-worker-applications.repository.spec.ts`):
    `@Injectable() export class KybWorkerApplicationsRepository`.
    - **Class comment:** worker-only (`actor_type SYSTEM`). It is never reachable from a request:
      it takes no `AuthUser`, it does not use `applyScope`, `KybModule` does not export it, and only
      `KybCheckProcessor` injects it. Request paths must use `ApplicationsRepository`. Every write is
      guarded by `id`, `submission_count = :submissionNo` and `status = 'RISK_REVIEW'`, and bumps
      `version` and `updated_at` explicitly (the same convention as `ApplicationsRepository`).
    - The constructor takes `@InjectRepository(MerchantApplication) repository` and
      `@InjectRepository(KybCheck) kybChecks`.
    - `findForWorker(applicationId): Promise<KybWorkerApplication | null>`: `null` without a query
      when the id is not a UUID. Otherwise it selects only `id`, `status`, `submissionCount`,
      `merchantCategoryCode`, `businessType`, `expectedMonthlyVolumeMinor` and
      `averageTicketSizeMinor` (`KybWorkerApplication` is a `Pick` of these). No PII column is
      loaded.
    - `kybCheckExists(applicationId, submissionNo): Promise<boolean>`.
    - `recordAttemptIfCurrent(applicationId, submissionNo): Promise<boolean>`: a query-builder
      `UPDATE` that sets `kybAttempts: () => 'kyb_attempts + 1'`, `kybLastAttemptAt: () => 'now()'`,
      `version: () => 'version + 1'`, `updatedAt: () => 'now()'`, with the guard. It returns
      `affected === 1`.
    - `insertKybCheckIfAbsent(values: NewKybCheck, manager): Promise<boolean>`: parameterised SQL
      exactly as in the ADR,
      `INSERT INTO "kyb_checks" ("application_id","submission_no","provider_reference","score","level","reasons","meta") VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT ("application_id","submission_no") DO NOTHING RETURNING "id"`.
      `true` means a row came back.
    - `completeIfCurrent(applicationId, submissionNo, result: { level: KybLevel; score: number }, manager): Promise<boolean>`
      sets `status: kybCompleteTarget()`, `kybStatus: COMPLETED`, `kybLevel`, `kybScore`, version
      and updated_at, with the guard.
    - `failIfCurrent(applicationId, submissionNo, manager): Promise<boolean>` sets
      `status: kybCompleteTarget()`, `kybStatus: FAILED`, `kybLevel: null`, `kybScore: null`,
      version and updated_at, with the guard.
    - Private `kybCompleteTarget()` returns
      `nextSystemStatus(ApplicationStatus.RISK_REVIEW, TransitionAction.KYB_COMPLETE)` and throws if
      that is `null`.
15. `src/kyb/kyb-check.processor.ts` (+ `kyb-check.processor.spec.ts`):
    `@Processor(KYB_CHECK_QUEUE, { autorun: false }) export class KybCheckProcessor extends WorkerHost implements OnApplicationBootstrap`.
    - The constructor takes `DataSource`, `KybWorkerApplicationsRepository`, `AuditLogService`,
      `@Inject(KYB_PROVIDER) provider: KybProvider` and `ConfigService<AppEnv, true>`, and reads the
      thresholds once.
    - `onApplicationBootstrap(): void` calls `this.startWorker()` when `KYB_WORKER_ENABLED`.
    - In unit tests the BullMQ worker is never constructed. `WorkerHost.worker` is stubbed with
      `jest.spyOn(processor, 'worker', 'get').mockReturnValue({ isRunning, run, close })`, where
      each member is a `jest.fn`.
    - **Typed fallback**, in case `spyOn(..., 'get')` fails (for example, the getter is not
      configurable on the installed `WorkerHost`): a spec-local helper
      `stubWorker(processor: KybCheckProcessor, stub: WorkerStub): void` that calls
      `Object.defineProperty(processor, 'worker', { get: (): WorkerStub => stub, configurable: true })`.
      - `type WorkerStub = Pick<Worker, 'isRunning' | 'run' | 'close'>`, built from `jest.fn`s typed
        `jest.MockedFunction<Worker['run']>` and so on.
      - No `any`, no `!`, no `@ts-ignore`.
      - The mocked return value is typed through `WorkerStub`. Where the type checker needs the
        full `Worker`, cast with `as unknown as Worker` in this one helper only, with a comment.
      - Report which variant was used.
    - `startWorker(): void`: if `!this.worker.isRunning()`, start
      `void this.worker.run().catch((error) => logError(...))`. The doc comment says it is
      idempotent and used by bootstrap and by the one Redis e2e test.
    - `process(job: Job<KybCheckJobData>): Promise<KybJobOutcome>` delegates to `handle(job)`.
    - `export type KybJobOutcome = 'invalid' | 'stale' | 'already-done' | 'completed'`.
    - `export type KybJobLike = Pick<Job<unknown>, 'data' | 'attemptsMade' | 'opts'>`. This lets
      tests pass crafted jobs without casts.
    - `async handle(job: KybJobLike): Promise<KybJobOutcome>`:
      1. `parseKybCheckJobData(job.data)`. If it is `null`, call
         `logError('kyb-worker', 'Invalid KYB job data')` (no data in meta) and return `'invalid'`
         (ack; a retry cannot fix it).
      2. Compute `attempt = job.attemptsMade + 1` and `maxAttempts = job.opts.attempts ?? 1`.
      3. `findForWorker`. If it is `null`, or `submissionCount !== n`, or `status !== RISK_REVIEW`,
         call `logInfo('kyb-worker', 'Stale KYB job skipped', { applicationId, submissionNo })` and
         return `'stale'`.
      4. If `kybCheckExists` returns true, return `'already-done'`.
      5. If `recordAttemptIfCurrent` returns false, return `'stale'` (the row changed in between).
      6. Compute `isFinal = attempt >= maxAttempts` **before** the provider call.
      7. In one `try` block, call `provider.check(input)` and time it (`latencyMs`), then run the
         **success** steps:
         - `level = scoreToLevel(score, thresholds)`.
         - One `dataSource.transaction`:
           1. `inserted = insertKybCheckIfAbsent({ applicationId, submissionNo: n, providerReference, score, level, reasons, meta: buildAuditMeta({ providerVersion, latencyMs, attempt }) }, manager)`.
              If `!inserted` (a result row for `(id, n)` already exists), throw the private
              `StaleKybJobError` and do not go on to the `UPDATE`.
           2. `moved = completeIfCurrent(...)`. If `!moved`, throw `StaleKybJobError`, so the
              transaction rolls back and no orphan result row is kept.
           3. `record({ SYSTEM, KYB_WORKER_LABEL, KYB_CHECK_COMPLETED, meta: { submissionNo: n, attempt, score, level, reasons, providerReference } }, manager)`.
         - Return `'completed'`.
      8. **Catch** (any error after `recordAttemptIfCurrent` succeeded: a provider error **or** a
         failure of the success transaction):
         - `StaleKybJobError` → return `'stale'`. This is not a failure: no audit row, no rethrow.
         - Build
           `failMeta = { submissionNo: n, attempt, maxAttempts, final: isFinal, errorName: error.name }`.
           It holds no error message and no input.
         - Call `logError('kyb-worker', 'KYB provider attempt failed', { applicationId, submissionNo, attempt, error })`.
           The message is fixed, so tests can look for it.
         - **Not final:** best effort
           `auditLogService.record({ actorType: SYSTEM, actorLabel: KYB_WORKER_LABEL, action: KYB_CHECK_ATTEMPT_FAILED, entityType: 'merchant_application', entityId: id, meta: failMeta })`.
           If that write throws, `logError` the ids and that error. Then **rethrow the original
           error** so BullMQ schedules the retry.
         - **Final:** a best-effort final-failure transaction:
           1. Record `KYB_CHECK_ATTEMPT_FAILED` (`final: true`).
           2. `failIfCurrent`.
           3. When `failIfCurrent` returned true, record `KYB_CHECK_FAILED` with meta
              `{ submissionNo: n, attempts: attempt }`.

           If this transaction throws, log the ids and that error only
           (`'KYB final-failure write failed'`). In every case, **rethrow the original error**, so
           BullMQ marks the job failed. Because of this, a success-path error on the last attempt
           still moves the application out of `RISK_REVIEW` (workflow.md §1.2: never stuck).
           Doing this inside `handle`, and not in a `failed` event, keeps it awaited and testable.
    - The processor never calls `ApplicationsRepository` and never builds an `AuthUser`.
16. `src/kyb/kyb.module.ts` (+ `kyb.module.spec.ts`):
    - `imports: [TypeOrmModule.forFeature([MerchantApplication, KybCheck]), AuditModule, BullModule.registerQueue({ name: KYB_CHECK_QUEUE })]`.
      There is no per-queue connection: the queue and the `@Processor` worker both use the root
      connection from step 17 (`kybQueueConnection(env)`), so they share one policy, whichever way
      `@nestjs/bullmq` merges the queue and decorator options.
    - Here and in step 17, `env` means
      `{ REDIS_HOST: config.get('REDIS_HOST', { infer: true }), REDIS_PORT: config.get('REDIS_PORT', { infer: true }) }`.
    - `providers: [KybCheckQueue, KybWorkerApplicationsRepository, KybCheckProcessor, { provide: KYB_PROVIDER, useClass: SimulatedKybProvider }, { provide: KYB_RANDOM, useValue: Math.random }]`.
    - **`exports: [KybCheckQueue]` only.** The comment says why: the worker repository and the
      provider must not be injectable elsewhere.
    - `src/kyb/kyb-worker-boundary.spec.ts` (also part of this step) is an import guard. It walks
      `src/` recursively with `fs` and fails if any `.ts` file outside `src/kyb/` contains the text
      `kyb-worker-applications.repository`. It lists the offending paths.
17. `src/app.module.ts`: add
    `BullModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService<AppEnv, true>) => ({ connection: kybQueueConnection(env), prefix: QUEUE_PREFIX }) })`
    after `ConfigModule`. The factory declares an explicit return type. This is the one connection
    policy for both the queue and the worker (`maxRetriesPerRequest: null`, offline queue left on).
    A hanging `add` while Redis is down is bounded by `KYB_ENQUEUE_TIMEOUT_MS`.
    - **Closing connections:** `@nestjs/bullmq` closes its registered queues and workers in its
      shutdown hooks, and `app.close()` runs those hooks. Every spec that builds the full
      `AppModule` (app, swagger, database, audit-log, auth, applications, kyb-worker, and any other
      spec that imports `AppModule`) therefore releases the Redis connections through its existing
      `app.close()`.
    - The implementer of Z must check this once with
      `npx jest --config ./test/jest-e2e.json --runInBand --detectOpenHandles`. If a BullMQ handle
      is reported, the fix is an explicit `onModuleDestroy` close. Report it, because those files
      belong to A and C.
18. `src/applications/applications.module.ts`: import `KybModule`, so `KybCheckQueue` can be
    injected into `ApplicationsService`.
19. `src/database/database.options.ts`: add `KybCheck` to `entities`.
    `src/database/migrations/index.ts`: append `CreateKybChecks1792800000003`, and extend the order
    comment (kyb_checks has an FK to merchant_applications and reuses `kyb_level`).
20. `test/setup/test-env.ts` (+ cases in `test/test-env.e2e-spec.ts`):
    - Always set `process.env.KYB_WORKER_ENABLED = 'false'`, so no spec runs a worker unless it
      starts one explicitly.
    - New pure `ensureTestQueuePrefix(env, generate = () => 'mo-e2e-' + randomBytes(4).toString('hex'))`:
      it keeps an existing `QUEUE_PREFIX` that starts with `mo-e2e-` and otherwise generates one.
      So a `.env` value such as `QUEUE_PREFIX=bull` is **replaced**, and a test run never touches
      dev queue keys.
    - `applyTestDatabaseEnv()` calls it and writes the result to `process.env.QUEUE_PREFIX`
      (next to the JWT_SECRET line).
    - globalSetup runs first and sets the prefix. Jest copies globalSetup's env into each test
      context, and the `setupFiles` call then keeps the `mo-e2e-*` value. So globalSetup and every
      spec context share one prefix per run, the same way `ensureTestJwtSecret` works.
21. `test/utils/test-db.ts`: both `resetTables` and `resetApplicationData` truncate `"kyb_checks"`
    in the same statement as `"merchant_applications"` (FK). Update the comment.
22. `test/migrations.e2e-spec.ts`: undo **four** migrations, and assert `kyb_checks` is gone, then
    restored. Update the "three" wording.
23. `test/applications.e2e-spec.ts`:
    - `DETAIL_RESPONSE_KEYS = [...RESPONSE_KEYS, 'kybCheck']`. `expectMasked(body, keys = RESPONSE_KEYS)`,
      and GET-by-id call sites pass `DETAIL_RESPONSE_KEYS`.
    - Get the queue with `app.get<Queue>(getQueueToken(KYB_CHECK_QUEUE))`.
    - In `beforeAll`, `await queue.waitUntilReady()`, so the first submit does not race the connect
      and fall into the enqueue timeout.
    - In `afterAll`, run `queue.obliterate({ force: true })` before `app.close()`.
    - **Console spies:** `src/logging/logger.ts` writes with `console.log` / `console.error`. Under
      a multi-file Jest run, the per-test `BufferedConsole` prints only after the file finishes, so
      the existing `process.stdout.write` / `process.stderr.write` spies would never see those
      lines.
      - In `beforeAll`, also install
        `consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined)` and
        `consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)`, as
        `src/logging/logger.spec.ts` does.
      - `capturedText()` joins the first argument of every call to all four spies (stdout, stderr,
        console.log, console.error), each turned into a string.
      - `beforeEach` clears all four, and `afterAll` restores all four.
      - The positive log-line checks and the no-PII checks both run against this combined text.
    - **Logger on:** in `beforeAll`, call `configureLogger({ production: false })` **after** all
      four spies are installed. In `afterAll`, call `configureLogger({ production: true })` to
      restore silence.
    - New cases are listed under Tests.
24. `test/kyb-worker.e2e-spec.ts` (new): see Tests. Setup:
    - `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(KYB_PROVIDER).useValue(fake)`,
      where `fake` is a `FakeKybProvider`.
    - The same user fixtures and login pattern as the applications spec, with passwords from the
      `SEED_*` env.
    - The same four spies (stdout, stderr, `console.log`, `console.error`, each mocked to do
      nothing) and the same combined `capturedText()` as the applications spec. Then
      `configureLogger({ production: false })`, then `await queue.waitUntilReady()`.
    - In `beforeEach`, `resetApplicationData` and `fake.reset()`.
    - The handler-direct cases go in `describe('handler (crafted jobs)')`. The worker is not
      running there.
    - The Redis cases go in their own `describe('through Redis')`:
      - Its `beforeAll` creates the `QueueEvents` (same name, prefix and connection) and calls
        `await queueEvents.waitUntilReady()`.
      - Then `await queue.drain(true)` **right before** `processor.startWorker()`. This removes
        leftover waiting and delayed jobs from earlier specs, so the worker never picks them up.
      - Its `afterAll` calls `await processor.worker.close()` and `await queueEvents.close()`.
    - The outer `afterAll` runs `queue.obliterate({ force: true })`, then `app.close()` and
      `configureLogger({ production: true })`.
    - Test-local helper
      `waitForState(job, state: 'delayed', timeoutMs = 10000): Promise<void>` polls
      `await job.getState()` every 25 ms until it equals `state`. Past the timeout it throws an
      error that names the job id and the last state. The loop is bounded, as testing.md allows
      ("poll for the expected state, with a timeout"), with no fixed sleep as an assertion.
    - Every Redis-backed `it(...)` gets an explicit Jest timeout of `30000`. "Retries used up" gets
      `60000` and lower per-call bounds (`waitForState(job, 'delayed', 5000)` for each of the four
      waits, `waitUntilFinished(queueEvents, 10000)`). Their worst-case sum (4 × 5 s + 10 s = 30 s)
      stays below the Jest timeout, so a named bound always fires first and the error says which
      wait failed.

## Tests
- Unit (`npm run test`):
  - `env.validation.spec.ts`
    - Defaults: `REDIS_PORT 6379`, `QUEUE_PREFIX 'bull'`, `KYB_WORKER_ENABLED true`,
      `KYB_FAILURE_RATE 0.2`, `KYB_SCORE_MEDIUM_MIN 40`, `KYB_SCORE_HIGH_MIN 70`.
    - Valid overrides are parsed (`'0'`, `'1'`, `'0.5'` rates; `'false'`).
    - **Invalid**, each named and none echoing the value:
      - missing or blank `REDIS_HOST`
      - `REDIS_PORT` set to `'0'`, `'70000'` or `'abc'`
      - `QUEUE_PREFIX` set to `'a:b'`, `''` (→ default) or 51 chars
      - `KYB_FAILURE_RATE` set to `'-0.1'`, `'1.5'`, `'abc'` or `'NaN'`
      - `KYB_SCORE_*` set to `'101'`, `'-1'` or `'4.5'`
      - `MEDIUM_MIN 70` / `HIGH_MIN 70` → `KYB_SCORE_HIGH_MIN`
    - `validRaw()` gains `REDIS_HOST: FIXTURE`.
  - `kyb-job.spec.ts`
    - `kybCheckJobId('<uuid>', 3)` → `'kyb-check:<uuid>:3'`.
    - `parseKybCheckJobData` accepts a valid object.
    - It **rejects** `null`, a string, a non-UUID id, `submissionNo` 0, -1, 1.5 or `'1'`, and a
      missing key.
  - `kyb-level.spec.ts`: boundaries with 40/70: `0 → LOW`, `39 → LOW`, `40 → MEDIUM`,
    `69 → MEDIUM`, `70 → HIGH`, `78 → HIGH`, `100 → HIGH`. Custom thresholds are respected.
  - `simulated-kyb-provider.spec.ts` (scripted `random`, config stub):
    - `random` returns 0.1 with rate 0.2 → rejects with `KybProviderError`.
    - Rate 0 never fails.
    - Low-risk input with `random` 0.5 then 0 → score 10, `reasons []`.
    - A high-risk MCC with high volume and high ticket, with jitter 20 → clamped to ≤ 100, with all
      three reasons.
    - `providerReference` starts with `sim-` and `providerVersion` is `'sim-1'`.
    - The input type has no PII keys (a compile-time `Pick` check is not needed; assert
      `Object.keys` of the input built in the processor spec instead).
  - `fake-kyb-provider.spec.ts`: the default result. `failNext(2)` fails twice, then succeeds.
    `alwaysFail` never succeeds. `calls` are recorded. `reset` clears everything.
  - `kyb-check.queue.spec.ts` (mock `Queue`):
    - `add` is called with `('kyb-check', { applicationId, submissionNo: 2 }, { jobId: 'kyb-check:<id>:2', attempts: 5, backoff: { type: 'exponential', delay: 2000 } })`
      and the call resolves `true`.
    - **`add` rejects** → resolves `false`, does not throw, and `logError` is called with exactly
      the meta keys `applicationId`, `submissionNo`, `error`.
    - **`add` never settles** (jest fake timers, advance 2000 ms) → `false`.
    - After success, `jest.getTimerCount() === 0` (the timer was cleared).
    - `kybQueueConnection(env)` → exactly `{ host, port, maxRetriesPerRequest: null }`, with no
      `enableOfflineQueue` key.
  - `kyb-worker-applications.repository.spec.ts` (query-builder mocks, as in
    `applications.repository.spec.ts`):
    - Each update sets exactly the listed keys.
    - The `where` and `andWhere` calls come in order: `id`, then
      `submission_count = :submissionNo`, then `status = :riskReview` (`RISK_REVIEW`).
    - `affected` 0 or `undefined` → `false`.
    - Complete and fail both target `UNDER_REVIEW`.
    - `findForWorker('not-a-uuid')` → `null` with no query, and the select list has no
      `tax_id`/`owner_*` column.
    - The insert SQL contains `ON CONFLICT ("application_id","submission_no") DO NOTHING`. Empty
      `RETURNING` → `false`.
  - `kyb-check.processor.spec.ts` (mock repo, a `transaction` mock that runs the callback with a
    fake manager, a mock audit service, a `FakeKybProvider` and a config stub; crafted jobs
    `{ data, attemptsMade, opts: { attempts: 5 } }`):
    - **Success:**
      - Calls happen in order: attempt recorded, then provider, then insert, then complete, then
        audit, all with the same manager.
      - The audit entry has `actorType SYSTEM`, `actorLabel 'kyb-worker'`, no `actorId` and no
        `actorRole`, action `KYB_CHECK_COMPLETED`, and meta exactly
        `{ submissionNo, attempt: 1, score: 78, level: 'HIGH', reasons, providerReference }`.
      - The result is `'completed'`.
      - The provider input keys are exactly `applicationId, merchantCategoryCode, businessType, expectedMonthlyVolumeMinor, averageTicketSizeMinor`.
    - **Stale:**
      - `findForWorker` returns `null` → `'stale'`.
      - `submissionCount` 2 for job n=1 → `'stale'`.
      - Status `UNDER_REVIEW` → `'stale'`.
      - In each case there is no provider call, no write and no audit.
    - **Duplicate job:** `kybCheckExists` true → `'already-done'`, no attempt write, no provider
      call.
    - **Stale between check and write:** `recordAttemptIfCurrent` false → `'stale'`, no provider
      call.
    - **Duplicate at commit (update):** `completeIfCurrent` false → `'stale'`. There is no audit,
      the transaction callback rejected (rolled back), and no `KYB_CHECK_ATTEMPT_FAILED` is written.
    - **Duplicate at commit (insert):** `insertKybCheckIfAbsent` false → `'stale'`.
      `completeIfCurrent` is **not called**, there is no audit, and the callback rejected.
    - **Retry:**
      - The fake fails once with `attemptsMade 0` → `handle` rejects with the provider error.
      - A single `KYB_CHECK_ATTEMPT_FAILED` audit is written with meta
        `{ submissionNo, attempt: 1, maxAttempts: 5, final: false, errorName: 'KybProviderError' }`.
      - There is no `failIfCurrent`, and `logError` is called with `'KYB provider attempt failed'`.
      - The next call with `attemptsMade 1` succeeds, with audit meta `attempt: 2`.
    - **Non-final, the ATTEMPT_FAILED write also fails:** the fake fails, `record` rejects → `handle`
      rejects with the **provider** error (not the audit error), and `logError` is called twice.
    - **Final failure (provider error):** `attemptsMade 4`, the fake always fails → rejects. Inside
      one transaction: `KYB_CHECK_ATTEMPT_FAILED` (`final: true`), then `failIfCurrent`, then
      `KYB_CHECK_FAILED` with meta `{ submissionNo, attempts: 5 }`.
    - **Final attempt, success transaction fails:**
      - `attemptsMade 4`, the fake succeeds, and `record` rejects once on `KYB_CHECK_COMPLETED`.
      - `handle` rejects with that audit error (the original error).
      - Then the final-failure transaction runs: `KYB_CHECK_ATTEMPT_FAILED` (`final: true`,
        `errorName` of the audit error), then `failIfCurrent`, then `KYB_CHECK_FAILED`.
    - **Final attempt, the final-failure transaction also fails:** `failIfCurrent` rejects → `handle`
      rejects with the **original** error. `logError` is called with
      `'KYB final-failure write failed'`, and its meta has only `applicationId`, `submissionNo`,
      `attempt`, `error`.
    - **Final failure but stale:** `failIfCurrent` false → no `KYB_CHECK_FAILED`, still rejects.
    - **Invalid data** (`{ applicationId: 'x' }`) → `'invalid'`, no repository call.
    - **Audit write fails on success, not final** → rejects (BullMQ will retry), there is no
      `failIfCurrent`, and no error is swallowed.
    - **Bootstrap:**
      - `KYB_WORKER_ENABLED false` → `worker.run` is not called.
      - `true` → it is called once.
      - `startWorker()` twice while running → `run` is called once.
  - `kyb.module.spec.ts`: `Reflect.getMetadata('exports', KybModule)` equals `[KybCheckQueue]`, so
    the worker repository, the processor and `KYB_PROVIDER` are not exported.
  - `kyb-worker-boundary.spec.ts`: no `.ts` file under `src/` outside `src/kyb/` mentions
    `kyb-worker-applications.repository`. To prove the walker works, it finds at least one file
    inside `src/kyb/` that does mention it.
  - `application-response.dto.spec.ts`:
    - `kybLevelLabel`: `LOW → 'Good to go'`, `MEDIUM → 'Fair deal'`, `HIGH → 'Needs double check'`,
      **`null → null`**. `KYB_LEVEL_LABELS` keys equal `Object.values(KybLevel)`.
    - `toApplicationDetailResponse` gives `kybCheck` exactly `{ status, level, label, score, attempts, lastAttemptAt }`
      for a completed and a failed (`level null`, `label null`, `score null`) fixture.
    - The detail keys are the base keys plus `kybCheck`, in order, and the masked fields are still
      masked.
    - `toApplicationResponse` still has **no** `kybCheck`, `kybStatus` or `meta` key.
  - `applications.service.spec.ts`:
    - Submit calls `kybCheckQueue.enqueue(APP_ID, 3)` once, **after** the transaction resolved
      (assert with `invocationCallOrder`).
    - **The transaction rejects** (404, 409, concurrent, audit failure) → `enqueue` is never called.
    - **`enqueue` resolves `false`** → submit still resolves with the response.
    - `get` returns the detail shape with `kybCheck`. A `findAccessible` result of `null` → 404, as
      before.
- Integration (`npm run test:e2e`, real Postgres and Redis):
  - `test/applications.e2e-spec.ts`
    - Submit → `queue.getJob('kyb-check:<id>:1')` exists, with `data { applicationId, submissionNo: 1 }`,
      `opts.attempts 5` and `opts.backoff { type: 'exponential', delay: 2000 }`.
    - Resubmit (forced `INFO_REQUESTED`, `submission_count 1`) → job `kyb-check:<id>:2`.
    - **Enqueue strictly after commit:** spy on `queue.add` with an implementation that first reads
      the row through `dataSource.query` (a separate pooled connection) and records
      `status = RISK_REVIEW` and `submission_count = 1`, then calls the real `add`. Assert that the
      recorded values were visible, which proves the commit happened before the enqueue.
    - **Enqueue fails:**
      - `queue.add` is mocked to reject once → submit is still 200, and the row is
        `RISK_REVIEW` / `PENDING`.
      - The captured output **contains**
        `'KYB check could not be enqueued; application stays in RISK_REVIEW'`. This proves the
        logger is live.
      - The captured stdout and stderr contain no raw tax ID, national ID, owner email or phone.
    - **Rolled-back submit:** in the existing audit-failure 500 case, assert there is no job for
      that id.
    - **Denied paths enqueue nothing:** in the existing SALES-B 404, REVIEWER 403 and 409 cases,
      there is no job for that id.
    - GET by id after a submit:
      `kybCheck { status: 'PENDING', level: null, label: null, score: null, attempts: 0, lastAttemptAt: null }`.
      After forcing `COMPLETED` / `HIGH` / 78 / 2 / a timestamp, the label is
      `'Needs double check'`. The masked fields are unchanged. The **list** items have no
      `kybCheck`.
    - **Denied:** SALES A GET of SALES B's application → 404, as before. The new block does not
      change the scope.
    - Swagger: no path contains `kyb`, so there is no route that triggers `KYB_COMPLETE`.
  - `test/kyb-worker.e2e-spec.ts` (fake provider, logger configured, application created and
    submitted through HTTP). In `describe('handler (crafted jobs)')` the worker is off, and the
    handler is called directly through `app.get(KybCheckProcessor).handle(job)` with crafted
    `{ data, attemptsMade, opts: { attempts: 5 } }`. In `describe('through Redis')` the real worker
    runs:
    - **Success:**
      - `'completed'`.
      - Row: `UNDER_REVIEW`, `COMPLETED`, `kyb_level HIGH`, `kyb_score 78`, `kyb_attempts 1`,
        `kyb_last_attempt_at` set, `version` incremented.
      - Exactly one `kyb_checks` row: `submission_no 1`, score 78, level HIGH, reasons
        `['FAKE_REASON']`, `meta` with `providerVersion`, `attempt`, `latencyMs`.
      - Audit rows `[APPLICATION_CREATED, APPLICATION_SUBMITTED, KYB_CHECK_COMPLETED]`. The last one
        has `actor_type SYSTEM`, `actor_id null`, `actor_role null`, `actor_label 'kyb-worker'`.
      - GET (SALES owner) `kybCheck` is `{ status: 'COMPLETED', level: 'HIGH', label: 'Needs double check', score: 78, attempts: 1, lastAttemptAt: <ISO> }`.
    - **Duplicate job (sequential):** `handle` twice for n=1 → `'completed'`, then `'stale'`. Still
      one `kyb_checks` row and one `KYB_CHECK_COMPLETED`, and the fake was called once.
    - **Duplicate job (concurrent):** `Promise.all` of two `handle` calls → exactly one
      `'completed'`. Exactly one `kyb_checks` row and one `KYB_CHECK_COMPLETED`. Assert only those
      facts, never the timing.
      - A comment in the test says both calls may pass the stale and existing-row checks before
        either commits. So `kyb_attempts` may be 1 or 2, and the fake may have been called once or
        twice. Neither is asserted.
    - **Existing result row:** insert a `kyb_checks` row for `(id, 1)` with test-only SQL while the
      application is `RISK_REVIEW` → `'already-done'`, `kyb_attempts` still 0, fake not called.
    - **Stale after resubmit:** force `submission_count 2` → job n=1 gives `'stale'`, with no
      attempt, no row and no audit.
    - **Stale, unknown application:** a fake UUID gives `'stale'`.
    - **Invalid data:** `'invalid'`.
    - **Retry, then success (handler-direct, extra coverage):**
      - `fake.failNext(1)`. Attempt 1 rejects. Row: `RISK_REVIEW` / `PENDING`, `kyb_attempts 1`.
        One `KYB_CHECK_ATTEMPT_FAILED` audit row (SYSTEM, meta `final: false`).
      - The captured output **contains** `'KYB provider attempt failed'` (the logger is live) and
        contains no raw tax ID, national ID, owner email or phone.
      - Attempt 2 (`attemptsMade 1`) → `'completed'`, `kyb_attempts 2`, GET `kybCheck.attempts 2`.
    - **Retries used up (handler-direct, extra coverage):**
      - `fake.alwaysFail()`. Attempts `attemptsMade 0..4` each reject.
      - After the fifth: `UNDER_REVIEW`, `FAILED`, level and score null, `kyb_attempts 5`, no
        `kyb_checks` row.
      - Audit: five `KYB_CHECK_ATTEMPT_FAILED` rows, the last with `final: true`, then one
        `KYB_CHECK_FAILED`.
      - GET `kybCheck` is `{ status: 'FAILED', level: null, label: null, score: null, attempts: 5 }`.
    - **Crash between provider and commit (not final):**
      - `jest.spyOn(app.get(AuditLogService), 'record')` is set to reject once on the
        `KYB_CHECK_COMPLETED` call. `handle` (`attemptsMade 0`) rejects.
      - Row: still `RISK_REVIEW`, no `kyb_checks` row, no COMPLETED audit (rolled back).
      - One `KYB_CHECK_ATTEMPT_FAILED` row (`final: false`).
      - The retry gives `'completed'` with exactly one row.
    - **Final attempt, success transaction fails:**
      - `attemptsMade 4`. The fake succeeds. `record` rejects once on `KYB_CHECK_COMPLETED`.
      - `handle` rejects.
      - Row: `UNDER_REVIEW` / `FAILED`, level and score null. No `kyb_checks` row (rolled back).
      - Exactly one `KYB_CHECK_FAILED` row, one `KYB_CHECK_ATTEMPT_FAILED` (`final: true`), and no
        `KYB_CHECK_COMPLETED`. The application is not stuck in `RISK_REVIEW`.
    - **No PII in logs:** across the spec, captured stdout and stderr contain no raw tax ID,
      national ID, owner email or phone. This is asserted after the positive log-line checks
      above, so it cannot pass trivially.
    - **`describe('through Redis')`** (worker started in its `beforeAll`; every `it` has a
      `30000` ms Jest timeout; the shipped job options are used unchanged):
      - **Success:**
        - SALES submits via HTTP. `const job = await queue.getJob('kyb-check:<id>:1')` is not
          null.
        - `await job.waitUntilFinished(queueEvents, 15000)` resolves `'completed'`.
        - GET shows `UNDER_REVIEW` and `kybCheck.status COMPLETED`, `attempts 1`.
        - **Duplicate enqueue:** `app.get(KybCheckQueue).enqueue(id, 1)` again → the queue still
          has exactly one job with that id (`getJobCounts` is unchanged), and no second
          `kyb_checks` row.
      - **Retry, then success:**
        - `fake.failNext(1)`. Submit via HTTP, then `getJob('kyb-check:<id>:1')`.
        - `await waitForState(job, 'delayed')` (the first attempt failed and the exponential
          backoff was scheduled), then `await job.promote()`.
        - `await job.waitUntilFinished(queueEvents, 15000)` resolves `'completed'`.
        - Row: `UNDER_REVIEW` / `COMPLETED`, `kyb_attempts 2`. One `KYB_CHECK_ATTEMPT_FAILED`
          (`attempt 1`, `final: false`) and one `KYB_CHECK_COMPLETED` (`attempt 2`).
        - This is the real-BullMQ check of `attempt = attemptsMade + 1`.
      - **Retries used up:**
        - `fake.alwaysFail()`. Submit, then `getJob`.
        - Four times: `await waitForState(job, 'delayed', 5000)`, then `await job.promote()`.
        - Then `await expect(job.waitUntilFinished(queueEvents, 10000)).rejects.toThrow()`
          (the fifth attempt failed and BullMQ gave up).
        - `await job.getState()` is `'failed'`.
        - Row: `UNDER_REVIEW` / `FAILED`, level and score null, `kyb_attempts 5`, no
          `kyb_checks` row.
        - Audit: five `KYB_CHECK_ATTEMPT_FAILED` rows with `attempt` 1..5, only the fifth with
          `final: true`, then exactly one `KYB_CHECK_FAILED`.
        - GET `kybCheck.status` is `'FAILED'`, with `label null`.
        - This is the real-BullMQ check of `attempt >= opts.attempts`: with an off-by-one, the
          state would be wrong after the fourth promote, or BullMQ would fail the job while the
          row is still `RISK_REVIEW`.
  - `test/migrations.e2e-spec.ts`: four undos, `kyb_checks` dropped and restored, and `kyb_level`
    is still dropped by the earlier migration's down.
  - `test/test-env.e2e-spec.ts`: `ensureTestQueuePrefix` keeps a `mo-e2e-*` value, replaces an empty
    one, and replaces a non-`mo-e2e-` value. `KYB_WORKER_ENABLED` is `'false'` after
    `applyTestDatabaseEnv`.
- Gate: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:e2e`
  (Postgres and Redis via `docker compose -p mo-agent`; export `REDIS_HOST` and `REDIS_PORT`).

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1–10  | package.json, package-lock.json, tsconfig.build.json, src/config/env.validation.ts, src/config/env.validation.spec.ts, src/kyb/kyb-job.ts, src/kyb/kyb-job.spec.ts, src/kyb/kyb-provider.ts, src/kyb/kyb-level.ts, src/kyb/kyb-level.spec.ts, src/kyb/simulated-kyb-provider.ts, src/kyb/simulated-kyb-provider.spec.ts, src/kyb/testing/fake-kyb-provider.ts, src/kyb/testing/fake-kyb-provider.spec.ts, src/kyb/kyb-check.entity.ts, src/database/migrations/1792800000003-CreateKybChecks.ts, src/kyb/kyb-check.queue.ts, src/kyb/kyb-check.queue.spec.ts | — |
| B  | 11–13 | src/applications/dto/application-response.dto.ts, src/applications/dto/application-response.dto.spec.ts, src/applications/applications.service.ts, src/applications/applications.service.spec.ts, src/applications/applications.controller.ts | A |
| C  | 14–16 | src/kyb/kyb-worker-applications.repository.ts, src/kyb/kyb-worker-applications.repository.spec.ts, src/kyb/kyb-check.processor.ts, src/kyb/kyb-check.processor.spec.ts, src/kyb/kyb.module.ts, src/kyb/kyb.module.spec.ts, src/kyb/kyb-worker-boundary.spec.ts | A |
| Z  | 17–24 | src/app.module.ts, src/applications/applications.module.ts, src/database/database.options.ts, src/database/migrations/index.ts, test/setup/test-env.ts, test/test-env.e2e-spec.ts, test/utils/test-db.ts, test/migrations.e2e-spec.ts, test/applications.e2e-spec.ts, test/kyb-worker.e2e-spec.ts | A, B, C |

- **A goes first** because it adds `bullmq` and `@nestjs/bullmq` to `package.json`, and both B
  (through `KybCheckQueue`) and C need them to compile. A also owns the env contract (`AppEnv`
  keys) and the job and provider contracts that B and C import.
- **B and C run in parallel.** B imports only `KybCheckQueue` (A). C imports A's contracts and
  entity. Neither touches a module-wiring file.
- **Z wires everything.** `ApplicationsModule` imports `KybModule`, `AppModule` gets
  `BullModule.forRootAsync`, and Z registers the entity and the migration. Z also runs the full
  gate. Until Z lands, the Nest app cannot resolve `KybCheckQueue`; that is expected, and the unit
  tests do not need it.
- **If the gate fails in an A, B or C file**, Z reports the failure instead of editing that file.
- **`.env.example` belongs to no package.**

## Security notes
- **No authz bypass:**
  - `GET /applications/:id` still uses `findAccessible(id, actor)`. The 404 for out of scope,
    unknown or malformed ids is unchanged.
  - The worker uses `KybWorkerApplicationsRepository`, which takes no actor and never uses
    `applyScope`. It is not exported from `KybModule` (a unit test asserts the exports), and only
    `KybCheckProcessor` injects it. No controller or service on a request path can reach it.
  - Its writes are all conditional on `id`, `submission_count = n` and `status = RISK_REVIEW`.
- **Worker is never a user:**
  - Audit rows are SYSTEM, with `actorLabel 'kyb-worker'`, `actorId` null and `actorRole` null.
    `assertValidAuditEntry` enforces this.
  - No route can trigger `KYB_COMPLETE`. The Swagger e2e asserts there is no `kyb` path.
  - The target status comes from `nextSystemStatus`, the SYSTEM row of the transition table.
- **Mass assignment:** no DTO change accepts input. `kybCheck` is output only, and `meta` is never
  returned.
- **Sensitive data:**
  - The provider input is limited to non-PII fields, and `findForWorker` does not even select PII
    columns.
  - Audit and `kyb_checks` meta hold counters, scores, levels, reasons and references only, and go
    through `buildAuditMeta` (redact, mask, cap).
  - Logs carry `applicationId`, `submissionNo`, `attempt` and the `error` (name, message and stack
    through `sanitizeMeta`). Never payloads, job data dumps or tokens.
  - The e2e specs turn the logger on (`configureLogger({ production: false })` after the output
    spies are installed). They first assert that the expected log line was printed, then assert
    there are no raw sensitive values in stdout or stderr, so the check cannot pass on silent
    output.
- **Secrets:** no Redis password is introduced. Test values come from env or generated values; the
  queue prefix is random per run.
- **Fake data only:** `@example.com` fixtures, fake IDs, `FakeKybProvider` references
  `fake-ref-*`.
- **Transactions:** the success path (result row, status change, audit) and the final-failure path
  (status change, audit) each commit atomically. The e2e crash case proves the rollback.

## Risks / open questions
- **`.env.example` lines for the user to add by hand** (`REDIS_HOST`/`REDIS_PORT` are reportedly
  there already; check):
  ```
  QUEUE_PREFIX=bull
  KYB_WORKER_ENABLED=true
  KYB_FAILURE_RATE=0.2
  KYB_SCORE_MEDIUM_MIN=40
  KYB_SCORE_HIGH_MIN=70
  ```
  `REDIS_HOST` is now **required**, because `validateEnv` runs everywhere:
  - in the app;
  - in `npm run migration:run` / `migration:revert` / `migration:generate` (through
    `src/database/data-source.ts`);
  - in `npm run seed`;
  - in the e2e `globalSetup` and `test/utils/test-db.ts`.

  All of these refuse to start without it, even when they never touch Redis. If it is missing from
  your `.env`, add `REDIS_HOST=localhost`.
- **Every spec that builds `AppModule` now needs Redis running:** auth, swagger, database,
  audit-log, applications, kyb-worker, and any other spec that imports `AppModule`. BullMQ connects
  on module init. The orchestrator gate already starts Redis (`docker compose -p mo-agent`). Locally,
  `docker compose up -d redis` is needed before `npm run test:e2e`.
- **BullMQ custom job IDs containing `:`:** recent BullMQ versions reject custom IDs that contain
  `:`, except IDs with exactly three `:`-separated parts. `kyb-check:{uuid}:{n}` has three parts, so
  it should be accepted. The unit test pins the format, and the Redis e2e proves BullMQ accepts it.
  If the installed version rejects it, **stop and report**. Changing the format would contradict
  kyb-check.md and queue.md and needs an ADR edit.
- **`job.attemptsMade` semantics:** the plan assumes BullMQ v5, where `attemptsMade` is the number
  of finished attempts, so the current attempt is `attemptsMade + 1` and the final one is
  `attempt >= opts.attempts`. The implementer of C must check this against the installed version.
  The crafted-job tests encode the assumption, and the two Redis cases ("retry then success",
  "retries used up") check it against real BullMQ with the shipped options.
- **`job.promote()` on a delayed retry:** this assumes BullMQ moves a job that failed with
  remaining attempts and a backoff to `delayed`, and that `promote()` moves it to `waiting`. If the
  installed version behaves differently, report it and do not lower the shipped backoff.
- **`@Processor(..., { autorun: false })` + `startWorker()`:** this relies on `@nestjs/bullmq`
  passing `autorun` to the Worker and exposing `this.worker`. If it does not, the safest fallback
  keeps the same public behaviour (worker only when `KYB_WORKER_ENABLED`, `startWorker()` for the
  e2e). Report the deviation.
- **Worker off in e2e by default (default taken):** `test-env.ts` forces
  `KYB_WORKER_ENABLED=false`, so the existing applications specs (which assert `RISK_REVIEW` right
  after submit) stay deterministic. Only `describe('through Redis')` in the worker spec starts the
  worker.
- **Cross-spec job leakage:** there is a random `mo-e2e-*` prefix per run. The applications spec
  obliterates the queue in `afterAll`. The worker spec drains it right before `startWorker()` and
  obliterates it in `afterAll`. A leftover job for a truncated application would only produce
  `'stale'`.
- **Every worker write bumps `version` (default taken):** this follows the repository convention
  that conditional writes set `version` and `updated_at` explicitly. A concurrent ADMIN write in
  `RISK_REVIEW` (assign or transfer, later items) can then get 409 `CONCURRENT_MODIFICATION` and
  retry. The ADR is silent.
- **Final failure writes both `KYB_CHECK_ATTEMPT_FAILED` and `KYB_CHECK_FAILED` (default taken):**
  each attempt has its own row, and the final state change has its own row. The job is still
  rethrown, so BullMQ records it as failed.
- **A duplicate detected at commit rolls back (default taken):** if the insert hits the conflict,
  or `completeIfCurrent` matches no row, the whole success transaction rolls back. This keeps "at
  most one stored result" strict.
- **Any error on the last attempt runs the final-failure path (default taken):** this covers a
  provider error, a failed success transaction and (fix round) a DB error in steps 1-3, so the application never stays in
  `RISK_REVIEW` once BullMQ gives up (workflow.md §1.2). If the final-failure write itself fails
  (for example, the DB is down), only ids and the error are logged, and the row stays in
  `RISK_REVIEW`. This is the same class of gap as the no-outbox trade-off.
- **Simulated scoring values are made up:** the high-risk MCC list, the volume and ticket cut-offs
  and the score weights. The ADR only says "MCC and volume plus some randomness". The thresholds
  40/70 and the failure rate 0.2 are defaults, configurable through env.
- **`kybCheck` only on `GET /applications/:id` (default taken):** the ADR names only that endpoint.
  List, create, PATCH and submit keep the existing shape.
- **One connection policy, enqueue bounded by a timeout (decision, revision 2):** the queue and
  the worker share `kybQueueConnection(env)` = `{ host, port, maxRetriesPerRequest: null }`, with
  the offline queue left on.
  - `@nestjs/bullmq` v11 may build the `@Processor` worker from the registered queue's options, so
    a fail-fast queue connection could leak into the worker and stall jobs during a Redis
    reconnect.
  - While Redis is down, `add` waits in the offline queue. The 2000 ms `KYB_ENQUEUE_TIMEOUT_MS`
    race (not configurable) bounds the request, which then succeeds and logs the enqueue failure.
  - A late `add` that lands after Redis comes back is harmless: same `jobId`, and the worker skips
    stale jobs.
  - The e2e specs still `await queue.waitUntilReady()`, so the first submit does not race the
    connect.
  - There is no recovery for a missed enqueue; this is the documented no-outbox trade-off.
- **Stalled jobs (no-outbox trade-off, documented, not handled):** if a worker dies mid-job more
  than BullMQ's `maxStalledCount` times (default 1), BullMQ fails the job without calling the
  processor. The final-failure path then never runs, and the application stays in `RISK_REVIEW`
  with no job. A production fix is the same sweeper or outbox the ADR mentions.
- **Open handles:** the plan relies on `@nestjs/bullmq` closing queues and workers in its shutdown
  hooks, which `app.close()` runs in every spec that builds `AppModule`. Z verifies this once with
  `--detectOpenHandles` and reports any leftover handle (an explicit `onModuleDestroy` close in A or
  C would be the fix).
- **Job retention (fix round, security review):** `removeOnComplete: { age: 7 days }` and
  `removeOnFail: { age: 30 days }` (`KYB_JOB_REMOVE_ON_COMPLETE` / `KYB_JOB_REMOVE_ON_FAIL` in
  `kyb-job.ts`). The `jobId` dedupe now holds only while the job is kept; a later add with the same
  ID is still harmless because the stale check and the unique constraint skip it.
- **Bounded offline-queue growth while Redis is down (fix round, security review):** the 2000 ms
  timeout does not cancel `queue.add`. With the offline queue on, each submit during an outage
  leaves one pending command in ioredis's offline queue. Growth is limited by the authenticated
  submit rate and cleared on reconnect, when the pending adds run. A late add is harmless (same
  `jobId`, stale check, unique constraint). The timeout log therefore says the job may still be
  added; an outright rejection keeps the "stays in RISK_REVIEW" message. A per-queue fail-fast
  connection was rejected because `@nestjs/bullmq` builds the worker from the queue's connection.
- **`.claude/rules/api.md` still describes a global error filter** (carried over, not changed here).

## Revision notes
### Revision 1 (plan review round 1)
- **Blocker 1 (testing ADR):**
  - Removed the ADR conflict and the testing.md edit. ADR conflicts is now "None", step 25 is
    gone, and `docs/adrs/testing.md` is out of package Z.
  - "Retry then success" and "retries used up" now run through real Redis with the shipped job
    options: `waitForState(job, 'delayed')` (bounded poll), then `job.promote()`, then
    `job.waitUntilFinished(queueEvents, 15000)`, which resolves on success and rejects after the
    fifth failure. These cases check the `attemptsMade + 1 >= opts.attempts` assumption against
    real BullMQ.
  - The handler-direct cases stay as extra coverage.
- **Blocker 2 (stuck in RISK_REVIEW):**
  - `handle` now computes `isFinal` before the provider call, and one `catch` covers both the
    provider error and a failed success transaction.
  - On the final attempt, any such error runs the best-effort final-failure transaction
    (`KYB_CHECK_ATTEMPT_FAILED` with `final: true`, then `failIfCurrent`, then `KYB_CHECK_FAILED`).
    If that transaction also fails, only ids and the error are logged, and the original error is
    rethrown.
  - Added unit cases (final attempt with a failing success transaction; final-failure transaction
    failing too) and the e2e case (`attemptsMade 4`, fake succeeds, `record` rejects on
    `KYB_CHECK_COMPLETED` → `UNDER_REVIEW` / `FAILED`, no `kyb_checks` row, one `KYB_CHECK_FAILED`).
- **Blocker 3 (silent logger):**
  - Both e2e specs call `configureLogger({ production: false })` after installing the spies, and
    restore it in `afterAll`.
  - The no-PII checks are preceded by positive assertions on
    `'KYB check could not be enqueued; application stays in RISK_REVIEW'` and
    `'KYB provider attempt failed'`.
- **Suggestions applied:**
  - Explicit `30000` Jest timeout on the Redis-backed tests.
  - Step 20: `applyTestDatabaseEnv()` calls `ensureTestQueuePrefix`, so one prefix is shared per
    run and `QUEUE_PREFIX=bull` from `.env` is replaced.
  - `queue.drain(true)` right before `startWorker()`, inside a dedicated `describe('through Redis')`
    whose `afterAll` closes the worker.
  - The insert conflict throws `StaleKybJobError` (rollback) before the `UPDATE`.
  - The producer queue has its own `enableOfflineQueue: false` connection (`kybQueueConnection`),
    the worker keeps `maxRetriesPerRequest: null`, and the specs wait for `queue.waitUntilReady()`.
    *Superseded in Revision 2.*
  - Stalled-job risk recorded under the no-outbox trade-off.
  - Open-handle strategy stated: rely on `@nestjs/bullmq` shutdown hooks via `app.close()`, and
    verify once with `--detectOpenHandles`.
  - Processor unit tests stub `worker` via `jest.spyOn(processor, 'worker', 'get')`.
  - New import-guard spec `src/kyb/kyb-worker-boundary.spec.ts` (package C).

### Revision 2 (plan review round 2, final)
- **Blocker 1 (log capture):**
  - The logger writes through `console.log` / `console.error`, which Jest buffers per file, so the
    stream spies alone would miss those lines.
  - Steps 23 and 24 now also install `jest.spyOn(console, 'log')` and `jest.spyOn(console, 'error')`
    with `mockImplementation(() => undefined)`. `capturedText()` combines the call args of all four
    spies.
  - The positive log-line checks and the no-PII checks both run on that combined text.
    `configureLogger({ production: false })` still comes after the spies, and both are restored in
    `afterAll`.
- **Blocker 2 (worker inheriting the fail-fast connection), option (a):**
  - `enableOfflineQueue: false` is dropped. `kybQueueConnection(env)` now has one signature and
    returns `{ host, port, maxRetriesPerRequest: null }`, used by `forRootAsync` (step 17).
  - Step 16 uses a plain `BullModule.registerQueue({ name })`, so the queue and the worker share
    that policy.
  - The 2000 ms `KYB_ENQUEUE_TIMEOUT_MS` race alone bounds the request.
  - Updated step 10, its unit test, steps 16 and 17, and the Risks note.
- **Suggestions applied:**
  - "Retries used up" gets a `60000` Jest timeout with lower named bounds (`waitForState` 5000 ×4,
    `waitUntilFinished` 10000), so a named bound fires first.
  - The concurrent-duplicate e2e case has a comment that `kyb_attempts` may be 2 and the fake may
    be called twice. Only the row count, audit count and outcome are asserted.
  - `tsconfig.build.json` (now in package A) excludes `src/**/testing/**`. `tsconfig.json` has no
    include or exclude, so typecheck and lint still cover the fake; A confirms this.
  - A typed `stubWorker` fallback (`Object.defineProperty`, a `Pick<Worker, ...>` stub, no `any`
    or `!`) in case `jest.spyOn(processor, 'worker', 'get')` fails.
  - Risks now say that `REDIS_HOST` being required affects the app, `migration:*`, `seed`,
    globalSetup and test-db, and that every spec building `AppModule` needs Redis running.

### Fix round (security review)
- **Boundary spec bypass:** `kyb-worker-boundary.spec.ts` now also fails on the identifier
  `KybWorkerApplicationsRepository` outside `src/kyb/`. Inside `src/kyb/` the identifier is allowed
  only in `kyb.module.ts`, `kyb-check.processor.ts`, the repository and their specs (plus the
  boundary spec itself). Any non-spec file in `src/kyb/` with `@Controller` or `export *` fails.
- **Timed-out enqueue keeps running:** no per-queue fail-fast connection (the worker would inherit
  it, see revision 2). The timeout now logs `KYB check enqueue timed out; the job may still be
  added when Redis reconnects`; a rejection keeps the old message. Both are exported constants. The
  bounded offline-queue growth is recorded under Risks.
- **Job retention:** `removeOnComplete: { age: 7 * 24 * 3600 }`, `removeOnFail: { age: 30 * 24 *
  3600 }` as named constants; the unit test and the e2e job-options assertions pin them.
- **Final-failure coverage:** `isFinal` is computed before any DB work, and steps 1-3 run inside
  the same try/catch as step 4. On the final attempt any error other than the stale-at-commit
  signal (including from `findForWorker`, `kybCheckExists`, `recordAttemptIfCurrent`) runs the
  best-effort final-failure transaction, then rethrows the original error. On a non-final attempt
  such an error now also gets the best-effort `KYB_CHECK_ATTEMPT_FAILED` row. No
  `@OnWorkerEvent('failed')` handler. kyb-check.md's trade-off paragraph now notes that stalled
  jobs failed by BullMQ never reach the processor.
