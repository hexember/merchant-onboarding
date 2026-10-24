# Swagger setup

## Goal
`@nestjs/swagger` is installed. When enabled, the app serves the Swagger UI at `/docs` and the
OpenAPI JSON document at `/docs-json`. The document has a title, description and version, plus one
HTTP bearer (JWT) security scheme named `bearer` that matches the JWT scheme in docs/adrs/auth.md.
Later endpoints then only need `@ApiTags()` / `@ApiBearerAuth()` decorators. All setup lives in
`src/common/swagger.ts` (`buildSwaggerConfig()`, `setupSwagger()`). `main.ts` and the e2e tests
call the same function. A new env flag `SWAGGER_ENABLED` is validated in `validateEnv`. It
defaults to `true`, except when `NODE_ENV=production`, where it defaults to `false`. An e2e test
proves the JSON document carries the bearer scheme when the flag is on, and that `/docs` and
`/docs-json` return 404 when it is off. The README says where the docs live.

## Scope
- In:
  - Dependencies: `@nestjs/swagger` (runtime). Dev: `supertest` and `@types/supertest`, which no
    e2e test has needed yet; this is the first HTTP-level e2e test. The README tech stack already
    lists Jest + Supertest.
  - `SWAGGER_ENABLED` in `AppEnv` / `validateEnv`, with unit tests.
  - `src/common/swagger.ts` with a unit test, called from `src/main.ts`.
  - `test/swagger.e2e-spec.ts`.
  - README: Overview and Getting started mention `/docs` and `/docs-json`.
  - The exact `.env.example` lines for the user to add **by hand** (see Risks). No package owns that file.
- Out:
  - Any controller or endpoint, auth/JWT/guards, DTOs, class-validator, a global `ValidationPipe`,
    the exception filter, and `@nestjs/swagger` CLI plugin settings in `nest-cli.json`.
  - A global route prefix or API versioning.
  - ADR edits (see ADR conflicts).

## ADR references
- docs/adrs/auth.md §Auth details: "JWTs are HS256 ... carry the claims `{ sub, role }`", returned
  as `accessToken` from `POST /auth/login`. The document declares
  `addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: ... }, 'bearer')`.
  Later protected endpoints use `@ApiBearerAuth(SWAGGER_BEARER_AUTH_NAME)`. `POST /auth/login` is
  `public` in the matrix, so security is **not** applied globally (no `addSecurityRequirements`).
  Each controller opts in.
- docs/adrs/auth.md §Authorization: not touched. The Swagger UI adds no route that reaches
  application data, so no scoped repository or denied case applies.
- docs/adrs/sensitive-data.md: the document describes shapes only and contains no data. No
  secret, token or example value is placed in it.
- docs/adrs/testing.md: no authz rule is added or changed, so none of the listed bypass cases is in
  scope. The tests here are deterministic (no sleeps, no randomness).
- README (Overview/Tech stack): "Swagger serves as the UI" and "Swagger/OpenAPI". This plan
  delivers that.

## ADR conflicts
None. No ADR covers API documentation or the decision to serve docs in production. The decision
(an env flag, off by default in production) is about runtime config, not domain design. It is
recorded in this plan, in the README and in the `validateEnv` comment. Adding an ADR would break
`.claude/rules/general.md` ("No ... ADR unless asked"). If the reviewer thinks it belongs in an
ADR, that needs a human decision (see Risks).

## Steps
1. `src/config/env.validation.ts`: add `SWAGGER_ENABLED: boolean` to `AppEnv`. Add
   `readBoolean(raw, name, defaultValue, invalid): boolean`:
   - `undefined` or `''` returns the default.
   - A real `boolean` is returned as-is.
   - A string is trimmed and lowercased: `'true'` returns `true`, `'false'` returns `false`.
   - Anything else pushes `name` onto `invalid` and returns the default. The error names the
     variable, never the value, which matches the existing messages.
   - Note that `'1'`, `'0'`, `'yes'` and `'no'` are rejected on purpose, so the value has one
     clear spelling.

   In `validateEnv`, compute `SWAGGER_ENABLED: readBoolean(raw, 'SWAGGER_ENABLED', nodeEnv !== 'production', invalid)`.
   Add a short comment saying that `/docs` stays off in production unless someone sets
   `SWAGGER_ENABLED=true` on purpose.
2. `src/config/env.validation.spec.ts`: add the unit cases listed under Tests. `validRaw()` stays
   unchanged, so the existing cases still exercise the default.
3. `package.json` + `package-lock.json`: run `npm install @nestjs/swagger@^11` and
   `npm install -D supertest@^7 @types/supertest@^6`. `@nestjs/swagger` 11.x is the line that
   pairs with Nest 11. Don't change any scripts.
4. `src/common/swagger.ts`: a new file containing:
   - `export const SWAGGER_PATH = 'docs';` and `export const SWAGGER_BEARER_AUTH_NAME = 'bearer';`
   - `export const API_VERSION = '0.1.0';`, with a comment saying to keep it in step with
     `package.json` `version`. Importing `package.json` would need `resolveJsonModule` and would
     change the `dist/` layout, so it is not imported.
   - `export function buildSwaggerConfig(): Omit<OpenAPIObject, 'paths'>`. It uses
     `new DocumentBuilder().setTitle('Merchant onboarding API').setDescription('Merchant onboarding and risk review API. Use POST /auth/login to get a JWT, then Authorize with it.').setVersion(API_VERSION).addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT access token from POST /auth/login' }, SWAGGER_BEARER_AUTH_NAME).build()`.
     The description must stay neutral (`.claude/rules/general.md`).
   - `export function setupSwagger(app: INestApplication, enabled: boolean): boolean`. When
     `enabled` is false it returns `false` and registers nothing. Otherwise it runs
     `SwaggerModule.createDocument(app, buildSwaggerConfig())` and then
     `SwaggerModule.setup(SWAGGER_PATH, app, document, { jsonDocumentUrl: SWAGGER_JSON_PATH, yamlDocumentUrl: SWAGGER_YAML_PATH })`
     (`'docs-json'` / `'docs-yaml'`, both exported constants), and returns `true`. It sets both
     document URLs explicitly so the paths don't depend on library defaults. It does not set `persistAuthorization`, so a pasted JWT is not stored in the
     browser's localStorage.
   - The function takes `enabled` as a parameter instead of reading `ConfigService` itself. That
     keeps it pure with respect to config: tests can pass both values without touching
     `process.env` (`.claude/rules/typescript.md`).
5. `src/common/swagger.spec.ts`: unit tests for `buildSwaggerConfig()` and the disabled branch of
   `setupSwagger()` (see Tests).
6. `src/main.ts`: after `enableShutdownHooks()`, read
   `const config = app.get(ConfigService);` and call
   `setupSwagger(app, config.getOrThrow<boolean>('SWAGGER_ENABLED'))` before `app.listen(port)`.
   Reuse the same `config` for `PORT`. Log nothing new.
7. `test/swagger.e2e-spec.ts`: an HTTP-level e2e test using `AppModule`, `createNestApplication()`,
   `setupSwagger(app, <flag>)`, `app.init()` and `request(app.getHttpServer())`. Import Supertest
   as `import * as request from 'supertest'`; this is the convention for all e2e tests. Close the app in
   `afterEach`/`finally`. Using `AppModule` means it uses the existing Postgres test-DB harness
   unchanged.
8. `README.md`:
   - Overview: change the line to "The project is backend only; Swagger UI at `/docs` serves as
     the UI (OpenAPI JSON at `/docs-json`)."
   - Getting started: change the `start:dev` comment to `# API on :3000, Swagger UI at /docs`.
     Add one sentence: `/docs` is on by default and off when `NODE_ENV=production`, and
     `SWAGGER_ENABLED=true|false` overrides that.
9. `src/database/database.options.ts` + `src/database/database.module.ts`: adding the required
   `SWAGGER_ENABLED` to `AppEnv` breaks `database.module.ts`, which builds a full `AppEnv`
   literal field by field.
   - In `database.options.ts`, export
     `type DatabaseEnv = Pick<AppEnv, 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'>`
     and change the signature to `createDataSourceOptions(env: DatabaseEnv): DataSourceOptions`.
     These are exactly the keys the function reads; it does not read `NODE_ENV` or `PORT`. The
     body doesn't change.
   - In `database.module.ts`, the factory passes only those five keys (it drops the `NODE_ENV` and
     `PORT` reads).
   - The other callers need no change. `src/database/data-source.ts`, `test/utils/test-db.ts`
     (`createDataSourceOptions(validateEnv(process.env))`) and `test/setup/global-setup.ts`
     (`createDataSourceOptions(env)`, where `env = validateEnv(...)`) all pass the full
     `validateEnv` result, which is assignable to the `Pick`. They are not assigned to any package.
     Z runs `npm run typecheck` to confirm.

## Tests
- Unit (`src/config/env.validation.spec.ts`):
  - `SWAGGER_ENABLED` defaults to `true` when unset and `NODE_ENV=test`.
  - Defaults to `true` when `NODE_ENV` is unset (default `development`).
  - Defaults to `false` when `NODE_ENV=production`.
  - `'true'` gives `true` and `'false'` gives `false`. `' TRUE '` gives `true` (trim/case).
  - An explicit `'true'` with `NODE_ENV=production` gives `true` (an override is allowed).
  - An explicit `'false'` in development gives `false`.
  - An empty string falls back to the default.
  - Invalid (denied): `it.each(['yes', '1', '0', 'enabled'])` throws an error naming
    `SWAGGER_ENABLED`.
  - Invalid (denied): the error message does not contain the raw value (e.g.
    `'not-a-bool-value'`).
- Unit (`src/common/swagger.spec.ts`):
  - `buildSwaggerConfig()` has `info.title === 'Merchant onboarding API'` and
    `info.version === API_VERSION`.
  - `buildSwaggerConfig().components.securitySchemes[SWAGGER_BEARER_AUTH_NAME]` equals
    `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: ... }`. Use
    `toMatchObject` on `type`/`scheme`/`bearerFormat`, and narrow with a check rather than `!`.
  - `buildSwaggerConfig()` has no top-level `security` requirement (login must stay public).
  - `setupSwagger(fakeApp, false)` returns `false`, and `SwaggerModule.setup` is not called
    (`jest.spyOn(SwaggerModule, 'setup')`). `fakeApp` is a typed stub (`{} as INestApplication`
    is acceptable only through an `unknown` cast, never `any`).
- Integration (`test/swagger.e2e-spec.ts`, Supertest, real Postgres test DB):
  - Enabled: `GET /docs-json` returns 200 with JSON. `body.openapi` starts with `'3.'`,
    `body.info.title === 'Merchant onboarding API'`, and
    `body.components.securitySchemes.bearer` matches
    `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`.
  - Enabled: `GET /docs` returns 200 (follow a redirect to `/docs/` if the library issues one)
    with `content-type` matching `/html/`.
  - Disabled (denied): `GET /docs` returns 404.
  - Disabled (denied): `GET /docs-json` returns 404.
  - Disabled (denied): `GET /docs-yaml` returns 404.
  - Regression: the existing e2e specs (`app.e2e-spec.ts`, `database.e2e-spec.ts`,
    `migrations.e2e-spec.ts`, etc.) still pass after the `DatabaseEnv` change in step 9. This
    needs no new case.
  - No authz rule is touched, so docs/adrs/testing.md requires no extra denied cases.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2  | src/config/env.validation.ts, src/config/env.validation.spec.ts | — |
| B  | 3, 4, 5 | package.json, package-lock.json, src/common/swagger.ts, src/common/swagger.spec.ts | — |
| Z  | 6, 7, 8, 9 | src/main.ts, test/swagger.e2e-spec.ts, README.md, src/database/database.options.ts, src/database/database.module.ts | A, B |

`package.json` sits in B, not Z, because `swagger.ts` and its unit test cannot compile without
`@nestjs/swagger` installed. No other package touches `package.json`, so B can own it safely.
`.env.example` belongs to no package (see Risks).

## Security notes
- **Docs in production:** off by default when `NODE_ENV=production`, so the route map isn't
  published by accident. Turning it on needs an explicit `SWAGGER_ENABLED=true`. An invalid value
  fails startup instead of silently enabling the docs.
- **No secrets:** the document holds no tokens, example JWTs or passwords. `persistAuthorization`
  stays off, so a pasted token isn't kept in localStorage. Nothing new is logged
  (`.claude/rules/security.md` "Never log sensitive data").
- **Env handling:** the flag is read only through `validateEnv`/`ConfigService`. Error messages
  name the variable, never the value. `.env` is not read.
- **No authz bypass:** `/docs` and `/docs-json` serve static metadata and do not touch any
  repository, so the scoped-lookup rule doesn't apply. Because security is not applied globally,
  the later auth task must add `@ApiBearerAuth(SWAGGER_BEARER_AUTH_NAME)` per controller. The
  real enforcement stays the guards, never the Swagger decorators.
- **Fake data only:** no examples are added in this task.

## Risks / open questions
- **`.env.example` (manual step for the user):** the agent cannot edit it. Add these lines by hand
  (left commented so the environment-dependent default applies):
  ```
  # Serve Swagger UI at /docs and the OpenAPI JSON at /docs-json (true|false).
  # Defaults to true, or false when NODE_ENV=production.
  # SWAGGER_ENABLED=
  ```
- **ADR or not:** this plan records the production decision in the README and code comments, not
  an ADR, because no ADR covers deployment/config and the general rule forbids a new ADR unless
  asked. If the user wants it in an ADR, that needs a human decision.
- **Exact `/docs` response:** depending on the `@nestjs/swagger` 11 minor version, `GET /docs` may
  return 200 HTML directly or redirect to `/docs/`. The e2e test should accept either (follow the
  redirect, or assert 200 on `/docs/`). The implementer must not hard-code a 301.
- **`API_VERSION` drift:** it duplicates `package.json` `version` (`0.1.0`). This is accepted to
  avoid `resolveJsonModule`. Flag it if the reviewer prefers another source.

## Revision notes
- **Revision 1 (after approval; A and B already implemented):**
  - Added step 9 and gave `src/database/database.options.ts` and
    `src/database/database.module.ts` to package Z. The cause: making `SWAGGER_ENABLED: boolean`
    required in `AppEnv` broke typecheck in `database.module.ts`, which builds a full `AppEnv`
    literal. The user chose the fix: `createDataSourceOptions` now takes
    `DatabaseEnv = Pick<AppEnv, 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'>`,
    which are the only keys it reads.
  - Checked the other callers (`src/database/data-source.ts`, `test/utils/test-db.ts`,
    `test/setup/global-setup.ts`). They pass the full `validateEnv` result and still compile, so
    no package owns them.
  - Recorded the plan-review suggestions already applied in B. `/docs-yaml` is set explicitly via
    `SWAGGER_YAML_PATH`, and step 4 now names `SWAGGER_JSON_PATH`/`SWAGGER_YAML_PATH`.
  - Added a disabled-case 404 assertion for `/docs-yaml` to Z's e2e tests, and set the Supertest
    import to `import * as request from 'supertest'`.
