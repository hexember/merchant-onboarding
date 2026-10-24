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
 *
 * Every spec that calls this (database, auth, seed, audit-log, applications) now also empties
 * merchant_applications: its FKs to users mean Postgres only allows truncating users together
 * with it in one statement. kyb_checks has an FK to merchant_applications, so it is emptied in
 * the same statement too.
 */
export async function resetTables(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query('ALTER TABLE "audit_logs" DISABLE TRIGGER USER');
    await manager.query('TRUNCATE TABLE "audit_logs", "kyb_checks", "merchant_applications", "users"');
    await manager.query('ALTER TABLE "audit_logs" ENABLE TRIGGER USER');
  });
}

/**
 * Empties audit_logs, kyb_checks and merchant_applications (one statement: kyb_checks has an FK
 * to merchant_applications) but keeps users, so a spec can insert its users and log in once. Same
 * test-only trigger handling as `resetTables`.
 */
export async function resetApplicationData(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query('ALTER TABLE "audit_logs" DISABLE TRIGGER USER');
    await manager.query('TRUNCATE TABLE "audit_logs", "kyb_checks", "merchant_applications"');
    await manager.query('ALTER TABLE "audit_logs" ENABLE TRIGGER USER');
  });
}
