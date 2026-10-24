import { resolveTestDatabaseEnv } from './setup/test-env';

// Pure guard tests (no database). The harness drops DB_NAME_TEST, so these prove it refuses
// anything that is not clearly a separate, local test database.
describe('resolveTestDatabaseEnv', () => {
  const LOCAL = { DB_HOST: 'localhost' };

  describe('denied', () => {
    it('rejects DB_NAME_TEST equal to DB_NAME when there is no DB_NAME_ORIGINAL', () => {
      expect(() =>
        resolveTestDatabaseEnv({ ...LOCAL, DB_NAME: 'app_test', DB_NAME_TEST: 'app_test' }),
      ).toThrow();
    });

    it('rejects DB_NAME_TEST equal to DB_NAME_ORIGINAL', () => {
      expect(() =>
        resolveTestDatabaseEnv({
          ...LOCAL,
          DB_NAME: 'app_test',
          DB_NAME_ORIGINAL: 'app_test',
          DB_NAME_TEST: 'app_test',
        }),
      ).toThrow();
    });

    it('rejects a name without the _test suffix', () => {
      expect(() =>
        resolveTestDatabaseEnv({ ...LOCAL, DB_NAME: 'app', DB_NAME_TEST: 'app_testing' }),
      ).toThrow();
    });

    it('rejects an uppercase name', () => {
      expect(() =>
        resolveTestDatabaseEnv({ ...LOCAL, DB_NAME: 'app', DB_NAME_TEST: 'App_Test' }),
      ).toThrow();
    });

    it('rejects a missing DB_NAME_TEST, naming it', () => {
      expect(() => resolveTestDatabaseEnv({ ...LOCAL, DB_NAME: 'app' })).toThrow('DB_NAME_TEST');
    });

    it('rejects a remote DB_HOST, naming it', () => {
      expect(() =>
        resolveTestDatabaseEnv({
          DB_HOST: 'db.example.com',
          DB_NAME: 'app',
          DB_NAME_TEST: 'app_test',
        }),
      ).toThrow('DB_HOST');
    });

    it('rejects a remote DB_HOST when E2E_ALLOW_REMOTE_DB is not exactly 1', () => {
      expect(() =>
        resolveTestDatabaseEnv({
          DB_HOST: 'db.example.com',
          E2E_ALLOW_REMOTE_DB: 'true',
          DB_NAME: 'app',
          DB_NAME_TEST: 'app_test',
        }),
      ).toThrow('DB_HOST');
    });

    it('rejects a missing DB_HOST, naming it', () => {
      expect(() => resolveTestDatabaseEnv({ DB_NAME: 'app', DB_NAME_TEST: 'app_test' })).toThrow(
        'DB_HOST',
      );
    });
  });

  describe('allowed', () => {
    it('switches DB_NAME to the test name and records the original', () => {
      expect(
        resolveTestDatabaseEnv({ ...LOCAL, DB_NAME: 'app', DB_NAME_TEST: 'app_test' }),
      ).toEqual({ DB_NAME: 'app_test', DB_NAME_ORIGINAL: 'app' });
    });

    it('returns the same result when called again with its own output', () => {
      const first = resolveTestDatabaseEnv({ ...LOCAL, DB_NAME: 'app', DB_NAME_TEST: 'app_test' });

      expect(resolveTestDatabaseEnv({ ...LOCAL, ...first, DB_NAME_TEST: 'app_test' })).toEqual(
        first,
      );
    });

    it('ignores an inherited DB_NAME_ORIGINAL while DB_NAME is not yet switched', () => {
      expect(
        resolveTestDatabaseEnv({
          ...LOCAL,
          DB_NAME: 'app',
          DB_NAME_ORIGINAL: 'stale_name',
          DB_NAME_TEST: 'app_test',
        }),
      ).toEqual({ DB_NAME: 'app_test', DB_NAME_ORIGINAL: 'app' });
    });

    it.each(['localhost', '127.0.0.1', '::1', 'postgres'])('accepts the local host %p', (host) => {
      expect(() =>
        resolveTestDatabaseEnv({ DB_HOST: host, DB_NAME: 'app', DB_NAME_TEST: 'app_test' }),
      ).not.toThrow();
    });

    it('accepts a remote DB_HOST with E2E_ALLOW_REMOTE_DB=1', () => {
      expect(() =>
        resolveTestDatabaseEnv({
          DB_HOST: 'db.example.com',
          E2E_ALLOW_REMOTE_DB: '1',
          DB_NAME: 'app',
          DB_NAME_TEST: 'app_test',
        }),
      ).not.toThrow();
    });
  });
});
