// Runs once before the e2e suite: recreates the test database and applies every migration, so
// each run proves the migrations work from an empty database.
import { DataSource } from 'typeorm';
import { validateEnv } from '../../src/config/env.validation';
import { createDataSourceOptions } from '../../src/database/database.options';
import { applyTestDatabaseEnv } from './test-env';

export default async function globalSetup(): Promise<void> {
  applyTestDatabaseEnv();
  const env = validateEnv(process.env);

  // env.DB_NAME passed the test-name pattern in applyTestDatabaseEnv. Identifiers cannot be bound
  // as parameters, so it is quoted into the SQL only after that check.
  const maintenance = new DataSource({
    type: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: 'postgres',
    logging: false,
  });
  await maintenance.initialize();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${env.DB_NAME}" WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE "${env.DB_NAME}"`);
  } finally {
    await maintenance.destroy();
  }

  const dataSource = new DataSource(createDataSourceOptions(env));
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
