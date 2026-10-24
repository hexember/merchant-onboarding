# Database foundation

## Goal
TypeORM is wired to Postgres from validated `@nestjs/config` settings with `synchronize: false`.
Committed migrations create the `users` and append-only `audit_logs` tables exactly as
docs/adrs/database.md specifies, and real `migration:run` / `migration:revert` /
`migration:generate` scripts use one standalone CLI data source. A minimal `UsersModule`
(entity + repository) and an `AuditModule` with an insert-only `AuditLogService` exist. The service
sends `meta` through `redact()` and the mask helpers and caps its size. Shared `redact()` and mask
helpers live in `src/common/` and have unit tests. `npm run seed` idempotently inserts one fake user
per role, with bcrypt-hashed passwords read from env. `npm run test:e2e` runs real specs against a
separate Postgres test database that is recreated and migrated before the suite, and
`--passWithNoTests` is gone. Files under `test/` typecheck and lint, because `rootDir: ./src` no
longer applies to the type-checking config.

## Scope
- In:
  - Dependencies: `@nestjs/typeorm`, `typeorm`, `pg`, `bcrypt`, `dotenv` (+ dev `@types/bcrypt`).
  - Env validation (`validateEnv`) plugged into `ConfigModule.forRoot`.
  - `src/database/`: shared data source options, `DatabaseModule`, CLI `data-source.ts`, two
    migrations plus a migrations index, and the seed (module, service, entry script).
  - `src/users/` (entity, repository, module) and `src/audit/` (entity, enums, service, module).
  - `src/common/`: `UserRole` enum, `redact()`, mask helpers.
  - E2E harness (global setup, per-worker env, DB helpers) and e2e specs. Remove `--passWithNoTests`.
  - tsconfig change so `test/**/*.ts` typechecks; new `typecheck` script.
  - README "Getting started" / "Testing" update. Add one paragraph to docs/adrs/database.md
    that records the append-only trigger and the meta-cap behaviour (see ADR conflicts).
  - The exact `.env.example` lines for the user to add **by hand** (listed below; no package owns
    that file).
- Out:
  - `merchant_applications`, `kyb_checks` tables and their enums.
  - Auth endpoints, login, JWT, guards, `@Roles`, controllers, DTOs, class-validator, Swagger.
  - BullMQ/Redis code, request-logging interceptor, exception filter (they will reuse `redact()`
    later).
  - `findByEmailWithPasswordHash` and any other users lookup the seed does not need. The auth
    task adds them.
  - Changes to `.claude/skills/verify/SKILL.md`, `eslint.config.mjs`, `docker-compose.yml`,
    `src/main.ts`.

## ADR references
- docs/adrs/database.md (intro): UUID PKs (`gen_random_uuid()`), every timestamp `timestamptz`,
  enums created as Postgres enums **in migrations** (`user_role`, `audit_actor_type`,
  `audit_action`).
- docs/adrs/database.md §`meta` columns: `audit_logs.meta jsonb NOT NULL DEFAULT '{}'`. Only
  `AuditLogService` writes it (there are no DTOs). Every write goes through `redact()` and then
  `maskSensitiveFields()`, and is capped at 8 KB (8192 bytes of UTF-8 JSON). `users` has no `meta`.
- docs/adrs/database.md §`users`: columns `id`, `email` (unique, stored lowercased), `password_hash`
  (`select: false`), `full_name`, `role user_role` (ADMIN / REVIEWER / SALES), `created_at`,
  `updated_at`. "Only seeded fake users exist": the seed is the only writer, and there is no sign-up.
- docs/adrs/database.md §`audit_logs` (append-only): columns exactly as in the table. `actor_role`
  reuses the `user_role` enum, and `action` gets the full enum list from the ADR. Index
  `(entity_type, entity_id, created_at)`. `AuditLogService.record()` accepts an optional
  `EntityManager`, so later tasks write the audit row **in the same transaction** as the change.
  `actor_id` has no FK, because the ADR lists it as plain `uuid null`.
- docs/adrs/sensitive-data.md: `redact()` uses a key-based denylist (`password`, `passwordHash`,
  `accessToken`, `authorization`, `jwtSecret`). Masks: `taxId`/`ownerNationalId` → `••••••1234`,
  `ownerEmail` → `j•••@example.com`, `ownerPhone` → last 3 digits.
- docs/adrs/auth.md: "LOGIN_FAILED audit row with the email masked". `maskSensitiveFields()` also
  masks an `email` key, so the auth task gets that for free. The `LOGIN_SUCCEEDED`/`LOGIN_FAILED`
  values are already in `audit_action`. bcrypt is used for `password_hash`.
- docs/adrs/testing.md: masking/redaction unit tests. Integration tests run against real Postgres
  with no randomness. This task adds no authz rule, so none of the listed bypass cases apply yet.
- .claude/rules/database.md: `synchronize: false`, migrations live in `src/database/migrations/`,
  and `meta` is redacted before writing.
- .claude/rules/typescript.md: config is read only through `ConfigService`. The only `process.env`
  readers are config-setup files: `src/config/env.validation.ts` (as input), the CLI
  `src/database/data-source.ts`, and `test/setup/*`. Explicit return types, constructor
  injection, one module per feature.

## ADR conflicts
None of the ADR text is contradicted. Two decisions fill gaps the ADR leaves open. Because later
tasks depend on them, step 15 records them in docs/adrs/database.md §`audit_logs`:
1. "Append-only" is enforced in the database. A `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger
   raises an error. `TRUNCATE` is still allowed, for test cleanup only.
2. Over-cap `meta` is not rejected. It is replaced with `{ "truncated": true, "originalBytes": n }`,
   so the business transaction still succeeds and its audit row still exists.

Proposed ADR addition (end of the `audit_logs` section):
> Append-only is enforced by a trigger that rejects `UPDATE` and `DELETE` on `audit_logs`.
> `meta` is redacted, masked and capped at 8 KB. A larger value is stored as
> `{ "truncated": true, "originalBytes": <n> }` instead of failing the action.

## Steps
1. `package.json` (+ `package-lock.json` via `npm install`):
   - `dependencies`: `@nestjs/typeorm` ^11, `typeorm` ^0.3, `pg` ^8, `bcrypt` ^6, `dotenv` ^17.
     Reasons: TypeORM + driver for the database; bcrypt is the ADR's hash; `dotenv` loads `.env`
     for the CLI data source and the e2e setup, which run outside Nest (it is already a transitive
     dependency of `@nestjs/config`). `devDependencies`: `@types/bcrypt`.
   - `scripts` (replace placeholders; the CLI runs the compiled data source, so no `ts-node`
     is needed):
     - `"typecheck": "tsc --noEmit -p tsconfig.json"`. After step 2, `tsconfig.json` has no
       `incremental` or `tsBuildInfoFile`, so typecheck never reads or writes build info and
       avoids TS5069.
     - `"migration:run": "npm run build && typeorm migration:run -d dist/database/data-source.js"`
     - `"migration:revert": "npm run build && typeorm migration:revert -d dist/database/data-source.js"`
     - `"migration:generate": "npm run build && typeorm migration:generate -d dist/database/data-source.js"`
       (usage: `npm run migration:generate -- src/database/migrations/<Name>`; then add the class to
       `src/database/migrations/index.ts`)
     - `"seed": "npm run build && node dist/database/seeds/seed.js"`
     - `"test:e2e": "jest --config ./test/jest-e2e.json --runInBand"` (drop `--passWithNoTests`;
       `--runInBand` because all specs share one test database)
2. `tsconfig.json`, `tsconfig.build.json`: move three options from `tsconfig.json` into
   `tsconfig.build.json`'s `compilerOptions`: `"rootDir": "./src"`, `"incremental": true` and
   `"tsBuildInfoFile": "./dist/.tsbuildinfo"`. The result is
   `{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": "./src", "incremental": true, "tsBuildInfoFile": "./dist/.tsbuildinfo" }, "exclude": [...] }`,
   with `exclude` unchanged. Effects:
   - `tsconfig.json` (used by ESLint's project service, ts-jest and `typecheck`) covers `src/`
     and `test/`. With neither `incremental` nor `tsBuildInfoFile`, `tsc --noEmit -p tsconfig.json`
     can't hit TS5069 ("Option 'tsBuildInfoFile' cannot be specified without specifying option
     'incremental' or option 'composite'") and never touches build info.
   - `nest build` (which uses `tsconfig.build.json`) stays incremental, still emits `dist/main.js`
     (not `dist/src/main.js`), and keeps the build info inside `dist/`, which `deleteOutDir: true`
     clears.
   - Leave every other option in `tsconfig.json` unchanged.
3. `src/common/user-role.enum.ts`: `export enum UserRole { ADMIN = 'ADMIN', REVIEWER = 'REVIEWER', SALES = 'SALES' }`.
   It is the shared contract for users, audit and seed.
4. `src/common/redact.ts`: `export const REDACTED = '[REDACTED]'` and
   `export function redact(value: unknown): unknown`. It deep-copies plain objects and arrays and
   replaces the value of any key whose *normalised* name (lowercased, `_`/`-` removed) is in
   `{ password, passwordhash, accesstoken, authorization, jwtsecret }` with `REDACTED`. It never
   mutates its input, replaces circular references with `'[Circular]'`, passes primitives through,
   and converts `Date` to an ISO string.
5. `src/common/mask.ts`: `MASK = '••••••'`;
   - `maskLast4(value: string): string` → `MASK + last 4` (`'••••••1234'`). If there are 4 or
     fewer chars it returns `MASK` only.
   - `maskEmail(value: string): string` → first char of the local part + `'•••'` + `'@' + domain`
     (`'j•••@example.com'`). With no `@` or an empty local part it returns `'•••'`.
   - `maskPhone(value: string): string` → `MASK + last 3 digits` (non-digits ignored). With fewer
     than 3 digits it returns `MASK`.
   - `maskSensitiveFields(value: unknown): unknown`: a deep copy that masks values by normalised
     key: `taxid`, `ownernationalid` → `maskLast4`; `owneremail`, `email` → `maskEmail`;
     `ownerphone` → `maskPhone`. A non-string value under these keys becomes `MASK`.
6. `src/config/env.validation.ts`: `export interface AppEnv { NODE_ENV: string; PORT: number; DB_HOST: string; DB_PORT: number; DB_USER: string; DB_PASSWORD: string; DB_NAME: string }`
   and `export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> & AppEnv`.
   It needs no new library. Required non-empty: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
   `DB_PORT` and `PORT` are integers 1–65535 (defaults 5432 / 3000). `NODE_ENV` defaults to
   `development`. It throws one `Error` that lists the **names** of all invalid variables and
   never their values. It returns `{ ...raw, ...typed }`, so `SEED_*` and other keys stay readable
   through `ConfigService`.
7. `src/users/user.entity.ts`: `@Entity('users')`,
   `@Check('CHK_users_email_lowercase', '"email" = lower("email")')`, and the class `User` with:
   `@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_users' }) id!: string`;
   `@Column({ type: 'varchar' }) @Index('UQ_users_email', { unique: true }) email!: string`
   with a transformer `to: normalizeEmail`;
   `@Column({ name: 'password_hash', type: 'varchar', select: false }) passwordHash!: string`;
   `@Column({ name: 'full_name', type: 'varchar' }) fullName!: string`;
   `@Column({ type: 'enum', enum: UserRole, enumName: 'user_role' }) role!: UserRole`;
   `@CreateDateColumn({ name: 'created_at', type: 'timestamptz' })` and
   `@UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })`.
   `export function normalizeEmail(email: string): string` (trim + lowercase) lives in
   `src/users/normalize-email.ts`.
8. `src/users/users.repository.ts`, `src/users/users.module.ts`: `@Injectable() UsersRepository`
   with `@InjectRepository(User)` and only:
   - `findByEmail(email: string): Promise<User | null>`: normalises, then `findOne({ where: { email } })`.
     `passwordHash` is not selected.
   - `insertIfAbsent(input: { email: string; fullName: string; role: UserRole; passwordHash: string }): Promise<boolean>`:
     `INSERT ... ON CONFLICT (email) DO NOTHING RETURNING id` through the query builder
     (`.insert().into(User).values(...).orIgnore().returning('id').execute()`). It returns
     `Array.isArray(result.raw) && result.raw.length > 0`. Postgres returns the `RETURNING` row
     only when a row was actually inserted, so this is the created/skipped signal.
     `result.identifiers` is not used.
   `UsersModule` imports `TypeOrmModule.forFeature([User])` and exports `UsersRepository`. There
   is no find-by-id method. Applications are not touched, so the scoped-repository rule has
   nothing to apply to yet.
9. `src/audit/audit-actor-type.enum.ts` (`USER`, `SYSTEM`) and `src/audit/audit-action.enum.ts`:
   all 11 values from docs/adrs/database.md (`APPLICATION_CREATED` … `LOGIN_FAILED`).
10. `src/audit/audit-log.entity.ts`: `@Entity('audit_logs')`,
    `@Index('IDX_audit_logs_entity', ['entityType', 'entityId', 'createdAt'])`, and the class
    `AuditLog` with:
    `id` (uuid PK `PK_audit_logs`); `actorType` (`actor_type`, enum `audit_actor_type`);
    `actorId` (`actor_id`, `uuid`, nullable);
    `@Column({ name: 'actor_role', type: 'enum', enum: UserRole, enumName: 'user_role', nullable: true }) actorRole!: UserRole | null`
    (the explicit `enumName` makes TypeORM reuse the existing `user_role` type and not generate an
    `audit_logs_actor_role_enum`). Likewise `enumName: 'audit_actor_type'` and
    `enumName: 'audit_action'` on the next two columns;
    `actorLabel` (`actor_label`, `varchar`, nullable); `action` (enum `audit_action`);
    `entityType` (`entity_type`, `varchar`); `entityId` (`entity_id`, `uuid`, nullable);
    `meta` (`jsonb`, `default: () => "'{}'"`, typed `Record<string, unknown>`);
    `createdAt` (`created_at`, `@CreateDateColumn` `timestamptz`). There is no `updated_at`.
11. `src/audit/audit-log.service.ts`, `src/audit/audit.module.ts`:
    - `export const AUDIT_META_MAX_BYTES = 8192`.
    - `export function buildAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown>`:
      `maskSensitiveFields(redact(meta ?? {}))`. If `Buffer.byteLength(JSON.stringify(result), 'utf8') > AUDIT_META_MAX_BYTES`,
      it returns `{ truncated: true, originalBytes }`.
    - `export interface AuditEntry { actorType; actorId?: string | null; actorRole?: UserRole | null; actorLabel?: string | null; action: AuditAction; entityType: 'merchant_application' | 'user'; entityId?: string | null; meta?: Record<string, unknown> }`.
    - `export function assertValidAuditEntry(entry: AuditEntry): void`. It throws
      `InvalidAuditEntryError` (exported class) when `SYSTEM` has a non-null `actorId` or
      `actorRole`, or no `actorLabel`, or when `USER` has an `actorLabel`. This follows the ADR
      notes ("set when actor_type = USER; null for SYSTEM"). `USER` with a null `actorId` is
      allowed for now (see Risks: LOGIN_FAILED).
    - `@Injectable() AuditLogService` (constructor-injects `DataSource`) has a single public method,
      `record(entry: AuditEntry, manager?: EntityManager): Promise<void>`. It validates, builds
      meta, then `(manager ?? this.dataSource.manager).insert(AuditLog, {...})`. It has no update,
      delete or `save` path and no logging of meta.
    - `AuditModule` imports `TypeOrmModule.forFeature([AuditLog])` and exports `AuditLogService`.
12. `src/database/database.options.ts`, `src/database/database.module.ts`,
    `src/database/data-source.ts`:
    - `export function createDataSourceOptions(env: AppEnv): DataSourceOptions`. It returns
      `type: 'postgres'` and host/port/username/password/database from `env`,
      `entities: [User, AuditLog]`, `migrations` from the index, `synchronize: false`,
      `migrationsRun: false`, `uuidExtension: 'pgcrypto'` (so defaults are `gen_random_uuid()`),
      `installExtensions: false` (`gen_random_uuid()` is built into Postgres 13+, and the compose
      image is 16, so TypeORM never runs `CREATE EXTENSION` and no privileged role is needed) and
      `logging: false`, so no SQL or parameter values are logged.
    - `DatabaseModule`: `TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (c) => createDataSourceOptions({ DB_HOST: c.getOrThrow('DB_HOST'), ... }) })`.
    - `data-source.ts` (CLI only, the one non-Nest config reader): `import { config } from 'dotenv'; config({ quiet: true });`
      then `export default new DataSource(createDataSourceOptions(validateEnv(process.env)))`.
13. `src/database/migrations/1792800000000-CreateUsers.ts`,
    `src/database/migrations/1792800000001-CreateAuditLogs.ts`,
    `src/database/migrations/index.ts` (`export const migrations = [CreateUsers1792800000000, CreateAuditLogs1792800000001]`).
    The DDL comes from TypeORM itself, so it matches what the schema-diff e2e test expects.
    Follow this procedure in order:
    1. Create `src/database/migrations/index.ts` first, holding
       `import { MigrationInterface } from 'typeorm'; export const migrations: Array<new () => MigrationInterface> = [];`.
       `data-source.ts` imports it, so it must exist before the first build.
    2. Against an **empty** dev database (fresh `docker compose up -d`), run
       `npm run migration:generate -- src/database/migrations/InitialSchema`. This produces
       **one** file that holds all three enums, both tables and their constraints and index. The
       file is scratch material and is never committed. If the dev DB already has tables, **stop
       and ask the user**. Do not run `docker compose down -v` (or drop anything) yourself,
       because that destroys the dev database volume. Never point this step at the test DB.
    3. Split it by hand into the two named files, with classes `CreateUsers1792800000000` and
       `CreateAuditLogs1792800000001` (`name` property equal to the class name):
       - `CreateUsers.up()`: `CREATE TYPE "public"."user_role"`, `CREATE TABLE "users"` (with
         `PK_users`, `CHK_users_email_lowercase`), `CREATE UNIQUE INDEX "UQ_users_email"`.
         `down()` runs the reverse: drop the index, the table, then the type `user_role`.
       - `CreateAuditLogs.up()`: `CREATE TYPE "audit_actor_type"`, `CREATE TYPE "audit_action"`,
         `CREATE TABLE "audit_logs"` (with `PK_audit_logs`; `actor_role` references the existing
         `"public"."user_role"`), `CREATE INDEX "IDX_audit_logs_entity"`, then the hand-written SQL:
         ```sql
         CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$;
         CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
           FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
         ```
         `down()` runs the reverse: drop the trigger, the function, the index, the table,
         `audit_action`, then `audit_actor_type`. It must **not** drop `user_role`, which
         belongs to `CreateUsers`.
       - Copy every generated statement verbatim into exactly one of the two files. If a
         generated statement fits neither list (e.g. an unexpected `ALTER`), stop and report it.
    4. Delete the scratch `InitialSchema` file and fill the index:
       `[CreateUsers1792800000000, CreateAuditLogs1792800000001]` (users first, because
       `audit_logs.actor_role` uses `user_role`).
    5. Check: `npm run migration:run` applies both, and running
       `npm run migration:generate -- src/database/migrations/Check` again reports "No changes in
       database schema were found" and writes no file. Then `npm run migration:revert` twice
       followed by `migration:run` must succeed. These dev-DB checks repeat what the e2e
       migrations spec proves.
14. `src/database/seeds/seed.service.ts`, `src/database/seeds/seed.module.ts`,
    `src/database/seeds/seed.ts`:
    - `SEED_USERS` constant: `{ email: 'admin@example.com', fullName: 'Alex Admin', role: ADMIN, passwordEnv: 'SEED_ADMIN_PASSWORD' }`,
      `reviewer@example.com` / `Riley Reviewer` / `SEED_REVIEWER_PASSWORD`,
      `sales@example.com` / `Sam Sales` / `SEED_SALES_PASSWORD`. `BCRYPT_COST = 12`.
    - `SeedService.run(): Promise<{ inserted: number; skipped: number }>`. Before any write it reads
      all three passwords via `ConfigService.get<string>()`, and throws one `Error` that names
      every missing or empty variable (never values). Then, for each user,
      `bcrypt.hash(password, BCRYPT_COST)` and `usersRepository.insertIfAbsent(...)`. It is
      idempotent: an existing email is skipped, and its hash and name are not touched. The Nest
      `Logger` logs only the counts.
    - `SeedModule`: `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`,
      `DatabaseModule`, `UsersModule`; provides `SeedService`.
    - `seed.ts`: `async function main(): Promise<void>` creates
      `NestFactory.createApplicationContext(SeedModule)`, awaits `run()` and closes the context in
      `finally`. On error it builds `{ name, code, message }` (where `code` is the SQLSTATE if
      present), passes that object through `redact()`, logs it, and sets `process.exitCode = 1`.
      It never logs the error object itself, the stack, or TypeORM's `query`/`parameters`/`detail`,
      because `parameters` would contain the bcrypt hash. The file ends with `void main();`.
15. `src/app.module.ts`, `src/app.module.spec.ts`, `docs/adrs/database.md`, `README.md`:
    - `AppModule` imports `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`,
      `DatabaseModule`, `UsersModule`, `AuditModule`.
    - Delete `src/app.module.spec.ts`. Compiling `AppModule` now opens a DB connection, so the
      smoke test moves to `test/app.e2e-spec.ts`.
    - docs/adrs/database.md: add the paragraph from "ADR conflicts".
    - README: remove the "placeholders" note. Document `migration:run`/`revert`/`generate` (and that
      new migrations must be added to the index), the `SEED_*` and `DB_NAME_TEST` vars, and that
      `test:e2e` **drops and recreates** `DB_NAME_TEST`.
16. `test/jest-e2e.json`, `test/setup/test-env.ts`, `test/setup/global-setup.ts`,
    `test/utils/test-db.ts`:
    - `jest-e2e.json`: add `"globalSetup": "<rootDir>/setup/global-setup.ts"` and
      `"setupFiles": ["<rootDir>/setup/test-env.ts"]`.
    - `test-env.ts`. **The guard uses option (a) from review: the original name is kept in
      `DB_NAME_ORIGINAL`**, so running the guard twice is safe and the check is not weakened.
      This matters because Jest copies the `process.env` that `global-setup.ts` changed into
      every test context, and `dotenv` never overwrites keys that are already set.
      - `export function resolveTestDatabaseEnv(env: Record<string, string | undefined>): { DB_NAME: string; DB_NAME_ORIGINAL: string }`
        is pure (no I/O):
        `original = env.DB_NAME_ORIGINAL ?? env.DB_NAME`. It throws (naming variables, never
        values) if `original` is missing, if `DB_NAME_TEST` is missing, if `DB_NAME_TEST` does
        not match `/^[a-z_][a-z0-9_]*_test$/`, or if `DB_NAME_TEST === original`. It returns
        `{ DB_NAME: DB_NAME_TEST, DB_NAME_ORIGINAL: original }`.
      - `export function applyTestDatabaseEnv(): void` loads `.env` with `dotenv`
        (`quiet: true`), calls `resolveTestDatabaseEnv(process.env)`, and assigns both returned
        keys to `process.env`. First call (global setup): `DB_NAME_ORIGINAL` is unset, so the
        dev name from `.env` is recorded and `DB_NAME` becomes the test name. Later call (each
        test context): the copied `DB_NAME_ORIGINAL` is still the dev name, so the comparison
        is against the real dev DB, the check passes, and the assignment is a no-op. If a
        context ever has `DB_NAME === DB_NAME_TEST` with no `DB_NAME_ORIGINAL`, the guard still
        throws, which is correct.
      - Runtime env wins over `.env` in `@nestjs/config`, so every Nest module in the tests uses
        the test DB. The file calls `applyTestDatabaseEnv()` at module load (for `setupFiles`).
    - `global-setup.ts`: `export default async function globalSetup(): Promise<void>`. It calls
      `applyTestDatabaseEnv()`, then opens a maintenance `DataSource` (`type: 'postgres'`, same
      host/port/credentials, `database: 'postgres'`, no entities or migrations). It runs
      `DROP DATABASE IF EXISTS "<name>" WITH (FORCE)` and `CREATE DATABASE "<name>"`. The name
      has passed the regex above, because identifiers cannot be bound as parameters. The
      maintenance connection is destroyed in a `finally`, so it closes even when DROP or CREATE
      fails. Then it opens `new DataSource(createDataSourceOptions(validateEnv(process.env)))`
      and runs `runMigrations()`, again with `destroy()` in a `finally`. Errors are rethrown, so
      Jest aborts the run. Each run starts from an empty
      database, which proves the migrations apply from zero.
    - `test-db.ts`: `createTestDataSource(): Promise<DataSource>` (initialised, same options) and
      `resetTables(ds: DataSource): Promise<void>` → `TRUNCATE TABLE "audit_logs", "users"`. Row
      triggers do not fire on TRUNCATE.
17. `test/app.e2e-spec.ts`, `test/database.e2e-spec.ts`, `test/audit-log.e2e-spec.ts`,
    `test/seed.e2e-spec.ts`, `test/migrations.e2e-spec.ts`, `test/test-env.e2e-spec.ts`: see
    Tests. Every spec that writes rows calls `resetTables` in `beforeEach`. The migrations spec
    and the pure guard spec do not.

### `.env.example` lines for the user to add by hand
The agent cannot read or write `.env.example`, so no work package owns it. The user appends:
```
# Separate database for npm run test:e2e. It is DROPPED and recreated on every run.
# Must end with _test and differ from DB_NAME.
DB_NAME_TEST=merchant_onboarding_test
# Passwords for the fake seed users (npm run seed). Put real local values in .env only.
SEED_ADMIN_PASSWORD=change-me
SEED_REVIEWER_PASSWORD=change-me
SEED_SALES_PASSWORD=change-me
```
and the same keys with local values in their own `.env`. `npm run test:e2e` needs all four.

## Tests
- Unit (`npm run test`):
  - `src/common/redact.spec.ts`: redacts `password`, `passwordHash`, `accessToken`,
    `Authorization` (case-insensitive), `jwtSecret`; matches snake/kebab variants (`password_hash`,
    `access_token`, `JWT_SECRET`); redacts inside nested objects and arrays of objects; leaves
    non-denylisted keys unchanged; does not mutate the input; passes primitives, `null` and
    `undefined` through; replaces circular references with `'[Circular]'`.
  - `src/common/mask.spec.ts`: `maskLast4('PAN123456789')` → `'••••••6789'`; `maskLast4('1234')`
    and `''` → `'••••••'` (never reveals a short value in full); `maskEmail('jane@example.com')` →
    `'j•••@example.com'`; `maskEmail('not-an-email')` and `'@example.com'` → `'•••'`;
    `maskPhone('+977-9800000123')` → `'••••••123'`; `maskPhone('12')` → `'••••••'`;
    `maskSensitiveFields` masks `taxId`, `ownerNationalId`, `ownerEmail`, `email`, `ownerPhone`,
    `tax_id` at any depth; a non-string under a sensitive key → `'••••••'`; other keys unchanged;
    no mutation.
  - `src/config/env.validation.spec.ts`: valid input → numeric `DB_PORT`/`PORT`, extra keys
    preserved; defaults for `PORT`, `DB_PORT`, `NODE_ENV`; missing `DB_HOST` → throws, and the
    message names `DB_HOST`; several missing → one error naming all of them; `DB_PORT: 'abc'` and
    `'70000'` → throws; empty-string `DB_NAME` → throws. String fixtures use the neutral sentinel
    `'fixture'` (see Risks); the tests assert on variable names, never values.
  - `src/users/normalize-email.spec.ts`: `' Admin@Example.COM '` → `'admin@example.com'`.
  - `src/users/users.repository.spec.ts` (mocked TypeORM `Repository`): `findByEmail`
    queries with the normalised email; `insertIfAbsent` builds the insert with `.orIgnore()` and
    `.returning('id')`. The mocked `execute()` resolves `{ raw: [{ id: '00000000-0000-0000-0000-000000000001' }] }`
    → `true`, and `{ raw: [] }` → `false`.
  - `src/audit/audit-log.service.spec.ts`: `buildAuditMeta(undefined)` → `{}`; redacts `password`
    and masks `taxId` in the same call; meta of exactly `AUDIT_META_MAX_BYTES` is kept; one byte
    over → `{ truncated: true, originalBytes }`; multibyte characters are counted as bytes.
    Invalid cases for `assertValidAuditEntry`: SYSTEM with `actorId` → throws; SYSTEM without
    `actorLabel` → throws; SYSTEM with `actorRole` → throws; USER with `actorLabel` → throws.
    `record()` with a mocked manager calls `insert(AuditLog, …)` with sanitised meta, uses the
    given manager instead of the default one, and never calls `save`/`update`/`delete`.
  - `src/database/seeds/seed.service.spec.ts` (mocked `ConfigService`, `UsersRepository`,
    `jest.mock('bcrypt')`): one missing `SEED_*` var → throws naming it, and `insertIfAbsent` is
    never called; an empty-string var → throws; all three missing → one error naming all three.
    The happy path is covered in e2e, so no password literal appears in unit tests. The
    seed.ts error logging (redacted `{ name, code, message }`) is a small entry-point concern
    and is checked by review, not by a test.
- Integration (`npm run test:e2e`, real Postgres, test DB from `DB_NAME_TEST`):
  - `test/test-env.e2e-spec.ts` (pure, no DB; it lives under `test/` because that is where the
    helper lives): `resolveTestDatabaseEnv` with plain objects.
    - **Denied:** `{ DB_NAME: 'app', DB_NAME_TEST: 'app' }` → throws. `DB_NAME_TEST` set to the
      dev name with an `_test` suffix and `DB_NAME_ORIGINAL` equal to it → throws.
      `DB_NAME_TEST: 'app_testing'` (no `_test` suffix) → throws. `DB_NAME_TEST: 'App_Test'`
      (uppercase) → throws. Missing `DB_NAME_TEST` → throws naming it.
    - **Allowed:** `{ DB_NAME: 'app', DB_NAME_TEST: 'app_test' }` →
      `{ DB_NAME: 'app_test', DB_NAME_ORIGINAL: 'app' }`.
    - **Second-call regression:** feeding that output back in together with `DB_NAME_TEST`
      returns the same result instead of throwing. This guards the double-call bug.
  - `test/app.e2e-spec.ts`: `AppModule` compiles and its `DataSource` is initialised. Closes the
    module.
  - `test/database.e2e-spec.ts`: no pending migrations (`showMigrations()` → `false`); the
    schema matches the entities (`ds.driver.createSchemaBuilder().log()` → `upQueries` empty);
    the `user_role` enum is exactly `ADMIN, REVIEWER, SALES`; `UsersRepository.insertIfAbsent`
    with `'Mixed@Example.com'` stores `'mixed@example.com'`; a raw SQL insert of an uppercase
    email is rejected (SQLSTATE `23514`); a duplicate email via raw SQL is rejected (`23505`);
    `findByEmail` returns a user with no `passwordHash` property (`select: false`).
  - `test/audit-log.e2e-spec.ts`: `record()` stores a row with `meta` redacted and masked (read
    back via raw SQL); an insert with no meta stores `{}`; **denied:** `UPDATE audit_logs SET ...`
    rejects with `append-only`, and `DELETE FROM audit_logs` rejects with `append-only`;
    `record()` inside `ds.transaction()` that then throws leaves zero rows (proves the
    same-transaction contract).
  - `test/seed.e2e-spec.ts`: two `SeedService.run()` calls → first `{ inserted: 3 }`, second
    `{ inserted: 0, skipped: 3 }`; exactly 3 users, one per role, all `@example.com`;
    `password_hash` values are unchanged after the second run; `bcrypt.compare` with the
    password from `ConfigService` (env) succeeds for each user. No password literals.
  - `test/migrations.e2e-spec.ts`: `undoLastMigration()` twice → `to_regclass('users')` and
    `to_regclass('audit_logs')` are null, and none of the three enum types or
    `audit_logs_block_mutation` remain; then `runMigrations()` restores both tables (leaving the
    DB migrated for any later file).
  - Authz denied cases from docs/adrs/testing.md: none apply. This task adds no endpoint, guard or
    scoped repository. They belong to the auth and applications tasks.
- Gate (package Z): `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`,
  `docker compose ps` (healthy), `npm run test:e2e`, `npm run migration:run` and `npm run seed`
  twice against the dev DB. If the user has not added the `.env` keys yet, report that the e2e,
  migration and seed steps were skipped, not passed.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2, 3, 4, 5, 6 | package.json, package-lock.json, tsconfig.json, tsconfig.build.json, src/common/user-role.enum.ts, src/common/redact.ts, src/common/redact.spec.ts, src/common/mask.ts, src/common/mask.spec.ts, src/config/env.validation.ts, src/config/env.validation.spec.ts | — |
| B  | 7, 8  | src/users/user.entity.ts, src/users/normalize-email.ts, src/users/normalize-email.spec.ts, src/users/users.repository.ts, src/users/users.repository.spec.ts, src/users/users.module.ts | A |
| C  | 9, 10, 11 | src/audit/audit-actor-type.enum.ts, src/audit/audit-action.enum.ts, src/audit/audit-log.entity.ts, src/audit/audit-log.service.ts, src/audit/audit-log.service.spec.ts, src/audit/audit.module.ts | A |
| Z  | 12–17 | src/database/database.options.ts, src/database/database.module.ts, src/database/data-source.ts, src/database/migrations/1792800000000-CreateUsers.ts, src/database/migrations/1792800000001-CreateAuditLogs.ts, src/database/migrations/index.ts, src/database/seeds/seed.service.ts, src/database/seeds/seed.service.spec.ts, src/database/seeds/seed.module.ts, src/database/seeds/seed.ts, src/app.module.ts, src/app.module.spec.ts (delete), docs/adrs/database.md, README.md, test/jest-e2e.json, test/setup/test-env.ts, test/setup/global-setup.ts, test/utils/test-db.ts, test/app.e2e-spec.ts, test/database.e2e-spec.ts, test/audit-log.e2e-spec.ts, test/seed.e2e-spec.ts, test/migrations.e2e-spec.ts, test/test-env.e2e-spec.ts | A, B, C |

**Deliberate deviation:** `package.json` is in A, not in the final package. B and C cannot compile
or run their unit tests until `@nestjs/typeorm`/`typeorm`/`bcrypt` are installed, so the
dependency install is the contract that unblocks them. A writes the final `scripts` too. They are
plain strings that point at files Z creates, and nothing runs them before Z. B and C run in
parallel after A. Z generates the migrations from B's and C's entities and runs the full gate. If
Z hits a failure caused by an A/B/C file, it reports the failure instead of editing that file.
`.env.example` belongs to no package (the user edits it by hand).

## Security notes
- **No secrets in git:** seed passwords come only from `SEED_*` env vars through `ConfigService`.
  Neither tests nor seeds contain a password literal. The e2e seed test compares against the env
  value. `.env` is never read or printed by the implementer. Code loads it with `dotenv`, but
  nobody opens it. `.env.example` gets `change-me` placeholders only, added by the user.
- **No authz bypass:** no request-reachable lookups are added. `UsersRepository` has no
  find-by-id method, and nothing touches applications. The scoped-repository rule takes effect
  with the applications task.
- **Fake data only:** `@example.com` emails, made-up names (Alex Admin, Riley Reviewer, Sam
  Sales), no real IDs.
- **Never log sensitive data:** TypeORM `logging: false` (it would print parameter values,
  including hashes). Seed logs only counts. On failure it logs a `redact()`-ed
  `{ name, code, message }` and never TypeORM's `parameters`/`query`/`detail`. Env validation
  and test-env guard errors name variables, never values.
  `AuditLogService` does not log meta. `redact()` covers the ADR denylist, and
  `maskSensitiveFields()` masks `taxId`/`ownerNationalId`/emails/phones before any audit write.
- **`password_hash`** is `select: false`, and the e2e test proves `findByEmail` omits it. bcrypt
  cost is 12.
- **Append-only audit:** the service has no mutation path, and the DB trigger rejects
  UPDATE/DELETE even from raw SQL.
- **Test DB safety:** the harness drops a database, so it refuses any `DB_NAME_TEST` that doesn't
  end in `_test` or that equals the original dev `DB_NAME` (kept in `DB_NAME_ORIGINAL`, so the
  check stays strict when it runs again in each test context). It validates the identifier before
  interpolating it. `test/test-env.e2e-spec.ts` proves both denied cases.
- `dev.notes/` is not referenced. Wording stays neutral.

## Risks / open questions
- **`.env` keys:** `test:e2e` and `seed` fail with a clear "missing SEED_… / DB_NAME_TEST"
  error until the user adds the lines above to `.env` (and `.env.example`). Implementers must
  report this as "not run", not as a pass.
- **Seed password policy:** the ADRs set none. The plan only requires non-empty values. Should the
  seed also reject the `change-me` placeholder or enforce a minimum length?
- **Seed on re-run:** an existing user is skipped (`ON CONFLICT DO NOTHING`), so changing a
  `SEED_*` value later does not rotate that user's hash. The alternative is to update the hash on
  every run. Confirm that skipping is wanted.
- **Unit-test fixture for `DB_PASSWORD`:** `validateEnv` needs some string for its valid case. The
  plan uses the neutral sentinel `'fixture'` for every string var. It is not a credential for any
  system, but it is a literal in a test. If even that is unwanted, the valid case moves to e2e.
- **Meta over the cap:** the plan stores a `{ truncated, originalBytes }` marker (ADR addition in
  step 15). Throwing would fail the user's action instead. Confirm the choice.
- **Audit actor for LOGIN_FAILED:** for an unknown email there is no user ID, and the ADR doesn't
  say whether that row is `USER` with a null `actor_id` or `SYSTEM`. The plan allows `USER` +
  null `actorId` and adds no DB CHECK on actor columns. The auth task should settle this.
- **Mask formats beyond the ADR examples:** the plan picks a fixed six-bullet prefix (it hides
  length), `MASK` for short values, and `'•••'` for malformed emails. The phone format is
  `••••••123`.
- **Denylist breadth:** only the ADR's keys (plus case and `_`/`-` variants). `refreshToken`,
  `apiKey`, `secret` etc. are not included. Add them when such fields appear.
- **Schema-diff test vs TypeORM quirks:** jsonb defaults or enum handling can make `log()` report
  spurious queries. Z must fix the entity/migration pair by regenerating, not by editing a
  committed migration, and must report anything it cannot resolve rather than delete the
  assertion.
- **Postgres version:** with `installExtensions: false`, the schema relies on the built-in
  `gen_random_uuid()` (Postgres 13+). The e2e global setup's `DROP DATABASE ... WITH (FORCE)`
  also needs Postgres 13+, and the `DB_USER` role needs the `CREATEDB` privilege (the compose
  `POSTGRES_USER` is a superuser, so this holds locally). Compose pins 16. An older server or a
  role without CREATEDB (e.g. in CI) would fail at migration time or when global setup starts.
- **Stale port fallback:** `validateEnv` now rejects `PORT=0` or a non-numeric `PORT` at
  startup. The `|| DEFAULT_PORT` fallback in `src/main.ts` and the comment in
  `src/common/constants.ts` ("Used when PORT is unset, zero or not a number") are therefore
  partly stale: only the "unset" case still reaches it, and `validateEnv` already defaults that
  case to 3000. The plan keeps `main.ts`/`constants.ts` out of scope (smallest change). A
  follow-up could have `main.ts` read the typed `PORT` via `getOrThrow<number>('PORT')` and drop
  `DEFAULT_PORT`. Say if that should be folded into this task.
- **Migration split is manual:** step 13 splits generated DDL by hand. The "No changes" re-check
  and the e2e schema-diff and revert specs are the safety net. Z reports any statement it
  cannot place.
- **`typecheck` is not in `/verify`:** `nest build` skips `test/`. ts-jest and typed ESLint
  catch most test type errors, but a full `tsc` check of `test/` runs only through
  `npm run typecheck`. Adding it to `.claude/skills/verify/SKILL.md` is left to the user.
- **Testing ADR says "real Postgres + Redis":** this task uses Postgres only and no Supertest,
  because there are no endpoints or queues yet. `supertest` arrives with the first HTTP task.

## Revision notes
- **Round 1 (review CHANGES_REQUESTED):**
  - Blocker, e2e guard ran twice and failed (step 16): adopted option (a). The new pure function
    `resolveTestDatabaseEnv` records the dev name in `DB_NAME_ORIGINAL` on the first call and
    compares `DB_NAME_TEST` against that on every call, so the second call (in each test context,
    after Jest copies global-setup's env) is a no-op instead of a false failure. The guard keeps
    its full strength. Added `test/test-env.e2e-spec.ts` (Tests, package Z). It covers the denied
    cases (`DB_NAME_TEST === DB_NAME`, `=== DB_NAME_ORIGINAL`, no `_test` suffix, uppercase,
    missing) and a second-call regression case.
  - Blocker, migration procedure (step 13): spelled out the order. Create an empty typed
    `migrations` index first; generate one scratch `InitialSchema` migration against an empty dev
    DB; split its statements by hand into `CreateUsers` and `CreateAuditLogs`, with reverse-order
    `down()`, and `CreateAuditLogs.down()` must not drop `user_role`; append the trigger SQL;
    delete the scratch file; fill the index; re-run generate and expect "No changes". The
    two-file layout is kept, so the package Z file list is unchanged.
  - Suggestions applied:
    - `typecheck` is now `tsc --noEmit --incremental false -p tsconfig.json` (step 1).
      Superseded in round 2.
    - `installExtensions: false` (step 12). The pgcrypto privilege risk is replaced by a
      Postgres 13+ note.
    - `insertIfAbsent` uses `.returning('id')` and decides from `result.raw.length > 0`; the unit
      mock was aligned (steps 8 and Tests).
    - The stale `DEFAULT_PORT` fallback and comment are noted in Risks; `main.ts` stays out of
      scope.
    - Seed failures log a `redact()`-ed `{ name, code, message }` and never TypeORM
      `parameters`/`query`/`detail` (step 14, Security notes).
- **Round 2 (review CHANGES_REQUESTED):**
  - Blocker, `typecheck` would hit TS5069: step 2 now moves `incremental` and `tsBuildInfoFile`
    (alongside `rootDir`) from `tsconfig.json` into `tsconfig.build.json`, and step 1's script is
    `tsc --noEmit -p tsconfig.json`. `nest build` stays incremental with its build info in
    `dist/` (cleared by `deleteOutDir`), and typecheck never touches build info. Both files are
    still in package A.
  - Step 13.2: the implementer must stop and ask the user if the dev DB is not empty, and never
    run `docker compose down -v` on its own.
  - Step 16: `global-setup.ts` is `export default async function globalSetup(): Promise<void>`.
    Both the maintenance connection and the migration DataSource are destroyed in a `finally`,
    and errors are rethrown.
  - Step 10: `actorRole` spells out `enumName: 'user_role'` (plus `enumName` on `actorType` and
    `action`), so TypeORM never generates an `audit_logs_actor_role_enum`.
  - Risks: the Postgres-version note now also covers `DROP DATABASE ... WITH (FORCE)` (PG 13+)
    and the `CREATEDB` privilege.
