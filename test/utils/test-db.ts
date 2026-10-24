import { DataSource } from 'typeorm';
import { validateEnv } from '../../src/config/env.validation';
import { createDataSourceOptions } from '../../src/database/database.options';

/** An initialised data source for the test database (DB_NAME was switched by test-env.ts). */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource(createDataSourceOptions(validateEnv(process.env)));
  return dataSource.initialize();
}

/**
 * Empties every table. Test-only: audit_logs rejects TRUNCATE through a trigger, so this turns
 * the user triggers off for the one statement, inside a transaction, and turns them back on.
 * If anything fails the transaction rolls back and the triggers stay enabled.
 */
export async function resetTables(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query('ALTER TABLE "audit_logs" DISABLE TRIGGER USER');
    await manager.query('TRUNCATE TABLE "audit_logs", "users"');
    await manager.query('ALTER TABLE "audit_logs" ENABLE TRIGGER USER');
  });
}
