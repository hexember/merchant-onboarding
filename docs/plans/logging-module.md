# Logging module: masked JSON logs to the terminal, pluggable outputs

## Goal
Once the logger is attached at startup, every log line the app writes goes through one
`LoggingModule` (`src/logging/`). That covers Nest internals, `new Logger(ctx)` calls such as
`SeedService`, the seed entry point, and a new global exception filter. A failure inside
`NestFactory.create` itself, before the logger is attached, is still printed by Nest's default
logger in plain text (see Risks). Each line is **one JSON object** (`LogEntry`) written to the terminal: `fatal`/`error`/`warn`
to stderr, everything else to stdout. There is no pretty mode. Before it is written, `meta` is
redacted and masked with the existing helpers (`redact()` then `maskSensitiveFields()`), and errors
are reduced to `name`, `message`, a string `code` and (outside production) `stack` by
`serializeError`. Outputs are transports behind a `LogTransport` interface, injected as an array
under the `LOG_TRANSPORTS` token, so a later log service is one new class plus one entry in the
factory list. A `LOG_LEVEL` env variable (default `log`) sets the minimum level. A global
`AllExceptionsFilter` returns `{ statusCode, error, message, code }` and never exposes internals
on a 500. No new dependency is added.

## Scope
- In:
  - `LOG_LEVEL` in `AppEnv` / `validateEnv`, with unit tests.
  - `src/logging/`: `log-entry.ts`, `log-transport.ts`, `console.transport.ts`,
    `log-sanitizer.ts`, `app-logger.service.ts`, `all-exceptions.filter.ts`, `logging.module.ts`,
    each with a unit spec next to it.
  - Wiring: `src/app.module.ts`, `src/main.ts` (`bufferLogs` + `useLogger`),
    `src/database/seeds/seed.ts` (replace `describeError` with `serializeError`),
    `src/database/seeds/seed.module.ts` (import `LoggingModule`), and a new
    `src/database/seeds/report-seed-error.ts` (the seed's catch paths, unit-tested).
  - `test/setup/test-env.ts`: pin `LOG_LEVEL=log` for e2e runs.
  - `test/logging.e2e-spec.ts` (Supertest, test-only throwing controller).
  - Docs: one line in `docs/adrs/sensitive-data.md`, README section on `LOG_LEVEL` and the JSON
    format.
  - The exact `.env.example` lines for the user to add **by hand** (see Risks). No package owns
    that file.
- Out:
  - A request-logging interceptor (access logs per request). The sensitive-data ADR mentions one;
    it is a later task.
  - Any non-console transport (file, HTTP, log service), choosing transports from env, a pretty or
    coloured mode, log rotation, correlation/request IDs.
  - Domain error classes and their codes (the filter only handles `HttpException` and unknown
    errors; domain errors arrive with the API task).
  - Masking free-text inside `message` strings (see Risks).
  - Any new dependency, controller, endpoint, migration or ADR file.

## ADR references
- docs/adrs/sensitive-data.md §Never logged: "`password`, `passwordHash`, `accessToken`, the
  `Authorization` header and the JWT secret" are never logged, and `redact()` "is applied ... in the
  exception filter". `sanitizeForLog` runs `redact()` first on every `meta`, and the filter logs
  through `AppLogger`, so it inherits the same pass. The filter logs only the method and
  `req.path`, so no header (`Authorization`, `Cookie`), body, query string or params ever reaches a
  log entry.
- docs/adrs/sensitive-data.md §Masked: `taxId`/`ownerNationalId` → last 4, `ownerEmail` →
  `j•••@example.com`, `ownerPhone` → last 3. `sanitizeForLog` then runs `maskSensitiveFields()`
  so logs get the same masks as API responses and audit `meta`. It reuses `src/common/mask.ts`,
  not a second copy of the rules.
- docs/adrs/sensitive-data.md (TypeORM errors): `serializeError` picks `name`, `message`, string
  `code` and `stack` explicitly and never copies enumerable fields. That keeps TypeORM's `query`,
  `parameters` (which can hold a bcrypt hash), `driverError` and `detail` out of logs, which is
  the same reason `describeError` exists in `seed.ts` today.
- docs/adrs/auth.md: no route, guard or scoped lookup is added or changed. The filter returns
  whatever status an `HttpException` carries, so the later 401/403/404 rules (including "out of
  scope → 404, same as unknown ID") keep their status and message unchanged.
- docs/adrs/testing.md §Unit: "masking/redaction" is unit-tested here for the log path. No authz
  rule is touched, so none of the listed bypass cases applies. Tests are deterministic: no sleeps,
  no randomness, and the timestamp is checked by format, not value.
- `.claude/rules/api.md`: "Domain errors are mapped by the global filter to
  `{ statusCode, error, message, code }`". `AllExceptionsFilter` is that global filter.
- `.claude/rules/typescript.md`: no `any`; explicit return types; one module per feature
  (`src/logging/logging.module.ts`); constructor injection (`AppLogger` gets `ConfigService` and
  `LOG_TRANSPORTS`); config only through `ConfigService` (the logger reads `LOG_LEVEL` and
  `NODE_ENV` from it, never `process.env`).
- `.claude/rules/general.md`: no new dependency (JSON via `JSON.stringify`, output via
  `process.stdout.write`/`process.stderr.write`).

## ADR conflicts
None that contradict ADR text. Two notes:
- docs/adrs/sensitive-data.md names a "request-logging interceptor". This plan does not build it
  (see Scope); that is a gap the ADR already expects to be filled later, not a contradiction.
- The ADR lists masking for "API responses and audit `meta`" only. This plan also masks logs. That
  is stricter, not contrary. The ADR edit (step 13) adds one line so the ADR states it:
  "- **Logs:** every log line the app writes after startup goes through `LoggingModule`
  (`src/logging/`). `meta` passes through `sanitizeForLog`: any nested `Error` is serialized, then
  `redact()` and `maskSensitiveFields()` run. Errors go through `serializeError` (name, message,
  code, and the stack outside production only). The global `AllExceptionsFilter` logs only the
  request method, path, status and `code`. If the seed fails before its Nest context exists, it writes one
  line through the same JSON console writer, using `serializeError` without a stack."

## Steps
1. `src/logging/log-entry.ts`: new file.
   - `export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;`
     in severity order (index 0 is most severe).
   - `export type LogLevel = (typeof LOG_LEVELS)[number];`
   - `export function isLogLevel(value: string): value is LogLevel`.
   - `export interface SerializedError { name: string; message: string; code?: string; stack?: string }`.
   - `export interface LogEntry { timestamp: string; level: LogLevel; context?: string; message: string; meta?: Record<string, unknown>; error?: SerializedError }`.
   No imports from Nest, so `env.validation.ts` can import it.
2. `src/config/env.validation.ts` + `src/config/env.validation.spec.ts`:
   - Add `LOG_LEVEL: LogLevel` to `AppEnv`.
   - Add `readLogLevel(raw, name, defaultLevel, invalid): LogLevel`, following `readBoolean`:
     `undefined` or `''` returns the default; a string is trimmed and lowercased and accepted if
     `isLogLevel`; anything else pushes `name` onto `invalid` and returns the default.
   - In `validateEnv`: `LOG_LEVEL: readLogLevel(raw, 'LOG_LEVEL', DEFAULT_LOG_LEVEL, invalid)` with
     `const DEFAULT_LOG_LEVEL: LogLevel = 'log';`. The error keeps naming variables only.
   - `createDataSourceOptions` takes `DatabaseEnv` (a `Pick`), so nothing in `src/database/` changes.
   - Spec: cases listed under Tests. `validRaw()` stays unchanged so existing cases exercise the
     default.
3. `src/logging/log-transport.ts`: new file.
   - `export interface LogTransport { write(entry: LogEntry): void; }`
   - `export const LOG_TRANSPORTS = Symbol('LOG_TRANSPORTS');` with a comment: the value is a
     `LogTransport[]`; to add an output, write a class implementing `LogTransport`, provide it in
     `LoggingModule` and add it to the factory list.
4. `src/logging/console.transport.ts` + `src/logging/console.transport.spec.ts`:
   `@Injectable() export class ConsoleTransport implements LogTransport`. `write(entry)` writes
   `JSON.stringify(entry) + '\n'` to `process.stderr` when `entry.level` is `fatal`, `error` or
   `warn`, otherwise to `process.stdout`. No colours, no formatting options. The body is a plain
   exported function `writeLogLine(entry: LogEntry): void` that `ConsoleTransport.write` calls.
   The seed's pre-context fallback (step 11) calls the same function, so no provider is ever
   created with `new` (`.claude/rules/typescript.md`).
5. `src/logging/log-sanitizer.ts` + `src/logging/log-sanitizer.spec.ts`:
   - `export function sanitizeForLog(value: unknown): unknown` runs three passes in order:
     1. `replaceErrors(value)` (private, not exported): a deep copy that replaces every `Error`
        found anywhere in the value (top level, nested in an object, or inside an array) with
        `serializeError(err, { includeStack: false })`. Nested stacks are always dropped, since
        `sanitizeForLog` has no config. Plain objects and arrays are walked. A `WeakSet` of
        objects on the current path turns a circular reference into `'[Circular]'` (the same
        marker `redact()` uses), so a cycle that contains an `Error` ends. `Date` and primitives
        pass through for `redact()` to handle. Other non-plain objects are copied as plain objects
        of their own enumerable properties, which matches `redact()`. The input is never mutated.
     2. `redact()`.
     3. `maskSensitiveFields()`.
     Order matters. Errors are reduced before `redact()` copies enumerable fields, so `query`,
     `parameters`, `driverError` and `detail` can never reach a log line. Redaction runs before
     masking, so a denylisted key is never passed to a masker.
   - `export function serializeError(error: unknown, options: { includeStack: boolean }): SerializedError`.
     - Not an `Error` → `{ name: 'UnknownError', message: 'Non-error value thrown' }`. The thrown
       value itself is never included.
     - An `Error` → `name`, `message`, `code` only when `(error as { code?: unknown }).code` is a
       string, and `stack` only when `options.includeStack` and `error.stack` is a string.
     - It reads these four fields by name and never iterates the object, so enumerable fields
       (`query`, `parameters`, `driverError`, `detail`, a `password` property) are never copied.
     - `options` is required (no default), so every caller decides about the stack explicitly. The
       caller passes `NODE_ENV !== 'production'`; the function never reads env itself.
6. `src/logging/app-logger.service.ts` + `src/logging/app-logger.service.spec.ts`:
   `@Injectable() export class AppLogger implements LoggerService` (from `@nestjs/common`).
   - Constructor: `ConfigService` and `@Inject(LOG_TRANSPORTS) transports: LogTransport[]`. It
     reads `LOG_LEVEL` and `NODE_ENV` once through `config.getOrThrow` and keeps
     `minLevel` and `includeStack = nodeEnv !== 'production'`.
   - Public methods with explicit `void` returns: `log`, `error`, `warn`, `debug`, `verbose`,
     `fatal`, each `(message: unknown, ...optionalParams: unknown[])`.
   - Argument mapping: all six methods call one private
     `buildEntry(level, message, optionalParams): LogEntry`. It runs these steps **in this order**.
     For `error`, the stack and context rules follow Nest's
     `ConsoleLogger.getContextAndStackAndMessagesToPrint`
     (`node_modules/@nestjs/common/services/console-logger.service.js`). Applying the same stack
     rule to `fatal` is a deliberate deviation from Nest, which does not look for a stack in
     `fatal`. It is the safer choice: a stack passed to `fatal` is then also dropped in production,
     instead of being treated as the context or as leftover text.
     1. **Drop `undefined`:** `params = optionalParams.filter((p) => p !== undefined)`. This
        covers `new Logger('X').error(msg)`, which arrives as `error(msg, undefined, 'X')` and so
        becomes `[ 'X' ]`.
     2. **Stack (only for `error` and `fatal`), decided before the context:**
        - If `params.length >= 2` and the last two params are both strings, the second-to-last
          is the stack, whatever its format. Remove it from `params`.
        - Otherwise, if `params.length === 1`, it is a string, and it matches
          `STACK_PATTERN = /^(.)+\n\s+at .+:\d+:\d+/` (Nest's own pattern), it is the stack.
          Remove it. This is the two-argument `error(message, stack)` call that static
          `Logger.error` and Nest's `ExceptionsHandler` make.
        - In every other case there is no stack string.
     3. **Context:** if `params` is not empty and its last element is a string, that element is
        the `context`. Remove it.
     4. **Errors:** the first `Error` found in `message` or `params` becomes
        `entry.error = serializeError(err, { includeStack })` and is removed from `params`. Any
        further `Error`s stay in `params` and are handled by step 6, where `sanitizeForLog`
        serializes them. If there is no `Error` but step 2 found a stack string,
        `entry.error = { name: 'Error', message: <entry message> }`, plus `stack` only when
        `includeStack`. When `includeStack` is false the stack string is discarded and appears
        nowhere in the entry. When there is both an `Error` and a stack string, the `Error` wins
        and the stack string is discarded.
     5. **Message:** a string is used as-is. An `Error` gives `err.message`. Anything else (an
        object, a number, ...) goes to `meta.value` and the entry message is `''`.
     6. **Leftovers:** each remaining plain object (`isPlainObject`) is merged into `meta`, and
        later params win on key clashes. Every other remaining value (leftover strings, numbers,
        booleans, `null`, arrays, extra `Error`s, class instances) is appended in order to
        `meta.values`. Nothing is silently kept outside `meta`.
     7. **Sanitise:** if `meta` has any keys, `entry.meta = sanitizeForLog(meta)`, narrowed back to
        `Record<string, unknown>` with `isPlainObject`. Leftover strings in `meta.values` therefore
        go through the same pass as everything else. The message string is not scanned (see
        Risks). Inputs are never mutated, because every helper deep-copies.
     For `log`/`warn`/`debug`/`verbose`, step 2 is skipped, so
     `log('a', 'b', 'Ctx')` gives context `'Ctx'` and `meta.values: ['b']`.
   - Level filter: an entry is dropped when `LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf(minLevel)`.
   - `timestamp = new Date().toISOString()`.
   - Fan-out: for each transport, `try { t.write(entry) } catch { /* skip */ }`. The catch
     writes nothing (a failing transport must not cause recursive logging) and never rethrows.
   - Only these six methods are implemented (`setLogLevels` is optional in `LoggerService` and
     not needed, since `LOG_LEVEL` does the filtering).
7. `src/logging/all-exceptions.filter.ts` + `src/logging/all-exceptions.filter.spec.ts`:
   `@Catch() @Injectable() export class AllExceptionsFilter implements ExceptionFilter`, with
   `AppLogger` constructor-injected.
   - Only HTTP, using local types (no `express` import, because `@types/express` is not
     installed and no dependency is added):
     `interface HttpRequestLike { method: string; path: string }` and
     `interface HttpResponseLike { status(code: number): { json(body: unknown): unknown } }`,
     read through `host.switchToHttp().getRequest<HttpRequestLike>()` and
     `getResponse<HttpResponseLike>()`.
   - Non-HTTP contexts: the first statement is
     `if (host.getType() !== 'http') { throw exception; }`. The exception is rethrown unchanged,
     with no response and no log.
   - `const LOG_CONTEXT = 'AllExceptionsFilter';`. Reason phrases come from
     `STATUS_CODES` (`import { STATUS_CODES } from 'node:http'`, built in, so no dependency).
     `defaultCode(status)` returns the `HttpStatus` enum key (`HttpStatus[status]`, e.g.
     `'NOT_FOUND'`) when it is a string, else `'HTTP_ERROR'`. This default was already shown to
     the user and is kept.
   - Mapping, decided in this order:
     1. **`HttpException`:** `statusCode = exception.getStatus()`. From `exception.getResponse()`:
        - a string: `message` is that string;
        - an object: `message` is its `message` when that is a string or an array of strings.
          Otherwise (missing, a number, an object, a mixed array) it falls back to
          `exception.message`. `error` is its `error` if it is a string; `code` is its `code` if it
          is a string.
        - Defaults: `error = STATUS_CODES[statusCode] ?? 'Error'`, `code = defaultCode(statusCode)`.
        - **Route-not-found echo:** if `statusCode === 404` and `message` is a string starting with
          `'Cannot '`, it is replaced with `'Not Found'`. Nest's message echoes `originalUrl`,
          including the query string.
     2. **Client error that isn't an `HttpException`** (e.g. body-parser's 400/413): the value
        is an object whose numeric `status` or `statusCode` is in 400–499 and whose
        `expose === true`. If both `status` and `statusCode` are present, `status` wins. Use that
        status, with `error` and `message` both set to
        `STATUS_CODES[status]` (generic, never the error's own message) and
        `code = defaultCode(status)`.
     3. **Anything else:** `500`, `error: 'Internal Server Error'`,
        `message: 'Internal server error'`, `code: 'INTERNAL_ERROR'`. Nothing from the thrown
        value reaches the body.
   - Logging. `meta = { method: req.method, path: req.path, statusCode }` and nothing else: no
     headers, body, query string, params, IP or user, and no response `message`. The exact calls
     are:
     - status ≥ 500 and the exception is an `Error`:
       `logger.error('Unhandled exception', exception, meta, LOG_CONTEXT)`. `AppLogger` step 4
       runs `serializeError` on it. The second-to-last param is an object, so no stack string is
       detected.
     - status ≥ 500 and the exception is not an `Error`:
       `logger.error('Unhandled non-error exception', meta, LOG_CONTEXT)`. Nothing taken from the
       thrown value is passed, so it can't be logged in any form.
     - 4xx (cases 1 and 2): `logger.warn('Request failed', { ...meta, code }, LOG_CONTEXT)`, with no
       error, stack or message.
   - Response: `res.status(statusCode).json({ statusCode, error, message, code })`.
8. `src/logging/logging.module.ts` + `src/logging/logging.module.spec.ts`:
   `@Global() @Module({ providers: [AppLogger, ConsoleTransport, { provide: LOG_TRANSPORTS, useFactory: (console: ConsoleTransport): LogTransport[] => [console], inject: [ConsoleTransport] }, { provide: APP_FILTER, useClass: AllExceptionsFilter }], exports: [AppLogger] })`.
   `ConfigService` comes from the global `ConfigModule` that each root module already registers.
   A comment marks the factory list as the plug-in point. The spec compiles the module with a
   test `ConfigModule` and checks `AppLogger` resolves and `LOG_TRANSPORTS` contains a
   `ConsoleTransport`.
9. `src/app.module.ts`: add `LoggingModule` to `imports`.
10. `src/main.ts`: `NestFactory.create(AppModule, { bufferLogs: true })`, then immediately
    `app.useLogger(app.get(AppLogger))` before anything else logs. Startup lines then come out as
    JSON once the logger is attached.
11. `src/database/seeds/report-seed-error.ts` + `src/database/seeds/report-seed-error.spec.ts` +
    `src/database/seeds/seed.module.ts` + `src/database/seeds/seed.ts`:
    - `report-seed-error.ts` (new) exports the two catch paths so they can be unit-tested.
      `const SEED_CONTEXT = 'Seed'`.
      - `export function logSeedFailure(logger: LoggerService, error: unknown): void`, which
        branches the same way as the filter:
        - `error instanceof Error`: `logger.error('Seed failed', error, SEED_CONTEXT)`. In
          AppLogger, step 4 serialises it with the env-based stack rule. The params are
          `[Error, 'Seed']`, so no stack string is detected.
        - anything else: `logger.error('Seed failed (non-error value thrown)', SEED_CONTEXT)`.
          Nothing from the value is passed, so a thrown object can't be merged into `meta` and a
          thrown string can't be taken for a stack.
      - `export function writeSeedFailureWithoutContext(error: unknown): void`, for when the Nest
        context was never created (env validation or DB connect failed during creation). It
        builds one `LogEntry`, `{ timestamp: new Date().toISOString(), level: 'error', context: SEED_CONTEXT, message, error: serializeError(error, { includeStack: false }) }`,
        and writes it with `writeLogLine` from `src/logging/console.transport.ts`. It uses the
        same branching:
        - `message` is `'Seed failed'` for an `Error`, else
          `'Seed failed (non-error value thrown)'`.
        - For a non-`Error`, `serializeError` returns its fixed `UnknownError` form, which holds
          nothing from the value.
        - The stack is always omitted, because config isn't available and `process.env` must
          not be read.
    - `seed.module.ts`: add `LoggingModule` to `imports` (`ConfigModule` is already there).
    - `seed.ts`: delete `describeError` and the module-level `new Logger('Seed')`.
      `createApplicationContext(SeedModule, { abortOnError: false, bufferLogs: true })`, then
      `app.useLogger(app.get(AppLogger))`. In `catch`:
      - if the context exists, `logSeedFailure(app.get(AppLogger), error)`;
      - otherwise, `writeSeedFailureWithoutContext(error)`;
      - `process.exitCode = 1` as today, and `finally` closes the context as today.
      `seed.ts` keeps no logic of its own beyond this choice.
    - `seed.service.ts` is unchanged: its `new Logger(SeedService.name)` is routed through
      `AppLogger` by `useLogger`.
12. `test/logging.e2e-spec.ts`: see Tests. A test-only `@Controller('logging-e2e-test')` class
    inside the spec with one `GET` route that throws an `Error` with enumerable `password` and
    `parameters` fields (fake values, e.g. `'fake-password-for-test'`), one route that throws
    `new NotFoundException()`, and one `POST` route that accepts a JSON body (used for the
    malformed-body check; the handler is never reached). Build like `test/swagger.e2e-spec.ts`:
    `Test.createTestingModule({ imports: [AppModule], controllers: [ThrowingController] })`,
    `createNestApplication<INestApplication<App>>({ bufferLogs: true })`,
    `app.useLogger(app.get(AppLogger))`, `app.init()`. Spy on `process.stderr.write` /
    `process.stdout.write` (mockImplementation returning `true`), restore in `afterEach`.
12a. `test/setup/test-env.ts`: in `applyTestDatabaseEnv()`, after `config({ quiet: true })`, set
    `process.env.LOG_LEVEL = 'log'`. It always overrides, the same way `DB_NAME` is overridden.
    That way a developer's `.env` (for example `LOG_LEVEL=error`) can't hide the `warn` lines
    the e2e tests assert on. `NODE_ENV` is not touched and stays at the e2e default. Add a short
    comment saying why. This is test setup, which the file header already allows to write
    `process.env`.
13. `docs/adrs/sensitive-data.md`: add the one "**Logs:**" bullet quoted under ADR conflicts.
14. `README.md`: a short "Logging" subsection under Getting started: one JSON object per line,
    fields (`timestamp`, `level`, `context`, `message`, `meta`, `error`), errors on stderr and the
    rest on stdout, `LOG_LEVEL=fatal|error|warn|log|debug|verbose` (default `log`), stacks omitted
    when `NODE_ENV=production`, sensitive keys redacted/masked, and "to add an output, implement
    `LogTransport` and add it to the `LOG_TRANSPORTS` factory in `src/logging/logging.module.ts`".

## Tests
- Unit, `src/config/env.validation.spec.ts`:
  - `LOG_LEVEL` defaults to `'log'` when unset and when `''`.
  - Each of the six levels is accepted; `' DEBUG '` gives `'debug'` (trim/case).
  - Invalid (denied): `it.each(['info', 'trace', '1', 'warning'])` throws naming `LOG_LEVEL`.
  - Invalid (denied): the error message does not contain the raw value (e.g. `'not-a-level-value'`).
- Unit, `src/logging/log-sanitizer.spec.ts`:
  - `password`, `accessToken`, `authorization` (and nested under an object and an array) become
    `REDACTED`.
  - `taxId` → `MASK + last 4`, `email` / `ownerEmail` → `j•••@example.com`, `ownerPhone` →
    `MASK + last 3`.
  - The input object is not mutated.
  - Nested `Error` in meta: `sanitizeForLog({ cause: err })`, where `err` has enumerable `query`,
    `parameters`, `driverError` and `detail`, gives `cause` equal to `{ name, message, code }`.
    `JSON.stringify` of the result contains none of those field names or their fake values, and
    has no `stack`.
  - `Error` inside an array: `sanitizeForLog({ errors: [err, 'ok'] })` gives
    `errors[0]` as the serialized form and `errors[1] === 'ok'`. A top-level `Error`
    (`sanitizeForLog(err)`) gives the serialized form too.
  - Circular structure containing an `Error`:
    `const o: Record<string, unknown> = { err }; o.self = o;` returns without throwing, `self` is `'[Circular]'`, `err` is serialized, and `parameters` is
    not in the result.
  - The input containing an `Error` is not mutated (the `Error` still has its `parameters`).
  - `serializeError` on an `Error` with enumerable `query`, `parameters`, `driverError`, `detail`
    and `password` returns exactly `{ name, message, code }` (string `code`) with
    `includeStack: false`; `Object.keys` equals that set.
  - With `includeStack: true`, `stack` is present; with `false`, absent.
  - A numeric `code` is dropped.
  - A non-`Error` thrown value (`'secret string'`, `{ password: 'x' }`) gives
    `{ name: 'UnknownError', message: 'Non-error value thrown' }` and contains neither input.
- Unit, `src/logging/console.transport.spec.ts` (spies on `process.stdout.write` and
  `process.stderr.write`, restored in `afterEach`):
  - `error`, `warn`, `fatal` go to stderr only; `log`, `debug`, `verbose` go to stdout only.
  - The written chunk ends in `'\n'` and `JSON.parse` of it equals the entry.
  - `writeLogLine(entry)` called directly behaves the same (stream choice and JSON line).
- Unit, `src/logging/app-logger.service.spec.ts` (fake `ConfigService` stub via `unknown` cast and
  a recording fake transport):
  - `log('msg')` → `{ level: 'log', message: 'msg' }`, no context.
  - `log('msg', 'Ctx')` → context `'Ctx'`.
  - `log('msg', { a: 1 }, 'Ctx')` → meta `{ a: 1 }`, context `'Ctx'`.
  - `error('msg', '<stack string>', 'Ctx')` → context `'Ctx'`, `error.stack` set when
    `NODE_ENV=development`, absent when `production`. A 3-arg call whose middle string is not
    stack-shaped (`error('msg', 'not a stack', 'Ctx')`) still treats it as the stack, which
    matches Nest.
  - Denied (production): `error('msg', '<stack string>')` (two args, stack-shaped, no context)
    under `NODE_ENV=production` has no `context`, and `JSON.stringify(entry)` contains no text from
    the stack (e.g. none of its `'    at '` frames or the fake file path).
  - `error('msg', '<stack string>')` under `development` → `error.stack` is that string, no
    `context`.
  - `error('msg', 'Ctx')` (two args, not stack-shaped) → context `'Ctx'`, no `error`.
  - `error('msg', undefined, 'Ctx')` (what `new Logger('Ctx').error('msg')` sends) → context
    `'Ctx'` and no `error` field.
  - `log('a', 'b', 'Ctx')` → context `'Ctx'`, `meta.values` is `['b']`. A leftover string is
    sanitised too: `log('a', { password: 'p' }, 'b', 'Ctx')` gives redacted `meta.password` and
    `meta.values: ['b']`.
  - `log('msg', undefined)` → no `meta`, no context.
  - `error(err, 'Ctx')` where `err` is an `Error` → message `err.message`, `entry.error` serialized,
    context `'Ctx'`.
  - `log({ a: 1 })` → message `''`, `meta.value` is `{ a: 1 }`.
  - `fatal('msg', '<stack string>')` under `production` → no stack text in the entry and no
    context (the deliberate `fatal` deviation).
  - `error('msg', err)` where `err` has enumerable `parameters` → `entry.error` is the serialized
    form and no `parameters` anywhere in the entry (`JSON.stringify` check).
  - `warn('msg', { password: 'p', taxId: 'TAX123456789' })` → meta redacted and masked.
  - `timestamp` is an ISO string (regex), `level` is set for each of the six methods.
  - Level filter: with `LOG_LEVEL=warn`, `log`/`debug`/`verbose` write nothing, `warn`/`error`/`fatal`
    write; with `verbose`, all six write.
  - Fan-out: two fake transports both receive the entry.
  - A transport that throws does not throw out of `log`, and the next transport still receives
    the entry.
  - The meta object passed in is not mutated.
- Unit, `src/logging/all-exceptions.filter.spec.ts` (fake `ArgumentsHost` with `switchToHttp()`
  returning a fake request `{ method, path, headers: { authorization: 'Bearer fake' }, body: { password: 'fake' }, query: { q: 'x' } }`
  and a fake response recording `status`/`json`; fake `AppLogger` recording calls):
  - Unknown `Error` with enumerable `password` → status 500, body exactly
    `{ statusCode: 500, error: 'Internal Server Error', message: 'Internal server error', code: 'INTERNAL_ERROR' }`;
    `logger.error` called once with `('Unhandled exception', exception, { method, path, statusCode: 500 }, 'AllExceptionsFilter')`.
  - Denied: a thrown string `'fake-secret-string'` → the generic 500 body, and
    `logger.error('Unhandled non-error exception', meta, 'AllExceptionsFilter')`. `JSON.stringify`
    of every logger call's arguments contains no `'fake-secret-string'`.
  - Denied: a thrown object `{ password: 'fake', detail: 'fake-detail' }` → the generic 500 body.
    `JSON.stringify` of every logger call's arguments contains neither `'fake'` as the password
    value nor `'fake-detail'`, nor the key `detail`.
  - `new NotFoundException()` → 404 with `error: 'Not Found'`, `code: 'NOT_FOUND'`; `logger.warn`
    called with `('Request failed', { method, path, statusCode: 404, code: 'NOT_FOUND' }, 'AllExceptionsFilter')`,
    and `logger.error` not called.
  - `new NotFoundException('Cannot GET /x?token=fake-query-token')` → response `message` is
    `'Not Found'`, and the response body contains no `'fake-query-token'`.
  - `new NotFoundException('Application not found')` keeps its message (only `Cannot ` messages are
    replaced).
  - A non-`HttpException` with `{ status: 413, expose: true }` (an `Error` with those fields) →
    413, `error` and `message` both `STATUS_CODES[413]`, `code: 'PAYLOAD_TOO_LARGE'`, logged with
    `warn`, not `error`.
  - The same shape with `expose: false`, or with `status: 503`, → the generic 500.
  - The 4xx warn call carries no `message` from the response.
  - `new HttpException({ message: 42 }, 400)` and `new HttpException({ message: { a: 1 } }, 400)`
    → response `message` is `exception.message` (falls back).
  - An `Error` with `{ status: 413, statusCode: 400, expose: true }` → 413 (`status` wins).
  - Non-HTTP host (`getType()` returns `'rpc'`): `catch` rethrows the same exception
    (`toThrow(sameInstance)`), the fake response is never called, and the logger is never called.
  - `new BadRequestException(['a must be a string'])` → 400 with the array `message` kept.
  - `new HttpException({ message: 'x', code: 'CUSTOM_CODE' }, 409)` → `code: 'CUSTOM_CODE'`.
  - Logged meta is exactly `{ method, path, statusCode }` (plus `code` on warn); `JSON.stringify`
    of every logger call contains neither `'Bearer fake'`, the body password nor the query.
- Unit, `src/logging/logging.module.spec.ts`: `AppLogger` resolves; `LOG_TRANSPORTS` is an
  array containing one `ConsoleTransport`.
- Unit, `src/database/seeds/report-seed-error.spec.ts`. `logSeedFailure` gets a recording fake
  `LoggerService`. `writeSeedFailureWithoutContext` is tested with spies on
  `process.stderr.write`/`process.stdout.write`, restored in `afterEach`.
  - `logSeedFailure(fake, err)` with an `Error` → exactly one call,
    `error('Seed failed', err, 'Seed')`.
  - Denied: `logSeedFailure(fake, { parameters: ['fake-hash'] })` → exactly one call,
    `error('Seed failed (non-error value thrown)', 'Seed')`. `JSON.stringify` of its arguments
    contains neither `'fake-hash'` nor `'parameters'`.
  - Denied: `logSeedFailure(fake, 'fake-secret-string')` → the same single call, with no
    `'fake-secret-string'` in its arguments.
  - Denied, end to end through the real logger: the two thrown values above passed to
    `logSeedFailure` with a real `AppLogger` (fake `ConfigService` with
    `NODE_ENV=development`, so stacks would be kept, plus a recording fake transport). Each gives
    one entry with context `'Seed'`, no `error.stack`, and `JSON.stringify(entry)` contains
    neither `'fake-hash'`, `'parameters'` nor `'fake-secret-string'`.
  - `writeSeedFailureWithoutContext(err)` where `err` has enumerable `parameters` → exactly one
    stderr line, nothing on stdout. It `JSON.parse`s to `level: 'error'`, `context: 'Seed'`,
    `message: 'Seed failed'`, and an `error` with name, message and code only (no `stack`, no
    `parameters`).
  - Denied: `writeSeedFailureWithoutContext({ parameters: ['fake-hash'] })` and
    `writeSeedFailureWithoutContext('fake-secret-string')` → one line, with message
    `'Seed failed (non-error value thrown)'`, `error.name: 'UnknownError'`, and neither value in
    the line.
- Integration, `test/logging.e2e-spec.ts` (Supertest, real Postgres test DB via `AppModule`):
  - `GET /logging-e2e-test/boom` returns 500 with the generic body exactly.
  - The captured stderr output for that request has a line that `JSON.parse`s to
    `level: 'error'`, `context: 'AllExceptionsFilter'`, `meta.method: 'GET'`,
    `meta.path: '/logging-e2e-test/boom'`, and the whole captured output contains neither the fake
    password, nor `parameters`, nor the request body or a sent `Authorization: Bearer fake-token`
    header value.
  - `GET /logging-e2e-test/missing` (NotFoundException) → 404 `{ statusCode: 404, error: 'Not Found', message, code: 'NOT_FOUND' }`
    and a `warn` line with no `error` field.
  - An unknown route → 404 with the same shape (Nest's own `NotFoundException` goes through the
    filter).
  - Denied: `GET /no-such-route?token=fake-query-token` → 404 with body `message: 'Not Found'`.
    Neither the response body nor any captured stdout/stderr line contains `'fake-query-token'` or
    `'?token'`. The warn line's `meta.path` is `'/no-such-route'`.
  - Denied: `POST /logging-e2e-test/echo` with `Content-Type: application/json` and the malformed
    body `{"password":"fake-password-for-test",` → a 400 response in the
    `{ statusCode, error, message, code }` shape. No captured stdout/stderr line contains
    `'fake-password-for-test'`.
  - Every captured line (stdout and stderr) parses as JSON.
  - No authz rule is touched, so docs/adrs/testing.md requires no extra denied cases.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2, 3, 4, 5 | src/logging/log-entry.ts, src/config/env.validation.ts, src/config/env.validation.spec.ts, src/logging/log-transport.ts, src/logging/console.transport.ts, src/logging/console.transport.spec.ts, src/logging/log-sanitizer.ts, src/logging/log-sanitizer.spec.ts | — |
| B  | 6, 7, 8 | src/logging/app-logger.service.ts, src/logging/app-logger.service.spec.ts, src/logging/all-exceptions.filter.ts, src/logging/all-exceptions.filter.spec.ts, src/logging/logging.module.ts, src/logging/logging.module.spec.ts | A |
| Z  | 9, 10, 11, 12, 12a, 13, 14 | src/app.module.ts, src/main.ts, src/database/seeds/report-seed-error.ts, src/database/seeds/report-seed-error.spec.ts, src/database/seeds/seed.ts, src/database/seeds/seed.module.ts, test/logging.e2e-spec.ts, test/setup/test-env.ts, docs/adrs/sensitive-data.md, README.md | A, B |

`.env.example` belongs to no package (see Risks). `src/database/seeds/seed.service.ts` is not
changed.

## Security notes
- **Never log sensitive data** (`.claude/rules/security.md`): `meta` always goes through
  `sanitizeForLog`. Any `Error` inside it, at any depth, is replaced with its serialized form, and
  then `redact()` and `maskSensitiveFields()` run. Errors pass `serializeError`, which reads four named fields only, so
  TypeORM `parameters` (bcrypt hashes) and `query` never reach output. The filter logs method,
  `req.path` and status only, never the response message, so `Authorization`, cookies, bodies
  and query strings are never logged. A thrown non-`Error` value is never passed to the logger,
  neither by the filter nor by the seed (`logSeedFailure` / `writeSeedFailureWithoutContext`).
  This keeps the guarantee `describeError` gives today.
  Stacks are dropped when `NODE_ENV=production`. That includes Nest's two-argument
  `error(message, stack)` call, which the stack-first mapping in step 6 catches before the stack
  could be taken as the context.
- **No internals in responses:** unknown errors return the fixed generic 500 body; their message
  is logged (sanitised) but never returned. Client errors that aren't `HttpException`s get the
  generic `STATUS_CODES` text, not their own message. A route-not-found 404 returns
  `'Not Found'` instead of echoing the URL and query string.
- **Config:** `LOG_LEVEL` and `NODE_ENV` are read only through `validateEnv`/`ConfigService`. The
  seed fallback path does not read `process.env`; it omits the stack instead. Env errors name the
  variable, never the value. `.env` is not read.
- **No secrets/PII in tests:** fake values only (`'fake-password-for-test'`, `TAX123456789`,
  `jane@example.com`), clearly labelled as fixtures.
- **Robustness:** a failing transport is swallowed silently so logging can't crash a request or
  recurse.
- **No authz change:** no route reaches application data; the e2e controller exists only inside
  the spec file.
- A security review is required on the combined change (logging + seed).

## Risks / open questions
- **`.env.example` (manual step for the user):** add by hand:
  ```
  # Minimum log level: fatal|error|warn|log|debug|verbose
  # LOG_LEVEL=log
  ```
- **Default `code` for an `HttpException` without one:** api.md requires a `code` but no ADR
  defines codes for framework exceptions. The plan uses the `HttpStatus` enum key (`NOT_FOUND`,
  `BAD_REQUEST`, ...). The user has been told and this stays; a later domain-error task may
  replace it.
- **Postgres messages can carry input values:** e.g. `invalid input syntax for type uuid: "..."`.
  `serializeError` keeps `message`, so on a 5xx log line such a value passes through. It is never
  in the response, and `parameters`/`query` are still dropped. Callers should validate input (for
  example UUID params) before it reaches a query, so these errors become 4xx and are logged
  without a message. Accepted for this task.
- **Malformed JSON path:** the plan expects body-parser's `SyntaxError` (`status: 400`,
  `expose: true`) to reach `AllExceptionsFilter`, either directly (case 2) or wrapped by Nest as
  a `BadRequestException` (case 1). In case 1 the response `message` may echo part of the body
  back to the sender. That is the sender's own data, and it is never logged, because 4xx logs
  carry no message. If the e2e test shows the error does not reach the filter at all, the
  implementer must report it rather than add middleware.
- **`message` strings are not scanned.** Redaction is key-based, so a caller who interpolates a
  secret into a message string (`` `token=${t}` ``) would leak it. The rule stays "put values in
  `meta`, never in the message"; the README states it. Nest's own internal messages carry no
  secrets.
- **Seed fallback without a container:** the approved design says the fallback writes "with
  `ConsoleTransport`". `.claude/rules/typescript.md` forbids `new`-ing a provider, so the plan
  writes through the exported `writeLogLine` function that `ConsoleTransport` itself uses (same
  output, no `new`). Flag it if the reviewer wants something else.
- **Seed `bufferLogs` (decided):** the seed keeps `bufferLogs: true`. If context creation fails
  before `useLogger` runs, Nest may flush its buffered startup lines in plain text. The seed's
  own failure line is JSON either way.
- **`main.ts` startup failures:** if `NestFactory.create` fails (for example invalid env or no
  DB), `useLogger` has not run yet. Nest's default logger then prints its buffered lines and the
  startup error in plain text, as with the seed note above. Accepted. Env validation errors name
  variables only, and TypeORM connect errors carry no query parameters at that point. JSON
  output is guaranteed from the moment `useLogger` runs.

## Revision notes
- **Revision 1 (coordinator decision on the open question about nested errors):**
  - Step 5: `sanitizeForLog` now starts with a private `replaceErrors` pass. It replaces every
    `Error` at any depth (top level, nested objects, arrays) with
    `serializeError(err, { includeStack: false })` before `redact()` and `maskSensitiveFields()`
    run. A circular reference becomes `'[Circular]'`. The reason: `redact()` copies an `Error`'s
    enumerable fields, so a nested TypeORM error's `query`/`parameters`/`driverError`/`detail`
    could otherwise reach a log line. Nested errors never carry a stack, because the sanitizer
    has no config. This stays in package A (`src/logging/log-sanitizer.ts` and its spec).
  - Tests: added sanitizer unit cases for a nested `Error` in meta, an `Error` inside an array, a
    top-level `Error`, a circular structure that contains an `Error`, and a check that the input
    is not mutated.
  - Removed the matching item from Risks. Updated Security notes and the proposed ADR bullet text
    to mention it.
- **Revision 2 (plan review round 1, CHANGES_REQUESTED):**
  - Step 6 is rewritten as one ordered `buildEntry` algorithm: drop `undefined`; decide the stack
    first for `error`/`fatal` using Nest's rules (with 3+ args the second-to-last string; with
    exactly 2 args only a string matching `/^(.)+\n\s+at .+:\d+:\d+/`); then take a trailing string
    as the context; then errors, the message, and leftovers. The orchestrator's decision is
    applied: leftover strings and other values go to `meta.values` and are sanitised. The reason:
    the old rules put the stack from `error(message, stack)` into `context`, where it was printed
    even in production. New AppLogger tests cover the production two-argument case,
    `error('msg', undefined, 'Ctx')` and leftover strings.
  - Step 7 now gives the exact log calls, with the context `'AllExceptionsFilter'` passed
    explicitly. A non-`Error` exception is logged with nothing taken from the value. New filter
    tests check that a thrown `'fake-secret-string'` and `{ password, detail }` appear in no logger
    call.
  - Step 7 uses local `HttpRequestLike`/`HttpResponseLike` types instead of `express` imports,
    because `@types/express` is not installed. The `express` risk is removed.
  - Step 7 additions (reviewer suggestions):
    - Route-not-found 404 messages starting with `Cannot ` become `'Not Found'`.
    - Non-`HttpException` errors with a 4xx `status`/`statusCode` and `expose === true` map to
      that status with a generic `STATUS_CODES` message and a warn log.
    - `STATUS_CODES` (`node:http`) is the default reason phrase.
    - The 4xx warn log carries no message.
  - New e2e cases: an unknown route with `?token=fake-query-token`, and a malformed JSON body
    containing a fake password. Neither value appears in captured output or the response. Step
    12 adds a `POST` route to the test controller for the malformed-body case.
  - Risks:
    - The seed `bufferLogs` question is closed (kept).
    - The `HttpStatus` key default for `code` is kept, with a note.
    - Added a note that Postgres messages can carry input values.
    - Added a note on the malformed-JSON path.
  - The step 13 ADR bullet now says "after startup" and mentions the seed's pre-context fallback.
  - The circular sanitizer test literal is now typed `Record<string, unknown>`.
- **Revision 3 (plan review round 2, CHANGES_REQUESTED, final round):**
  - Blocker: the seed passed whatever it caught to `AppLogger.error`. A thrown object would have
    been merged into `meta` with `parameters`/`query`/`detail` intact, and a thrown string could
    be taken as a stack. Step 11 now moves the catch logic into the new
    `src/database/seeds/report-seed-error.ts`, which has two functions:
    - `logSeedFailure(logger, error)` logs an `Error` as `error('Seed failed', error, 'Seed')`,
      and anything else as `error('Seed failed (non-error value thrown)', 'Seed')`, with nothing
      from the value.
    - `writeSeedFailureWithoutContext(error)` is the pre-context `writeLogLine` fallback and uses
      the same branching.
    - Unit tests are in `src/database/seeds/report-seed-error.spec.ts`, including thrown
      `{ parameters: ['fake-hash'] }` and `'fake-secret-string'` through both a fake logger and
      the real `AppLogger`.
    - Both new files are in package Z.
  - `test/setup/test-env.ts` (package Z, new step 12a) pins `LOG_LEVEL=log` for e2e runs and
    leaves `NODE_ENV` alone.
  - Step 6: using the stack rule for `fatal` is now described as a deliberate, safer deviation
    from Nest, with a test.
  - Step 7:
    - case 1 falls back to `exception.message` when `getResponse().message` is not a string or an
      array of strings;
    - case 2 uses `status` over `statusCode` when both are present;
    - non-HTTP hosts rethrow unchanged, with no response and no log;
    - unit tests added for each.
  - Step 13 ADR bullet: the filter's logged fields now include `code`.
  - Goal and Risks note that `main.ts` startup failures before `useLogger` are printed by Nest's
    default logger in plain text.

## Fix round 1 (security review)
This round supersedes the Goal sentence on plain-text `NestFactory.create` failures and the Risks
items on Postgres messages, the malformed-JSON path, seed `bufferLogs` and `main.ts` startup
failures.
- M1, `AppLogger.buildEntry`: a string is treated as a stack when it matches `/\n\s+at /`. A
  trailing string that contains `\n` is never a context: for `error`/`fatal` it becomes the stack,
  otherwise it is dropped. In production a stack-looking message becomes `'[stack omitted]'`, and
  a stack string anywhere in `meta` is replaced the same way.
- M2, `AllExceptionsFilter`: every 5xx `HttpException` gets the body `{ statusCode, error:
  STATUS_CODES[s], message: STATUS_CODES[s], code }`, where `code` is the response's string
  `code` or the default.
- M3, `seed.ts` and `main.ts`: both use `{ abortOnError: false, bufferLogs: true, autoFlushLogs:
  false }`, then `useLogger(app.get(AppLogger))` and `flushLogs()`. I checked this against the
  installed Nest source. `autoFlushLogs` defaults to true, and `ExceptionsZone.asyncRun` then
  flushes the buffer through the default logger. With the flag off, the buffer, including the
  TypeORM retry lines, is dropped on failure. `main.ts` catches startup failures, writes one
  line (through AppLogger, or `writeLogLine` + `serializeError` without a stack) and sets exit
  code 1. New spawn e2e cases in `test/logging.e2e-spec.ts` run the built seed and app with a fake,
  invalid env in an empty temporary directory.
- L1: a 400 whose message matches `/\bJSON\b/` becomes `'Malformed JSON body'`. Nest passes no
  `cause`, so the message is the only way to tell where the error came from. The router's
  `Failed to decode param '...'` 400 becomes `'Malformed URL parameter'`.
- L2: if `buildEntry` throws, a fallback entry is written instead. `writeLogLine` writes a
  `bigint` as a string and falls back to a fixed line. The filter's logger calls are wrapped, so
  the response is always sent.
- L3: the filter logs `route` (`baseUrl + route.path`, or `'[unmatched]'`) instead of `path`.
- L4: `serializeError` gives a database error (`QueryFailedError` or a `driverError`) the fixed
  message `'Database query failed'` and keeps its string `code`. Outside production, the stack's
  header line is rewritten the same way. Leftover string arguments are dropped and counted in
  `meta.droppedValues`.
- L5: the phone fixture is now `'+1-555-0100-123'`.
