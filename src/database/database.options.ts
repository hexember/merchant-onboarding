import { DataSourceOptions } from 'typeorm';
import { AuditLog } from '../audit/audit-log.entity';
import { AppEnv } from '../config/env.validation';
import { User } from '../users/user.entity';
import { migrations } from './migrations';

/** The env keys the data source reads. Callers may pass the full `AppEnv`. */
export type DatabaseEnv = Pick<AppEnv, 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'>;

/**
 * Data source options shared by the Nest app, the TypeORM CLI and the e2e harness.
 * The schema changes only through migrations, and SQL logging stays off so parameter values
 * (such as password hashes) are never printed.
 */
export function createDataSourceOptions(env: DatabaseEnv): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    entities: [User, AuditLog],
    migrations,
    synchronize: false,
    migrationsRun: false,
    // UUID defaults use gen_random_uuid(), built into Postgres 13+, so no extension is installed.
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    logging: false,
  };
}
