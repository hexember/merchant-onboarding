import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuditAction, AuditActorType } from '../src/audit/audit.enums';
import { AuditEntry, AuditLogService } from '../src/audit/audit-log.service';
import { REDACTED } from '../src/common/redact';
import { UserRole } from '../src/common/user-role.enum';
import { resetTables } from './utils/test-db';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const APPLICATION_ID = '00000000-0000-0000-0000-000000000002';

const entry: AuditEntry = {
  actorType: AuditActorType.USER,
  actorId: USER_ID,
  actorRole: UserRole.SALES,
  action: AuditAction.APPLICATION_UPDATED,
  entityType: 'merchant_application',
  entityId: APPLICATION_ID,
};

async function errorMessageOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error instanceof Error ? error.message : '';
}

describe('AuditLogService (e2e)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let auditLogService: AuditLogService;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    dataSource = module.get(DataSource);
    auditLogService = module.get(AuditLogService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetTables(dataSource);
  });

  async function readMeta(): Promise<unknown[]> {
    const rows: Array<{ meta: unknown }> = await dataSource.query('SELECT meta FROM audit_logs');
    return rows.map((row) => row.meta);
  }

  it('stores meta redacted and masked', async () => {
    await auditLogService.record({
      ...entry,
      meta: { password: 'fixture', taxId: 'PAN123456789', changed: ['businessName'] },
    });

    await expect(readMeta()).resolves.toEqual([
      { password: REDACTED, taxId: '••••••6789', changed: ['businessName'] },
    ]);
  });

  it('stores {} when no meta is given', async () => {
    await auditLogService.record(entry);

    await expect(readMeta()).resolves.toEqual([{}]);
  });

  describe('append-only (denied)', () => {
    beforeEach(async () => {
      await auditLogService.record(entry);
    });

    it('rejects UPDATE', async () => {
      const message = await errorMessageOf(
        dataSource.query(`UPDATE audit_logs SET actor_label = 'changed'`),
      );

      expect(message).toContain('append-only');
    });

    it('rejects DELETE', async () => {
      const message = await errorMessageOf(dataSource.query('DELETE FROM audit_logs'));

      expect(message).toContain('append-only');
    });

    it('rejects TRUNCATE', async () => {
      const message = await errorMessageOf(dataSource.query('TRUNCATE TABLE audit_logs'));

      expect(message).toContain('append-only');
      const rows: Array<{ count: number }> = await dataSource.query(
        'SELECT count(*)::int AS count FROM audit_logs',
      );
      expect(rows).toEqual([{ count: 1 }]);
    });
  });

  it('rolls the audit row back with the transaction it belongs to', async () => {
    const failure = new Error('business change failed');

    await expect(
      dataSource.transaction(async (manager) => {
        await auditLogService.record(entry, manager);
        throw failure;
      }),
    ).rejects.toBe(failure);

    const rows: Array<{ count: number }> = await dataSource.query(
      'SELECT count(*)::int AS count FROM audit_logs',
    );
    expect(rows).toEqual([{ count: 0 }]);
  });
});
