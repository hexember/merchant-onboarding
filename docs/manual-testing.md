# Manual testing

How to try the API by hand against a local instance. Automated tests are described in the
[README](../README.md#testing).

## 1. Set up and start the API

You need Node.js 20+, Docker (with Docker Compose) and Git. Run every command from the
project root.

### 1.1 Install dependencies

```bash
npm install
```

### 1.2 Create `.env`

```bash
cp .env.example .env
```

Open `.env` and set these values. Everything stays on your machine; `.env` is git-ignored.

| Variable | What to put |
|----------|-------------|
| `DB_HOST`, `DB_PORT` | `localhost` and `5432` (the Postgres container) |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Any values you choose. Docker creates the database with them on first start. |
| `DB_NAME_TEST` | Only for `npm run test:e2e`: a different name that ends in `_test` |
| `REDIS_HOST`, `REDIS_PORT` | `localhost` and `6379` (the Redis container) |
| `JWT_SECRET` | A random value of at least 32 characters, not containing `change-me`. Generate one with `openssl rand -base64 48`. |
| `SEED_ADMIN_PASSWORD`, `SEED_REVIEWER_PASSWORD`, `SEED_SALES_PASSWORD` | Passwords you choose for the three test users. You log in with them later. |

Optional: `PORT` (default `3000`), `KYB_FAILURE_RATE` (default `0.2`: how often the simulated
KYB provider fails on purpose; set `0` for no retries), `SWAGGER_ENABLED`.

The API checks `.env` at startup and stops with a message naming any missing or invalid
variable.

### 1.3 Start Postgres and Redis

```bash
docker compose up -d
```

Wait until both containers show `healthy`:

```bash
docker compose ps
```

If you change `DB_USER`, `DB_PASSWORD` or `DB_NAME` after the first start, the existing
database volume keeps the old values. Recreate it with `docker compose down -v` (this deletes
all local data), then start again.

### 1.4 Create the tables

```bash
npm run migration:run
```

This builds the project and applies every migration in `src/database/migrations/`. Run it
again whenever new migrations arrive (for example after `git pull`).

### 1.5 Create the test users

```bash
npm run seed
```

The seed creates one user per role, with the passwords from `.env`. It is safe to run again:
existing users are skipped and keep their password. To change a password later, delete the
user from the `users` table and seed again.

### 1.6 Start the API

```bash
npm run start:dev
```

The API runs on `http://localhost:3000` (Swagger UI at `/docs`) and restarts when files
change. The KYB worker runs in the same process, so nothing else needs starting. Keep this
terminal open; the API logs one JSON line per request there.

Check that it is up:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/docs
```

`200` means it is running.

### 1.7 Test users

The users from step 1.5:

| Role     | Email                  | Password from            | Can do |
|----------|------------------------|--------------------------|--------|
| SALES    | `sales@example.com`    | `SEED_SALES_PASSWORD`    | create, edit and submit their own applications |
| ADMIN    | `admin@example.com`    | `SEED_ADMIN_PASSWORD`    | everything SALES can on any application, plus assign a reviewer and transfer the owner |
| REVIEWER | `reviewer@example.com` | `SEED_REVIEWER_PASSWORD` | view and decide (approve, reject, request info) applications assigned to them |

The full rules are in [docs/adrs/auth.md](adrs/auth.md) and the status flow in
[docs/adrs/workflow.md](adrs/workflow.md).

## 2. Postman collection (recommended)

The collection in [docs/postman/](postman/) logs in all three roles for you and keeps a token
per role, so there is no logging out and in to switch users.

1. In Postman, import `docs/postman/merchant-onboarding.postman_collection.json` and
   `docs/postman/local.postman_environment.example.json`.
2. Select the **merchant-onboarding local** environment and fill in `salesPassword`,
   `adminPassword` and `reviewerPassword` with your `SEED_*_PASSWORD` values. Keep them in
   Postman: don't commit them. A filled-in environment exported as
   `*.postman_environment.json` is git-ignored.
3. Run the whole collection with the **Collection Runner**, in order. Every request has tests,
   so the result is a list of passes and failures.

What it does:

- **Login.** Before every request, a collection script logs in any role whose token is missing
  or about to expire (tokens last 1 hour). It saves `salesToken`, `adminToken`,
  `reviewerToken`, and each user's id from the token's `sub` claim (`salesId`, `adminId`,
  `reviewerId`). The **1. Auth** folder does the same by hand and shows the response.
- **2. Happy path.** One application goes through the whole flow: create, edit, submit, assign,
  wait for the KYB check, request info, edit, resubmit, wait again, approve.
- **3. Denied cases.** Requests the API must refuse, each with its expected status: 401 (no or
  tampered token), 403 (wrong role), 404 (not visible to you), 400 (bad body), 409 (wrong status).

Single requests also work on their own (pick one and press **Send**). The "Wait for KYB
check" requests repeat themselves only in the Collection Runner; sent by hand, send them again
until `status` is `UNDER_REVIEW`.

From a terminal, the same collection runs with newman (downloaded on the fly, not a project
dependency). Pass the passwords as variables instead of writing them to a file. Load `.env`
into the shell first, then run newman:

```bash
set -a; source .env; set +a
```

```bash
npx newman run docs/postman/merchant-onboarding.postman_collection.json \
  -e docs/postman/local.postman_environment.example.json \
  --env-var "salesPassword=$SEED_SALES_PASSWORD" \
  --env-var "adminPassword=$SEED_ADMIN_PASSWORD" \
  --env-var "reviewerPassword=$SEED_REVIEWER_PASSWORD"
```

## 3. Swagger UI

Swagger UI at `http://localhost:3000/docs` shows every endpoint and its request schema. To use
it, call `POST /auth/login` with `{ "email": "...", "password": "..." }`, copy `accessToken`,
click **Authorize** and paste it. Switching role means logging in again and re-authorizing.

## Things that surprise people

- **SALES never sends `salesOwnerId`.** The owner is the logged-in SALES user, taken from the
  token. Swagger fills that field with a sample UUID; delete it, or the request gets 403. Only
  ADMIN sends it (required, must be a SALES user's id).
- **Submit works once.** Submit is allowed only from `DRAFT` or `INFO_REQUESTED`. A second
  submit returns `409 INVALID_STATE_TRANSITION`. Check the status with
  `GET /applications/{id}` first.
- **The KYB check is asynchronous.** After submit the status is `RISK_REVIEW`. A background
  worker calls a simulated provider (which fails on purpose about 20% of the time and is
  retried up to 5 times), then moves the application to `UNDER_REVIEW`. This normally takes a
  few seconds, up to about 30 when retries happen. `GET /applications/{id}` shows the result in
  `kybCheck`.
- **Approve needs a completed KYB check.** If every attempt failed, `kybCheck.status` is
  `FAILED` and approve returns `409 KYB_NOT_COMPLETED`. The reviewer can still reject or
  request info; resubmitting starts a new check.
- **A reviewer sees only applications assigned to them.** Anything else is `404`, the same as an
  id that doesn't exist. ADMIN can assign during or after the KYB check, but not while the
  application is a `DRAFT`.
- **Sensitive fields are masked in every response**, even to the owner: `taxId` and
  `ownerNationalId` show the last 4 characters, `ownerEmail` the first letter and domain,
  `ownerPhone` the last 3 digits. See [docs/adrs/sensitive-data.md](adrs/sensitive-data.md).
- **Unknown body fields are rejected** with 400, including server-managed ones such as
  `status`.
- **A decision note may not contain the application's own tax ID or national ID** (400).
