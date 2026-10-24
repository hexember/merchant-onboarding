import { MigrationInterface } from 'typeorm';
import { CreateUsers1792800000000 } from './1792800000000-CreateUsers';
import { CreateAuditLogs1792800000001 } from './1792800000001-CreateAuditLogs';
import { CreateMerchantApplications1792800000002 } from './1792800000002-CreateMerchantApplications';
import { CreateKybChecks1792800000003 } from './1792800000003-CreateKybChecks';

// Every migration, in the order it runs. Add each new migration class here.
// Users come first: audit_logs.actor_role uses the user_role type, and merchant_applications has
// FKs to users. kyb_checks comes last: it has an FK to merchant_applications and reuses the
// kyb_level type that CreateMerchantApplications creates.
export const migrations: Array<new () => MigrationInterface> = [
  CreateUsers1792800000000,
  CreateAuditLogs1792800000001,
  CreateMerchantApplications1792800000002,
  CreateKybChecks1792800000003,
];
