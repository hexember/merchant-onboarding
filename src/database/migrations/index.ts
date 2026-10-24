import { MigrationInterface } from 'typeorm';
import { CreateUsers1792800000000 } from './1792800000000-CreateUsers';
import { CreateAuditLogs1792800000001 } from './1792800000001-CreateAuditLogs';

// Every migration, in the order it runs. Add each new migration class here.
// Users come first: audit_logs.actor_role uses the user_role type.
export const migrations: Array<new () => MigrationInterface> = [
  CreateUsers1792800000000,
  CreateAuditLogs1792800000001,
];
