// Data source for the TypeORM CLI (migration:run / revert / generate). It runs outside Nest, so
// it is one of the few config-setup files that read process.env directly.
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation';
import { createDataSourceOptions } from './database.options';

// A missing .env is fine: variables already set in the process (e.g. in CI) are used as they are.
config({ quiet: true });

export default new DataSource(createDataSourceOptions(validateEnv(process.env)));
