// Points every e2e test at the separate test database (DB_NAME_TEST). This is test setup, so it
// reads and writes process.env directly. Error messages name variables, never values.
import { randomBytes } from 'node:crypto';
import { config } from 'dotenv';

// The harness drops and recreates this database, so the name must clearly be a test database.
const TEST_DB_NAME_PATTERN = /^[a-z_][a-z0-9_]*_test$/;

// Hosts the harness may drop a database on: this machine, or the compose service name.
const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

export interface TestDatabaseEnv {
  DB_NAME: string;
  DB_NAME_ORIGINAL: string;
}

/**
 * Pure guard. The original (dev) name is kept in DB_NAME_ORIGINAL, so a second call (Jest copies
 * global setup's env into each test context) compares against the real dev name again and is a
 * no-op instead of a false failure. DB_NAME_ORIGINAL is trusted only when the switch has already
 * happened (DB_NAME equals DB_NAME_TEST); an inherited value is otherwise ignored. The database
 * host must be local unless E2E_ALLOW_REMOTE_DB=1 is set.
 */
export function resolveTestDatabaseEnv(env: Record<string, string | undefined>): TestDatabaseEnv {
  const testName = env.DB_NAME_TEST;
  const alreadySwitched = env.DB_NAME !== undefined && env.DB_NAME === testName;
  const original = alreadySwitched ? env.DB_NAME_ORIGINAL : env.DB_NAME;
  const host = env.DB_HOST;
  if (host === undefined || host === '') {
    throw new Error('DB_HOST must be set for the e2e tests');
  }
  if (!LOCAL_DB_HOSTS.has(host) && env.E2E_ALLOW_REMOTE_DB !== '1') {
    throw new Error(
      'DB_HOST must be localhost, 127.0.0.1, ::1 or postgres for the e2e tests (set E2E_ALLOW_REMOTE_DB=1 to override)',
    );
  }
  if (original === undefined || original === '') {
    throw new Error('DB_NAME must be set before the e2e tests can choose a test database');
  }
  if (testName === undefined || testName === '') {
    throw new Error('DB_NAME_TEST must be set for the e2e tests');
  }
  if (!TEST_DB_NAME_PATTERN.test(testName)) {
    throw new Error('DB_NAME_TEST must be lowercase letters, digits or _ and end with _test');
  }
  if (testName === original) {
    throw new Error('DB_NAME_TEST must differ from DB_NAME');
  }
  return { DB_NAME: testName, DB_NAME_ORIGINAL: original };
}

/**
 * Returns the JWT_SECRET to use for the e2e run: the configured value when it is non-empty,
 * otherwise a fresh runtime value from `generate`. The generated secret is never written to disk
 * or printed. It never decides an assertion: tests sign and verify through the same app's
 * JwtService, so any valid key gives the same results.
 */
export function ensureTestJwtSecret(
  env: Record<string, string | undefined>,
  generate: () => string = () => randomBytes(32).toString('hex'),
): string {
  const existing = env.JWT_SECRET;
  if (existing !== undefined && existing !== '') {
    return existing;
  }
  return generate();
}

/** Loads .env (a missing file is fine; process env wins) and switches DB_NAME to the test DB. */
export function applyTestDatabaseEnv(): void {
  config({ quiet: true });
  // A secret from .env or the shell wins. The second call (setupFiles after globalSetup) sees the
  // value already set and keeps it, so one process uses one secret.
  process.env.JWT_SECRET = ensureTestJwtSecret(process.env);
  const resolved = resolveTestDatabaseEnv(process.env);
  process.env.DB_NAME = resolved.DB_NAME;
  process.env.DB_NAME_ORIGINAL = resolved.DB_NAME_ORIGINAL;
}

applyTestDatabaseEnv();
