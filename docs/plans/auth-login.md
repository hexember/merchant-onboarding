# Auth: login, JWT guard, roles guard and global validation

## Goal
`POST /auth/login` (public) checks an email and password against the seeded users and returns
`{ accessToken, expiresIn }`: an HS256 JWT signed with `JWT_SECRET`, expiring after 1h
(`expiresIn: 3600`), with only the claims `{ sub, role }`. Every failure returns the same generic
`401 Invalid credentials`. bcrypt `compare` runs even for an unknown email (against a dummy hash
made at startup). Each attempt writes a `LOGIN_SUCCEEDED` or `LOGIN_FAILED` audit row with the
email masked. `JWT_SECRET` is required by `validateEnv`. The app gets a global class-validator
`ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`), a global `JwtAuthGuard` (every
route needs a valid bearer token unless it is marked `@Public()`), a global `RolesGuard` driven by
`@Roles(...)` (403 for the wrong role) and a `@CurrentUser()` parameter decorator. The login route
has Swagger decorators. E2E tests cover login success and failure, the audit rows, a missing or
tampered token (401) and the wrong role (403), using a test-only protected controller.

## Scope
- In:
  - Dependencies `@nestjs/jwt`, `class-validator`, `class-transformer` (reasons under Steps 1).
  - `JWT_SECRET` in `validateEnv`/`AppEnv`. The e2e env setup generates a random secret at
    runtime when none is set.
  - New `UsersRepository.findByEmailWithPasswordHash`.
  - `BCRYPT_COST` moves to `src/common/password.ts`, so auth and the seed share it without auth
    importing from the seed.
  - New `src/auth/` feature module: controller, service, DTOs, guards, decorators and constants.
  - Global `ValidationPipe` registered as `APP_PIPE` in `AppModule`. Global guards registered as
    `APP_GUARD` in `AuthModule`.
  - Updates to existing e2e specs that the global guard and the new required variable would
    otherwise break (`test/logging.e2e-spec.ts`).
  - The edit to docs/adrs/database.md described under ADR conflicts. A README update (env
    variable, tech stack line).
  - The exact `.env.example` lines for the user to add **by hand**, listed under Risks. No package
    owns that file.
- Out:
  - Applications endpoints, `findAccessible`, refresh tokens, revocation, sign-up, rate limiting
    or lockout, a request-logging interceptor.
  - `src/main.ts`: nothing changes there, because the pipe and guards are module providers.
  - `docs/backlog.md` (the ship loop owns it), `.env.example` (agent cannot touch it).

## ADR references
- docs/adrs/auth.md §Auth details:
  - `POST /auth/login` returns `{ accessToken, expiresIn }`.
  - Tokens are HS256 (`algorithm: 'HS256'` to sign, `algorithms: ['HS256']` to verify, so `none`
    and other algorithms are refused), signed with `JWT_SECRET` from env, with 1h expiry
    (`JWT_EXPIRES_IN_SECONDS = 3600`) and claims `{ sub: user.id, role: user.role }` only.
  - No refresh tokens (out of scope).
  - Generic `401 Invalid credentials` for an unknown email and for a wrong password. The bodies
    are identical.
  - bcrypt `compare` runs against a dummy hash when the user does not exist.
  - Every failed login writes `LOGIN_FAILED` with `meta.email` masked via `maskEmail`.
- docs/adrs/auth.md §Authorization:
  - Layer 1 is the role guard: `@Roles(...)` plus `RolesGuard`, and the wrong role gets 403
    `FORBIDDEN`. Layer 2 (scoped repository) is untouched: no application lookups exist yet.
  - The matrix row `POST /auth/login` is public, so it gets `@Public()`.
  - DTO whitelist `whitelist: true, forbidNonWhitelisted: true` comes from the global
    `ValidationPipe`.
- docs/adrs/database.md §`users`:
  - `password_hash` stays `select: false`. Only the new `findByEmailWithPasswordHash` adds it
    explicitly (`addSelect`), and only `AuthService` calls it.
  - Emails are normalised before lookup (`normalizeEmail`).
- docs/adrs/database.md §`audit_logs`:
  - Rows go through `AuditLogService.record` (redact, mask, 8 KB cap). Actor columns: see ADR
    conflicts.
  - `entity_type = 'user'`.
  - A login changes no state, so there is no transaction to share (no `manager` argument).
- docs/adrs/sensitive-data.md:
  - The password, the hash, `accessToken`, the `Authorization` header and `JWT_SECRET` are never
    logged or put in audit `meta`.
  - Guard errors use fixed messages: the `jsonwebtoken` error text is never echoed.
  - Env validation errors name `JWT_SECRET`, never its value.
  - The exception filter already logs only the method, route pattern, status and code.
- docs/adrs/testing.md §Integration:
  - "login" is covered.
  - "no token or a tampered token → 401" is covered.
  - The wrong role → 403 is the denied case for the new role guard. Today's matrix rows that use
    it (e.g. SALES cannot assign) need endpoints from later tasks, so a test-only controller
    proves the guard now.

## ADR conflicts
- docs/adrs/database.md §`audit_logs`, `actor_id` row: "set when actor_type = USER; null for
  SYSTEM". A `LOGIN_FAILED` row has no authenticated actor. For an unknown email there is not even
  a user id. Decision (matches the existing `assertValidAuditEntry`, which already allows a USER
  row with a null `actorId`):
  - `LOGIN_SUCCEEDED`:
    - `actorType USER`, `actorId = user.id`, `actorRole = user.role`
    - `entityType 'user'`, `entityId = user.id`
    - `meta { email: maskEmail(email) }`
  - `LOGIN_FAILED`:
    - `actorType USER`, `actorId null`, `actorRole null` (the caller never authenticated)
    - `entityType 'user'`, `entityId` = the matched user's id for a wrong password, `null` for an
      unknown email
    - `meta { email: maskEmail(email) }`

  Proposed ADR edit (made in package Z), replacing the `actor_id` notes cell:
  `set when actor_type = USER; null for SYSTEM, and null for LOGIN_FAILED (the caller is not
  authenticated; entity_id names the targeted user when the email matched one)`.
  The `actor_role` cell gains: `null when actor_id is null`. No schema change: the column is
  already nullable. This is a wording clarification of existing behaviour, not a design change.

## Steps
1. `package.json` (+ `package-lock.json` via `npm install`): add dependencies.
   - `@nestjs/jwt`: Nest's wrapper around `jsonwebtoken`; it ships its own types, so no
     `@types/*` is needed.
   - `class-validator`: DTO validation, required by the ADR whitelist.
   - `class-transformer`: `ValidationPipe` requires it at runtime to build DTO instances.

   Deliberately **not** added: `@nestjs/passport`, `passport`, `passport-jwt` and their types. A
   plain `CanActivate` guard calling `JwtService.verifyAsync` does the same job with three fewer
   packages, and the guard stays explicit and easy to unit-test.

   This lives in package A (not the final one), because B's code and unit tests cannot compile
   without these packages.
2. `src/config/env.validation.ts`:
   - Add `JWT_SECRET: string` to `AppEnv`.
   - New reader `readSecret(raw, name, minLength, invalid)`: required, a string, not blank after
     trimming, and raw length `>= JWT_SECRET_MIN_LENGTH` (`32`, exported). Otherwise it pushes
     the name onto `invalid`; the error names the variable, never the value.
   - Wire it as `JWT_SECRET: readSecret(raw, 'JWT_SECRET', JWT_SECRET_MIN_LENGTH, invalid)`.
   - The value is returned as given (no trimming), so the signing key is exactly what was
     configured.
3. `src/config/env.validation.spec.ts`:
   - `validRaw()` gains `JWT_SECRET: JWT_SECRET_FIXTURE`, an obviously fake constant built as
     `'fixture-'.padEnd(JWT_SECRET_MIN_LENGTH, 'x')`.
   - New cases are listed under Tests.
4. `test/setup/test-env.ts`:
   - Add exported `ensureTestJwtSecret(env: Record<string, string | undefined>, generate: () =>
     string = () => randomBytes(32).toString('hex')): string`. It returns `env.JWT_SECRET` when
     non-empty, otherwise `generate()`.
   - `applyTestDatabaseEnv()` sets `process.env.JWT_SECRET = ensureTestJwtSecret(process.env)`
     right after `config({ quiet: true })`. A secret from `.env` or the shell wins. Otherwise a
     64-hex-char random secret is created at runtime; it is never written to disk or printed.
   - The second call (setupFiles after globalSetup) sees the value already set and keeps it, so
     one process uses one secret.
   - The random value never decides an assertion: tests sign and verify through the same app's
     `JwtService`.
5. `test/test-env.e2e-spec.ts`: add a `describe('ensureTestJwtSecret')` block (pure, injected
   generator; cases under Tests).
6. `src/common/password.ts` (new): `export const BCRYPT_COST = 12;` with a one-line comment (shared
   by the seed and the login dummy hash, so both cost the same time).
7. `src/database/seeds/seed.service.ts`: replace the local constant with
   `export { BCRYPT_COST } from '../../common/password';` plus an import for local use. Existing
   imports and behaviour stay the same.
8. `src/users/users.repository.ts`: add
   `findByEmailWithPasswordHash(email: string): Promise<User | null>`.
   - Query: `createQueryBuilder('user').addSelect('user.passwordHash').where('user.email =
     :email', { email: normalizeEmail(email) }).getOne()`.
   - Doc comment: for login only; never return its result from an endpoint.
   - Update the class comment: there is still no find-by-id.
9. `src/users/users.repository.spec.ts`: unit cases for the new method (mocked query builder).
10. `src/auth/auth.constants.ts` (new):
    - `JWT_ALGORITHM = 'HS256' as const`
    - `JWT_EXPIRES_IN_SECONDS = 3600`
    - `INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials'`
    - `IS_PUBLIC_KEY = 'isPublic'`
    - `ROLES_KEY = 'roles'`
11. `src/auth/auth-user.ts` (new):
    - `export interface AuthUser { id: string; role: UserRole }`
    - `export interface JwtClaims { sub: string; role: UserRole }`
    - Pure `toAuthUser(payload: unknown): AuthUser | null`. It returns null unless `payload` is an
      object with a non-empty string `sub` and a `role` that is a `UserRole` value
      (`Object.values(UserRole).includes(...)`). Extra claims (`iat`, `exp`) are ignored.
12. `src/auth/decorators/public.decorator.ts`: `Public = (): CustomDecorator =>
    SetMetadata(IS_PUBLIC_KEY, true)`.
    `src/auth/decorators/roles.decorator.ts`: `Roles = (...roles: UserRole[]): CustomDecorator =>
    SetMetadata(ROLES_KEY, roles)`.
    `src/auth/decorators/current-user.decorator.ts`:
    - Exported pure `currentUserFromContext(ctx: ExecutionContext): AuthUser` reads `request.user`
      and throws `UnauthorizedException()` if it is missing (defensive; the guard normally
      guarantees it).
    - `CurrentUser = createParamDecorator((_data: unknown, ctx) => currentUserFromContext(ctx))`.
13. `src/auth/guards/jwt-auth.guard.ts` (new) `JwtAuthGuard implements CanActivate`, injecting
    `Reflector` and `JwtService`:
    - `@Public()` on the handler or class (`getAllAndOverride`) → allow.
    - Read the `authorization` header from a local request shape (`{ headers: Record<string,
      string | string[] | undefined>; user?: AuthUser }`, no express types). It must be a single
      string `Bearer <token>`: the scheme is case-insensitive, with exactly one space and a
      non-empty token. Otherwise `throw new UnauthorizedException()`.
    - `await jwtService.verifyAsync(token, { algorithms: [JWT_ALGORITHM] })`. Any error →
      `UnauthorizedException()`; the library message is never passed on, so "jwt expired" or
      "invalid signature" is not echoed.
    - `toAuthUser(payload)` null → `UnauthorizedException()`.
    - Otherwise set `request.user` and return true.
    - The body is the filter's `{ statusCode: 401, error: 'Unauthorized', message:
      'Unauthorized', code: 'UNAUTHORIZED' }`. No logging here: the filter logs the warn line.
    - Then `usersRepository.findAuthUserById(sub)` (auth-only, selects `id` and `role`); no row →
      `UnauthorizedException()`; `request.user` takes `id` and `role` from that row (Fix round).
14. `src/auth/guards/roles.guard.ts` (new) `RolesGuard implements CanActivate`, injecting
    `Reflector`:
    - `@Public()` → allow.
    - No `@Roles` metadata (`getAllAndOverride<UserRole[]>(ROLES_KEY, [handler, class])`) or an
      empty list → allow (any authenticated user).
    - No `request.user` → `UnauthorizedException()`.
    - Role not in the list → `ForbiddenException()` (403, code `FORBIDDEN`).
15. `src/auth/dto/login.dto.ts` (new) `LoginDto`:
    - `@ApiProperty({ example: 'sales@example.com', maxLength: 254 }) @IsEmail() @MaxLength(254)
      email!: string`
    - `@ApiProperty({ format: 'password', maxLength: 128 }) @IsString() @IsNotEmpty()
      @MaxLength(128) password!: string`, with no example value.

    `src/auth/dto/login-response.dto.ts` (new) `LoginResponseDto`:
    - `@ApiProperty({ description: 'HS256 JWT; send as Authorization: Bearer <token>' })
      accessToken!: string`
    - `@ApiProperty({ example: 3600, description: 'Lifetime in seconds' }) expiresIn!: number`
16. `src/auth/auth.service.ts` (new) `AuthService implements OnModuleInit`, injecting
    `UsersRepository`, `AuditLogService` and `JwtService`.
    - `onModuleInit()`: `this.dummyHash = await bcrypt.hash(randomBytes(32).toString('hex'),
      BCRYPT_COST)`. It is computed once per process, never hardcoded, never logged, and has the
      same cost as real hashes, so the compare takes about the same time.
    - `async login(email: string, password: string): Promise<LoginResponseDto>`:
      1. `user = await usersRepository.findByEmailWithPasswordHash(email)`.
      2. `matches = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash)`. It
         always runs exactly once.
      3. If `!user || !matches`:
         - `auditLogService.record({ actorType: USER, actorId: null, actorRole: null, action:
           LOGIN_FAILED, entityType: 'user', entityId: user?.id ?? null, meta: { email:
           maskEmail(normalizeEmail(email)) } })`
         - then `throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE)`.
      4. Otherwise:
         - `record({ actorType: USER, actorId: user.id, actorRole: user.role, action:
           LOGIN_SUCCEEDED, entityType: 'user', entityId: user.id, meta: { email: maskEmail(...)
           } })`
         - `accessToken = await jwtService.signAsync({ sub: user.id, role: user.role } satisfies
           JwtClaims)`
         - return `{ accessToken, expiresIn: JWT_EXPIRES_IN_SECONDS }`.
    - Never log the password, hash, token or raw email. There is no logger call in this service.
17. `src/auth/auth.controller.ts` (new) `@ApiTags('auth') @Controller('auth') AuthController`,
    with `@Post('login') @Public() @HttpCode(HttpStatus.OK)`:
    - Swagger: `@ApiOperation`, `@ApiOkResponse({ type: LoginResponseDto })`,
      `@ApiUnauthorizedResponse({ description: 'Invalid credentials' })` and
      `@ApiBadRequestResponse({ description: 'Validation failed' })`.
    - Body: `login(@Body() dto: LoginDto): Promise<LoginResponseDto>`, which only calls
      `authService.login(dto.email, dto.password)` (thin controller).
    - No `@ApiBearerAuth`, because the route is public.
18. `src/auth/auth.module.ts` (new):
    - imports: `UsersModule`, `AuditModule` and
      `JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config) => ({ secret:
      config.getOrThrow<string>('JWT_SECRET'), signOptions: { algorithm: JWT_ALGORITHM,
      expiresIn: JWT_EXPIRES_IN_SECONDS }, verifyOptions: { algorithms: [JWT_ALGORITHM] } }) })`
    - controllers: `[AuthController]`
    - providers: `AuthService`, `{ provide: APP_GUARD, useClass: JwtAuthGuard }`, then
      `{ provide: APP_GUARD, useClass: RolesGuard }`. The order matters: authentication runs
      before roles. The comment says so.
    - exports: none needed (decorators and the `AuthUser` type are plain imports).
19. `src/app.module.ts`:
    - Import `AuthModule`.
    - Add `providers: [{ provide: APP_PIPE, useFactory: () => new ValidationPipe({ whitelist:
      true, forbidNonWhitelisted: true, transform: true }) }]`.
    - Registered in the module, not `main.ts`, so every e2e app built from `AppModule` gets the
      same pipe and guards.
20. `test/logging.e2e-spec.ts`:
    - Mark the test-only `ThrowingController` `@Public()`. Without it the global guard turns the
      500/404 cases into 401.
    - In `INVALID_ENV` add `JWT_SECRET: randomBytes(32).toString('hex')`, generated once in the
      `describe`. This keeps the expected message exactly `Invalid or missing environment
      variables: DB_PASSWORD`, without a hardcoded secret or the developer's value.
21. `test/auth.e2e-spec.ts` (new): full app from `AppModule`, plus a test-only
    `AuthProbeController` declared in the spec:
    - `GET /auth-e2e-test/me` (no `@Roles`) returns `@CurrentUser()`.
    - `GET /auth-e2e-test/admin-only` has `@Roles(UserRole.ADMIN)` and returns `{ ok: true }`.

    Setup:
    - `resetTables` runs before each test.
    - Users are created through `app.get(UsersRepository).insertIfAbsent` with
      `bcrypt.hash(config.getOrThrow('SEED_SALES_PASSWORD' | 'SEED_ADMIN_PASSWORD'),
      BCRYPT_COST)`. Passwords come from env through `ConfigService`. A missing variable makes
      the test fail and names the variable.
    - A wrong password is derived as `${password}-wrong`.
    - Tokens for the SALES and ADMIN probe calls come from real `POST /auth/login` requests, not
      from `signAsync`. Only the deliberately bad tokens (expired, wrong secret, `alg: none`,
      tampered) are built by hand.
    - Expired token, exact call: `await app.get(JwtService).signAsync({ sub, role }, { expiresIn:
      -60 })`. `jsonwebtoken` accepts the negative integer and sets `exp = iat - 60`. There is
      **no** `exp` in the payload: `@nestjs/jwt` merges the module's `signOptions.expiresIn:
      3600` into every call, and `jsonwebtoken` throws `Bad "options.expiresIn" option the payload
      already has an "exp" property` if both are set. `expiresIn: undefined` is rejected too.
    - Tampered token: take a valid SALES token from login, split it on `.`, and replace the
      payload segment with the base64url JSON of the decoded payload with `role: 'ADMIN'`. Keep
      the original header and signature. This proves that a role escalation is refused.
    - stdout/stderr are spied, as in the logging spec.

    Cases are under Tests.
22. `docs/adrs/database.md`: the `actor_id` / `actor_role` wording from ADR conflicts.
23. `README.md`:
    - Getting started:
      - `JWT_SECRET` (at least 32 characters) is required.
      - Replace the `JWT_SECRET=change-me` placeholder from `.env.example`, e.g. with the output
        of `openssl rand -base64 48`; the app refuses to start with the placeholder.
      - The e2e run generates a secret at runtime if none is set.
    - Tech stack: `JWT (passport-jwt)` becomes `JWT (@nestjs/jwt)`.
    - Add a short "Auth" paragraph: `POST /auth/login`, a bearer token on every other route,
      `@Public()` / `@Roles()`.

## Tests
- Unit, `src/config/env.validation.spec.ts`:
  - accepts a `JWT_SECRET` of exactly 32 characters and returns it unchanged
  - denied: missing `JWT_SECRET` → error names `JWT_SECRET`
  - denied: empty string → names it
  - denied: 31 characters → names it
  - denied: non-string → names it
  - the error never contains the secret value (assert with a 10-char sentinel)
  - existing cases still pass with the fixture added
- Unit, `test/test-env.e2e-spec.ts` (`ensureTestJwtSecret`, injected generator):
  - keeps an existing value and does not call the generator
  - an unset or empty value → returns the generator's output
- Unit, `src/users/users.repository.spec.ts`:
  - `findByEmailWithPasswordHash` normalises the email (`' Sales@Example.COM '` →
    `sales@example.com`) and calls `addSelect('user.passwordHash')`
  - returns null when `getOne` resolves null
- Unit, `src/auth/auth-user.spec.ts` (`toAuthUser`):
  - valid `{ sub, role, iat, exp }` → `{ id, role }`
  - denied, each → null: missing `sub`, empty `sub`, numeric `sub`, unknown role `'SUPERUSER'`,
    missing role, `null`, a string, an array
- Unit, `src/auth/guards/jwt-auth.guard.spec.ts` (mocked `Reflector` and `JwtService`):
  - `@Public()` → true, and `verifyAsync` is not called
  - valid token → true, `request.user` is set to `{ id, role }`, and `verifyAsync` was called
    with `{ algorithms: ['HS256'] }`
  - lowercase `bearer` scheme accepted
  - denied → `UnauthorizedException`, each:
    - no header
    - `Basic abc`
    - `Bearer` with no token
    - `Bearer a b`
    - array header
    - `verifyAsync` rejects (the message is `Unauthorized`, not the library text)
    - payload with an invalid role
- Unit, `src/auth/guards/roles.guard.spec.ts`:
  - `@Public()` → true
  - no `@Roles` → true
  - role in the list → true
  - denied: role not in the list → `ForbiddenException`
  - denied: `@Roles` set but no `request.user` → `UnauthorizedException`
- Unit, `src/auth/decorators/current-user.decorator.spec.ts` (`currentUserFromContext`):
  - returns `request.user`
  - denied: missing user → `UnauthorizedException`
- Unit, `src/auth/dto/login.dto.spec.ts` (`plainToInstance` + `validate` with `{ whitelist: true,
  forbidNonWhitelisted: true }`):
  - valid passes
  - denied: invalid email, missing password, empty password, 129-char password, 255-char email,
    extra property `role` (error names `role`)
- Unit, `src/auth/auth.service.spec.ts` (`jest.mock('bcrypt')`, mocked repository, audit service
  and `JwtService`; no real secret):
  - `onModuleInit` hashes with `BCRYPT_COST`
  - success:
    - returns `{ accessToken: <mocked>, expiresIn: 3600 }`
    - `signAsync` is called with exactly `{ sub: id, role }`
    - audit `LOGIN_SUCCEEDED` with actor and entity = the user id and `meta.email` masked
      (`s•••@example.com`)
  - denied, unknown email:
    - `UnauthorizedException` with message `Invalid credentials`
    - `bcrypt.compare` is called once, with the dummy hash
    - audit `LOGIN_FAILED` with `actorId: null`, `actorRole: null`, `entityId: null` and the
      email masked
    - `signAsync` is not called
  - denied, wrong password: the same exception and message; audit `LOGIN_FAILED` with
    `entityId = user.id`, `actorId: null`
  - neither audit entry contains the password, the raw email or a hash anywhere
    (`JSON.stringify` check)
- Unit, `src/auth/auth.controller.spec.ts`: delegates to `AuthService.login` with the DTO fields
  and returns its result.
- Integration, `test/auth.e2e-spec.ts` (real Postgres; the test-only controller is reachable only
  inside this spec):
  - login success (SALES):
    - 200 with body keys exactly `accessToken` and `expiresIn: 3600`
    - the token decodes (via `app.get(JwtService).verifyAsync`) to `sub` = the user id,
      `role: 'SALES'`, `exp - iat === 3600`
    - the header `alg` is `HS256`
    - one `LOGIN_SUCCEEDED` row with `actor_type USER`, `actor_id` and `entity_id` = the user id,
      `actor_role SALES`, `meta = { email: 's•••@example.com' }`
  - login with an uppercase email (`SALES@EXAMPLE.COM`) → 200 (normalised)
  - denied: wrong password → 401 `{ statusCode: 401, error: 'Unauthorized', message: 'Invalid
    credentials', code: 'UNAUTHORIZED' }`, plus one `LOGIN_FAILED` row with `actor_id` null,
    `entity_id` = the user id and the email masked
  - denied: unknown email (`nobody@example.com`) → the **same** 401 body, plus a `LOGIN_FAILED`
    row with `actor_id` and `entity_id` null and `meta.email = 'n•••@example.com'`
  - denied: extra field (`role: 'ADMIN'`) → 400; missing password → 400; malformed email → 400.
    No audit row for these.
  - no captured log line or audit row contains the password, the raw email or the issued token
  - `GET /auth-e2e-test/me`:
    - denied: no token → 401
    - denied: `Basic` scheme → 401
    - denied: tampered token (payload re-encoded with `role: 'ADMIN'`, original signature kept)
      → 401 on `/auth-e2e-test/me` and on `/auth-e2e-test/admin-only` (role escalation refused)
    - denied: token signed with a different runtime-generated secret → 401
    - denied: expired token, from `app.get(JwtService).signAsync({ sub, role }, { expiresIn: -60
      })` with no `exp` in the payload → 401
    - denied: `alg: none` token (unsigned, built by base64url-encoding the header and payload) →
      401
    - every 401 body has `message: 'Unauthorized'` and never echoes the token
  - `GET /auth-e2e-test/me` with a SALES token from `POST /auth/login` → 200
    `{ id, role: 'SALES' }`
  - `GET /auth-e2e-test/admin-only`:
    - denied: SALES token (from login) → 403 `{ statusCode: 403, error: 'Forbidden', message:
      'Forbidden', code: 'FORBIDDEN' }`
    - ADMIN token (from logging in as the ADMIN user via `POST /auth/login`) → 200
  - an unknown route without a token is still 404 (guards do not run unmatched)
  - Swagger: with `setupSwagger(app, true)`, `/docs-json` has `paths['/auth/login'].post` with
    the `LoginDto` request body, no `security`, and a 200 response
- Integration, existing specs: `test/logging.e2e-spec.ts` passes with the `@Public()` and
  `INVALID_ENV` changes. These pass unchanged, because test-env supplies `JWT_SECRET`:
  - `test/swagger.e2e-spec.ts`
  - `test/app.e2e-spec.ts`
  - `test/seed.e2e-spec.ts`
  - `test/audit-log.e2e-spec.ts`
  - `test/database.e2e-spec.ts`
  - `test/migrations.e2e-spec.ts`
  - `test/test-env.e2e-spec.ts` (gains new cases)

  `AuthService.onModuleInit` (the dummy hash) runs only on `app.init()` / `module.init()`.
  `test/app.e2e-spec.ts` only calls `compile()`, so the hook never runs there and the spec is
  unaffected.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1–9   | package.json, package-lock.json, src/config/env.validation.ts, src/config/env.validation.spec.ts, test/setup/test-env.ts, test/test-env.e2e-spec.ts, src/common/password.ts, src/database/seeds/seed.service.ts, src/users/users.repository.ts, src/users/users.repository.spec.ts | — |
| B  | 10–18 | src/auth/auth.constants.ts, src/auth/auth-user.ts, src/auth/auth-user.spec.ts, src/auth/decorators/public.decorator.ts, src/auth/decorators/roles.decorator.ts, src/auth/decorators/current-user.decorator.ts, src/auth/decorators/current-user.decorator.spec.ts, src/auth/guards/jwt-auth.guard.ts, src/auth/guards/jwt-auth.guard.spec.ts, src/auth/guards/roles.guard.ts, src/auth/guards/roles.guard.spec.ts, src/auth/dto/login.dto.ts, src/auth/dto/login.dto.spec.ts, src/auth/dto/login-response.dto.ts, src/auth/auth.service.ts, src/auth/auth.service.spec.ts, src/auth/auth.controller.ts, src/auth/auth.controller.spec.ts, src/auth/auth.module.ts | A |
| Z  | 19–23 | src/app.module.ts, test/logging.e2e-spec.ts, test/auth.e2e-spec.ts, docs/adrs/database.md, README.md | A, B |

`.env.example` belongs to no package (the user edits it by hand, see Risks).

## Security notes
- **No secrets in git:**
  - `JWT_SECRET` comes only from env, through `validateEnv` and `ConfigService`, and must be at
    least 32 characters.
  - Tests get it from env, or test-env generates a random one at runtime.
  - Seed passwords in the e2e test come from `SEED_*` env through `ConfigService`.
  - The dummy bcrypt hash is generated at startup from random bytes, never hardcoded.
  - Unit-test fixtures are obviously fake (`fixture-xxx…`, mocked `JwtService`).
  - The agent never reads `.env` or `.env.example`.
- **No authz bypass:**
  - Every route requires a valid HS256 token by default (global `APP_GUARD`). Opting out is
    explicit (`@Public()`) and used only on `POST /auth/login` (and the test-only throwing
    controller inside `test/logging.e2e-spec.ts`).
  - Wrong role → 403, no or invalid token → 401.
  - The algorithm is pinned on both sign and verify, so `alg: none` and algorithm confusion are
    refused. An e2e test proves it.
  - The claims are validated (`toAuthUser`) before use.
  - No application lookups are added, so the scoped-repository rule is untouched.
  - `findByEmailWithPasswordHash` is a login-only lookup by email, not an unscoped
    application/user find-by-id.
- **User enumeration:**
  - An unknown email and a wrong password give byte-identical 401 bodies.
  - bcrypt `compare` runs once in both paths, at the same cost.
  - Both paths write one audit row.
- **Mass assignment:** the global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`
  rejects unknown body fields (400), e.g. `role` on login.
- **Never log sensitive data:**
  - `AuthService` and the guards do not log.
  - The filter logs only the method, route pattern, status and code.
  - Audit `meta` holds only `maskEmail(email)` and still passes through `redact()` and the masks.
  - Guard errors never carry the `jsonwebtoken` message or the token.
  - The e2e test asserts that the password, raw email and token are absent from all captured
    output.
- **Fake data only:** `@example.com` users, generated UUIDs.

## Risks / open questions
Defaults taken in unattended mode:
- **`.env.example` lines for the user to add by hand** (the agent cannot edit that file):
  ```
  # Secret for signing HS256 access tokens. Required, at least 32 characters; the app refuses
  # to start with this placeholder. Generate one with: openssl rand -base64 48
  JWT_SECRET=change-me
  ```
  The token lifetime is fixed at 1h by the ADR, so there is no expiry variable. The ship loop
  should add this to "Waiting on you" in docs/backlog.md.
- **`JWT_SECRET` minimum length of 32** is not in the ADR. It is a sensible HS256 floor (256-bit
  key). It means the `change-me` placeholder fails fast instead of signing tokens.
- **`validateEnv` is shared** by the app, the seed, the TypeORM CLI data source and the e2e
  global setup. All of them now require `JWT_SECRET`, including `npm run migration:run` and
  `npm run seed`. That is accepted for simplicity (one validator, one `.env`). The alternative,
  a separate auth-only validator, adds a second validation path.
- **ADR wording for failed-login actor columns:** see ADR conflicts. It is a clarification
  matching existing code, not a design change, so it is not treated as NEEDS_HUMAN.
- **Login returns 200** (`@HttpCode(200)`), not Nest's POST default 201, because no resource is
  created. The ADR does not specify a status code.
- **400 validation failures** (malformed email, extra fields) do not write `LOGIN_FAILED`, because
  they never reach the login logic. The ADR's "every failed login" is read as "every rejected
  credential check".
- **The `forbidNonWhitelisted` 400 message names the unknown property key** sent by the client
  (e.g. `property role should not exist`). Keys are not sensitive values, and class-validator's
  default messages never include values.
- **Password `@MaxLength(128)`** limits bcrypt work on huge inputs. bcrypt only uses the first 72
  bytes anyway. The ADR does not state a limit.
- **The guard re-reads the user on each request** (Fix round; it was stateless before). One
  primary-key lookup per authenticated request, so a deleted user gets 401 and a role change
  applies at once. Tokens are otherwise still not revocable (ADR trade-off).
- **The dummy hash costs about 250 ms at each app start** (bcrypt cost 12, in `onModuleInit`).
  The e2e specs that build the app per test get a few seconds slower. That is accepted, so that
  unknown-email timing matches from the first request.
- **No login rate limiting or lockout.** It is not in the ADR, so it stays out of scope. The
  security review flagged it (LOW): every attempt costs a bcrypt compare at cost 12 and an
  append-only audit row, so a login flood burns CPU and grows `audit_logs`. Tracked as an
  unchecked item in docs/production-readiness.md.
- **`ValidationPipe` has `transform: true`,** so handlers receive real DTO instances. Implicit
  type conversion stays off.
- **Later protected controllers must add `@ApiBearerAuth(SWAGGER_BEARER_AUTH_NAME)`** themselves.
  This task adds no shared composite decorator, because no real protected controller exists yet.

## Revision notes
- **Round 1 (plan review CHANGES_REQUESTED):**
  - Blocker, expired-token case: the old plan put `exp` in the payload with no `expiresIn`. That
    cannot work, because `@nestjs/jwt` merges the module's `signOptions.expiresIn: 3600` into
    every `signAsync`, and `jsonwebtoken` then throws. Step 21 and Tests now give the exact call:
    `app.get(JwtService).signAsync({ sub, role }, { expiresIn: -60 })`, with no `exp` in the
    payload.
  - Tampered token: the payload is now re-encoded with `role: 'ADMIN'` and the original
    signature kept (it used to flip the last signature character). The case also checks
    `/auth-e2e-test/admin-only`, so it proves a role escalation is refused.
  - The SALES and ADMIN probe tokens now come from real `POST /auth/login` calls; `signAsync` is
    used only for the deliberately bad tokens.
  - Added `test/database.e2e-spec.ts`, `test/migrations.e2e-spec.ts` and
    `test/test-env.e2e-spec.ts` to the list of existing specs that still pass.
  - Added a note that `onModuleInit` (the dummy hash) runs only on `init()`, so the compile-only
    `test/app.e2e-spec.ts` is unaffected.
  - README Getting started (step 23) now tells the reader to replace the `JWT_SECRET=change-me`
    placeholder, e.g. with `openssl rand -base64 48`.
- **Fix round (security review):**
  - Deleted or changed users: new `UsersRepository.findAuthUserById(id)` (auth-only, selects only
    `id` and `role`, returns null for a non-UUID id). `JwtAuthGuard` calls it after
    `toAuthUser`; no row → 401, and `request.user` takes `id`/`role` from the row. New unit cases
    in the guard and repository specs; new e2e cases: user deleted after login → 401, ADMIN
    demoted to SALES after login → 403 on admin-only (and `/me` shows `SALES`). docs/adrs/auth.md
    §Auth details documents the per-request lookup.
  - `JWT_SECRET` strength: `validateEnv` also refuses values with fewer than 8 distinct
    characters (`JWT_SECRET_MIN_DISTINCT_CHARS`) or containing `change-me` (any case); the error
    still names only the variable. New unit cases; `JWT_SECRET_FIXTURE` has exactly 8 distinct
    characters and still passes. README updated.
  - `RolesGuard` now reads `ROLES_KEY` first and applies it even on `@Public()` routes (no user →
    401, wrong role → 403). New unit cases.
  - Login rate limiting: not implemented; added to docs/production-readiness.md and Risks.
