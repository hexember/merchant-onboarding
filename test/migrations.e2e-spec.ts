import { DataSource } from 'typeorm';
import { createTestDataSource } from './utils/test-db';

// Proves all three migrations revert cleanly. The suite shares one test database, so afterAll always
// re-runs the migrations, even when an assertion fails, and later spec files find it migrated.
describe('Migrations (e2e)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  afterAll(async () => {
    try {
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });

  async function regclass(name: string): Promise<unknown> {
    const rows: Array<{ oid: unknown }> = await dataSource.query(
      'SELECT to_regclass($1)::text AS oid',
      [name],
    );
    return rows[0]?.oid;
  }

  it('reverting every migration removes every table, type and function', async () => {
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();

    await expect(regclass('users')).resolves.toBeNull();
    await expect(regclass('audit_logs')).resolves.toBeNull();
    await expect(regclass('merchant_applications')).resolves.toBeNull();
    const types: unknown[] = await dataSource.query(
      `SELECT typname FROM pg_type WHERE typname IN ('user_role', 'audit_actor_type', 'audit_action', 'application_status', 'kyb_status', 'kyb_level', 'business_type')`,
    );
    expect(types).toEqual([]);
    const functions: unknown[] = await dataSource.query(
      `SELECT proname FROM pg_proc WHERE proname = 'audit_logs_block_mutation'`,
    );
    expect(functions).toEqual([]);
  });

  it('running the migrations again restores all three tables', async () => {
    await dataSource.runMigrations();

    await expect(regclass('users')).resolves.toBe('users');
    await expect(regclass('audit_logs')).resolves.toBe('audit_logs');
    await expect(regclass('merchant_applications')).resolves.toBe('merchant_applications');
  });
});
