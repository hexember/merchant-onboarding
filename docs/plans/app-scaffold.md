# Application scaffold (tooling and empty bootstrap only)

## Goal
The repo becomes a working NestJS + TypeScript (strict) project skeleton with no feature code.
`npm install`, `npm run lint`, `npm run build`, `npm run test` and `npm run test:e2e` all pass.
`docker compose up -d` starts healthy Postgres and Redis containers configured only from `.env`.
`npm run start:dev` boots an empty Nest app on `PORT` (default 3000). The scripts the README and
the `verify` skill expect all exist. A `.claude/rules/typescript.md` rule records the TypeScript
conventions, and the README reflects the scaffold. Later tasks (database, auth, applications,
KYB queue) build on this skeleton.

## Scope
- In:
  - `package.json` (+ generated `package-lock.json`) with the scripts `build`, `start`,
    `start:dev`, `start:prod`, `lint`, `lint:fix`, `format`, `test`, `test:watch`, `test:cov`,
    `test:e2e`, `migration:run`, `seed`.
  - `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`), `tsconfig.build.json`, `nest-cli.json`.
  - ESLint flat config (`no-explicit-any` as error) and Prettier config.
  - Jest config for unit tests (in `package.json`) and e2e tests (`test/jest-e2e.json`).
  - `docker-compose.yml` with `postgres` and `redis` services and healthchecks.
  - `.env.example` with placeholders only.
  - The smallest possible bootstrap: `src/main.ts`, `src/app.module.ts` (only `ConfigModule`)
    and one smoke unit test `src/app.module.spec.ts`.
  - `.claude/rules/typescript.md`; README tech-stack "(strict)" and "Getting started" update.
- Out:
  - Entities, migrations, TypeORM wiring, repositories, controllers, DTOs, guards, auth/JWT,
    Swagger, global `ValidationPipe`/exception filter, `redact()` helpers, BullMQ queues and
    workers, seeds. Each comes with its feature task.
  - Runtime dependencies for those features (`@nestjs/typeorm`, `typeorm`, `pg`, `bullmq`,
    `@nestjs/bullmq`, `@nestjs/jwt`, `passport-jwt`, `bcrypt`, `class-validator`,
    `class-transformer`, `@nestjs/swagger`, `supertest`). Per `.claude/rules/general.md`
    ("No new dependency without a reason") each is added by the task that first uses it.
  - Empty feature folders or `.gitkeep` files.
  - `.gitignore`: no change needed. It already ignores `node_modules/`, `dist/`, `coverage/`,
    `*.tsbuildinfo`, `.env`/`.env.*` (keeping `!.env.example`), `dev.notes/` and logs.
  - CI configuration, Dockerfile for the API, and a health endpoint (that would be a controller).

## ADR references
- docs/adrs/testing.md (intro and last bullet): Jest is set up with separate unit (`src/**/*.spec.ts`)
  and integration (`test/**/*.e2e-spec.ts`) configs, so the later Supertest suites against
  real Postgres + Redis have a home. No randomness is introduced.
- docs/adrs/database.md (intro): Postgres runs in Docker Compose; the scaffold creates no schema.
  `synchronize` is not set anywhere because TypeORM is not wired yet (`.claude/rules/database.md`
  applies when it is).
- docs/adrs/kyb-check.md: Redis runs in Docker Compose for the later BullMQ queue. No queue code.
- docs/adrs/auth.md: the JWT secret "from env" is not added yet. The auth task adds `JWT_SECRET`
  to `.env.example` as a placeholder.
- docs/adrs/sensitive-data.md: no logging is added beyond Nest's default startup logger, which
  logs no request data.
- docs/adrs/workflow.md: not touched.

## ADR conflicts
None.

## Steps
1. `tsconfig.json`: Nest-style compiler options: `module: "commonjs"`, `target: "ES2022"`,
   `declaration: true`, `removeComments: true`, `emitDecoratorMetadata: true`,
   `experimentalDecorators: true`, `allowSyntheticDefaultImports: true`, `sourceMap: true`,
   `outDir: "./dist"`, `baseUrl: "./"`, `incremental: true`, `skipLibCheck: true`,
   `forceConsistentCasingInFileNames: true`, plus **`strict: true`**,
   **`noUncheckedIndexedAccess: true`**, `noImplicitOverride: true`,
   `noFallthroughCasesInSwitch: true`. No `include`, so it covers `src/` and `test/` for type
   checking and ESLint's typed linting.
2. `tsconfig.build.json`: `extends: "./tsconfig.json"`, `exclude: ["node_modules", "test", "dist",
   "**/*spec.ts"]`, so tests are never compiled into `dist/`.
3. `nest-cli.json`: `$schema`, `collection: "@nestjs/schematics"`, `sourceRoot: "src"`,
   `compilerOptions: { deleteOutDir: true }`. `@nestjs/schematics` is a transitive dependency of
   `@nestjs/cli` and does not need its own entry.
4. `eslint.config.mjs`: ESLint 9 flat config using `@eslint/js` recommended,
   `typescript-eslint` `recommendedTypeChecked` (with `parserOptions.projectService: true` and
   `tsconfigRootDir: import.meta.dirname`) scoped to `files: ["**/*.ts"]`, then
   `eslint-config-prettier` last. Global `ignores`: `dist/`, `coverage/`, `node_modules/`,
   `eslint.config.mjs`. Rules set to `"error"`:
   - `@typescript-eslint/no-explicit-any`
   - `@typescript-eslint/ban-ts-comment` (blocks `@ts-ignore`/`@ts-nocheck`)
   - `@typescript-eslint/explicit-module-boundary-types` (explicit return types on exported
     functions)
   - `@typescript-eslint/no-floating-promises` (already in `recommendedTypeChecked`; keep it)
5. `.prettierrc`: `{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }`.
   Prettier runs through the `format` script only, not inside ESLint, to keep lint output
   readable.
6. `docker-compose.yml` defines two services, with no hardcoded credentials:
   - `postgres`: image `postgres:16-alpine`; `environment` `POSTGRES_USER: ${DB_USER:?set DB_USER in .env}`,
     `POSTGRES_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in .env}`, `POSTGRES_DB: ${DB_NAME:?set DB_NAME in .env}`;
     `ports: ["127.0.0.1:${DB_PORT:-5432}:5432"]`; named volume `postgres_data:/var/lib/postgresql/data`;
     `healthcheck` `test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]`,
     `interval: 5s`, `timeout: 5s`, `retries: 10`.
   - `redis`: image `redis:7-alpine`; `ports: ["127.0.0.1:${REDIS_PORT:-6379}:6379"]`;
     `healthcheck` `test: ["CMD", "redis-cli", "ping"]`, same timings. No volume (queue data
     is disposable in local dev).
   - Top-level `volumes: { postgres_data: {} }`. No `version:` key (obsolete in Compose v2).
   Compose reads `.env` from the project directory automatically, and `:?` fails loudly if a
   value is missing.
7. `.env.example`: placeholders only, each with a one-line comment:
   `NODE_ENV=development`, `PORT=3000`, `DB_HOST=localhost`, `DB_PORT=5432`,
   `DB_USER=merchant_onboarding`, `DB_PASSWORD=change-me`, `DB_NAME=merchant_onboarding`,
   `REDIS_HOST=localhost`, `REDIS_PORT=6379`. No other variables: JWT, KYB and seed settings
   come with their tasks.
8. `.claude/rules/typescript.md`: new path-scoped rule in the same style as the existing rules:
   ```
   ---
   paths:
     - "src/**/*.ts"
     - "test/**/*.ts"
   ---
   ```
   Heading `# TypeScript rules`, with bullets:
   - Strict mode is on (`strict`, `noUncheckedIndexedAccess`). No `any` (use `unknown` and
     narrow), no `@ts-ignore`/`@ts-nocheck`, no non-null `!` to silence errors (definite
     assignment `!:` on DTO/entity properties is fine).
   - Exported functions and public methods declare explicit return types.
   - One Nest module per feature (`src/<feature>/<feature>.module.ts`). Shared code goes in `src/common/`.
   - Dependencies come in through constructor injection only; never `new` a provider.
   - Request bodies and queries are class-validator DTO classes, never inline types or `any`.
   - Configuration is read only through `@nestjs/config` (`ConfigService`); never read
     `process.env` outside the config setup.
9. `README.md`:
   - Tech stack line: `TypeScript (strict) · Node.js · NestJS · ...` (rest unchanged).
   - "Getting started": replace the "To be completed once the project is scaffolded." note with
     a "Requires Node.js 20+ and Docker." line and a short note that `migration:run` and `seed`
     are placeholders until the database and auth tasks land. In the code block, change the
     `start:dev` comment to `# API on :3000` (Swagger at `/docs` comes with the API task; the
     README is updated again then). Keep the rest of the block as is.
   - "Testing": keep as is.
10. `package.json` (+ `package-lock.json` from `npm install`):
    - `"name": "merchant-onboarding"`, `"private": true`, `"version": "0.1.0"`,
      `"engines": { "node": ">=20" }`. No `author` field (neutral wording rule).
    - `dependencies` (each has a reason): `@nestjs/common`, `@nestjs/core`,
      `@nestjs/platform-express` (bootstrap), `@nestjs/config` (config only via ConfigService),
      `reflect-metadata`, `rxjs` (Nest peer deps).
    - `devDependencies`: `@nestjs/cli` (build/start), `@nestjs/testing` (smoke test),
      `typescript`, `@types/node`, `jest`, `ts-jest`, `@types/jest`, `eslint`, `@eslint/js`,
      `typescript-eslint`, `eslint-config-prettier`, `prettier`.
    - Use the current stable major of each (NestJS 11, TypeScript 5.x, ESLint 9, Jest 29 with a
      matching `ts-jest`). Versions are locked by the committed `package-lock.json`.
    - `scripts`:
      - `"build": "nest build"`
      - `"start": "nest start"`, `"start:dev": "nest start --watch"`, `"start:prod": "node dist/main"`
      - `"lint": "eslint ."` (no `--fix`, so `/verify` reports problems instead of hiding them);
        `"lint:fix": "eslint . --fix"`
      - `"format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\""`
      - `"test": "jest"`, `"test:watch": "jest --watch"`, `"test:cov": "jest --coverage"`
      - `"test:e2e": "jest --config ./test/jest-e2e.json --passWithNoTests"`
      - `"migration:run": "node -e \"console.log('migration:run: no migrations yet (added with the database task)')\""`
      - `"seed": "node -e \"console.log('seed: no seed yet (added with the auth task)')\""`
    - `jest` block (unit): `moduleFileExtensions: ["js","json","ts"]`, `rootDir: "src"`,
      `testRegex: ".*\\.spec\\.ts$"`, `transform: { "^.+\\.(t|j)s$": "ts-jest" }`,
      `collectCoverageFrom: ["**/*.(t|j)s"]`, `coverageDirectory: "../coverage"`,
      `testEnvironment: "node"`.
11. `src/app.module.ts`, `src/main.ts`:
    - `AppModule` (`@Module`) imports only `ConfigModule.forRoot({ isGlobal: true })`. No
      controllers or providers.
    - `main.ts`: `async function bootstrap(): Promise<void>` creates the app with
      `NestFactory.create(AppModule)`, calls `app.enableShutdownHooks()`, reads the port with
      `app.get(ConfigService).get<number>('PORT', 3000)` and calls `app.listen(port)`. The file
      ends with `void bootstrap();` to satisfy `no-floating-promises`. No `process.env` access.
12. `src/app.module.spec.ts`: smoke unit test (see Tests).
13. `test/jest-e2e.json`: `moduleFileExtensions: ["js","json","ts"]`, `rootDir: "."`,
    `testEnvironment: "node"`, `testRegex: ".e2e-spec.ts$"`,
    `transform: { "^.+\\.(t|j)s$": "ts-jest" }`. There are no e2e specs yet, so the script
    passes `--passWithNoTests`.

## Tests
- Unit: `src/app.module.spec.ts`, `describe('AppModule')`:
  - `it('compiles the root module')`: `await Test.createTestingModule({ imports: [AppModule] }).compile()`,
    expect the module to be defined, then `await module.close()`.
  - No denied/invalid cases: the scaffold adds no authz rule, transition or validation.
- Integration: none yet. `test/jest-e2e.json` is ready for `*.e2e-spec.ts` files. The denied
  cases in docs/adrs/testing.md belong to the auth and applications tasks, because this task
  touches no authz rule. `npm run test:e2e` passes only because of `--passWithNoTests`, and the
  implementer must report it as "no e2e tests yet", not as a real pass.
- Gate (run by package Z): `npm install`, `npm run lint`, `npm run build`, `npm run test`,
  `npm run test:e2e`, and `docker compose config` with a temporary env (see Risks) to check that
  the compose file parses.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2, 3, 4, 5 | tsconfig.json, tsconfig.build.json, nest-cli.json, eslint.config.mjs, .prettierrc | — |
| B  | 6, 7  | docker-compose.yml, .env.example | — |
| C  | 8, 9  | .claude/rules/typescript.md, README.md | — |
| Z  | 10, 11, 12, 13 | package.json, package-lock.json, src/main.ts, src/app.module.ts, src/app.module.spec.ts, test/jest-e2e.json | A, B, C |

A, B and C don't import each other's files and can run in parallel. Z owns the shared wiring
(`package.json`, bootstrap). It runs `npm install` and the full gate against A's configs.
If a gate failure comes from an A config (e.g. an ESLint option), Z reports it rather than
editing A's file.

## Security notes
- **No secrets in git** (`.claude/rules/security.md`): `.env.example` holds placeholders only
  (`change-me`). `docker-compose.yml` hardcodes no credentials: it interpolates `${DB_USER}`,
  `${DB_PASSWORD}`, `${DB_NAME}` from the git-ignored `.env`, and `:?` refuses to start if they
  are missing. Implementers must never read or print `.env`. To validate the compose file, use a
  throwaway env, e.g. `DB_USER=x DB_PASSWORD=x DB_NAME=x docker compose config --quiet`.
- Postgres and Redis ports bind to `127.0.0.1` only, so they are not exposed on the network.
- No logging of request data is added. Nest's startup logger prints only module/route
  bootstrap lines.
- **Neutral wording** (`.claude/rules/general.md`): no company names or author fields in
  `package.json`, README or rule files. `dev.notes/` stays ignored and is not referenced.
- No authz surface is added (no controllers), so the scoping rules don't apply yet.

## Risks / open questions
- **Node version:** the plan sets `engines.node >=20` (NestJS 11 needs Node 20+). If a specific
  version (e.g. 22 LTS with `.nvmrc`) is wanted, say so.
- **Placeholder scripts:** `migration:run` and `seed` only print a message until the database and
  auth tasks replace them. The README says so, which means its "Getting started" is runnable but
  not yet functional for those steps.
- **`test:e2e` passes trivially** (`--passWithNoTests`) until the first e2e spec lands, and
  `/verify` step 5 will look green. The first integration task should remove the flag.
- **Separate test database** for e2e (so `test:e2e` doesn't touch dev data) is not decided by any
  ADR. It is left to the first integration-test task.
- **`strictPropertyInitialization`** (part of `strict`) means DTO/entity properties will need
  definite-assignment `!:`. The typescript rule allows this explicitly.
- **Deferred dependencies:** TypeORM, BullMQ, JWT, class-validator and Swagger packages are
  deliberately not installed now (see Scope: Out). If the user prefers the full stack installed
  in the scaffold, step 10 changes.
