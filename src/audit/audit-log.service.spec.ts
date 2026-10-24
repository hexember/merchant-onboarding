import { DataSource, EntityManager } from 'typeorm';
import { MASK } from '../common/mask';
import { REDACTED } from '../common/redact';
import { UserRole } from '../common/user-role.enum';
import { AuditAction, AuditActorType } from './audit.enums';
import { AuditLog } from './audit-log.entity';
import { User } from '../users/user.entity';
import {
  AUDIT_META_MAX_BYTES,
  AuditEntry,
  AuditLogService,
  InvalidAuditEntryError,
  assertValidAuditEntry,
  buildAuditMeta,
} from './audit-log.service';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const APPLICATION_ID = '00000000-0000-0000-0000-000000000002';

// `{"pad":""}` is 10 bytes, so a pad of (max - 10) bytes makes the JSON exactly the cap.
const PAD_OVERHEAD = Buffer.byteLength(JSON.stringify({ pad: '' }), 'utf8');

describe('buildAuditMeta', () => {
  it('returns {} for undefined', () => {
    expect(buildAuditMeta(undefined)).toEqual({});
  });

  it('redacts password and masks taxId in the same call', () => {
    expect(buildAuditMeta({ password: 'fixture', taxId: 'PAN123456789', status: 'DRAFT' })).toEqual(
      {
        password: REDACTED,
        taxId: `${MASK}6789`,
        status: 'DRAFT',
      },
    );
  });

  it('redacts passwordHash and masks email on a User entity instance nested in meta', () => {
    const user = Object.assign(new User(), {
      id: USER_ID,
      email: 'sam@example.com',
      passwordHash: 'fixture-hash',
      fullName: 'Sam Sales',
      role: UserRole.SALES,
    });

    const result = buildAuditMeta({ user });

    expect(result).toEqual({
      user: {
        id: USER_ID,
        email: 's•••@example.com',
        passwordHash: REDACTED,
        fullName: 'Sam Sales',
        role: UserRole.SALES,
      },
    });
    expect(JSON.stringify(result)).not.toContain('fixture-hash');
  });

  it('copies a Map to a plain object instead of passing it through', () => {
    expect(buildAuditMeta({ lookup: new Map([['password', 'fixture']]) })).toEqual({ lookup: {} });
  });

  it('replaces a circular reference with a marker instead of throwing', () => {
    const meta: Record<string, unknown> = { status: 'DRAFT' };
    meta.self = meta;

    expect(buildAuditMeta(meta)).toEqual({ status: 'DRAFT', self: '[Circular]' });
  });

  it('keeps meta of exactly AUDIT_META_MAX_BYTES', () => {
    const meta = { pad: 'x'.repeat(AUDIT_META_MAX_BYTES - PAD_OVERHEAD) };
    expect(buildAuditMeta(meta)).toEqual(meta);
  });

  it('replaces meta one byte over the cap with a truncation marker', () => {
    const meta = { pad: 'x'.repeat(AUDIT_META_MAX_BYTES - PAD_OVERHEAD + 1) };
    expect(buildAuditMeta(meta)).toEqual({
      truncated: true,
      originalBytes: AUDIT_META_MAX_BYTES + 1,
    });
  });

  it('counts multibyte characters as bytes, not characters', () => {
    // 'é' is 2 bytes in UTF-8: about 4100 characters but 8194 bytes.
    const meta = { pad: 'é'.repeat((AUDIT_META_MAX_BYTES - PAD_OVERHEAD) / 2 + 1) };
    expect(JSON.stringify(meta).length).toBeLessThan(AUDIT_META_MAX_BYTES);
    expect(buildAuditMeta(meta)).toEqual({
      truncated: true,
      originalBytes: AUDIT_META_MAX_BYTES + 2,
    });
  });
});

describe('assertValidAuditEntry', () => {
  const systemEntry: AuditEntry = {
    actorType: AuditActorType.SYSTEM,
    actorLabel: 'kyb-worker',
    action: AuditAction.KYB_CHECK_COMPLETED,
    entityType: 'merchant_application',
    entityId: APPLICATION_ID,
  };
  const userEntry: AuditEntry = {
    actorType: AuditActorType.USER,
    actorId: USER_ID,
    actorRole: UserRole.SALES,
    action: AuditAction.APPLICATION_CREATED,
    entityType: 'merchant_application',
    entityId: APPLICATION_ID,
  };

  it('accepts a valid SYSTEM entry and a valid USER entry', () => {
    expect(() => assertValidAuditEntry(systemEntry)).not.toThrow();
    expect(() => assertValidAuditEntry(userEntry)).not.toThrow();
  });

  it('accepts a USER entry with a null actorId', () => {
    expect(() =>
      assertValidAuditEntry({
        ...userEntry,
        actorId: null,
        actorRole: null,
        action: AuditAction.LOGIN_FAILED,
      }),
    ).not.toThrow();
  });

  it('rejects SYSTEM with an actorId', () => {
    expect(() => assertValidAuditEntry({ ...systemEntry, actorId: USER_ID })).toThrow(
      InvalidAuditEntryError,
    );
  });

  it('rejects SYSTEM without an actorLabel', () => {
    expect(() => assertValidAuditEntry({ ...systemEntry, actorLabel: undefined })).toThrow(
      InvalidAuditEntryError,
    );
  });

  it('rejects SYSTEM with an actorRole', () => {
    expect(() => assertValidAuditEntry({ ...systemEntry, actorRole: UserRole.ADMIN })).toThrow(
      InvalidAuditEntryError,
    );
  });

  it('rejects USER with an actorLabel', () => {
    expect(() => assertValidAuditEntry({ ...userEntry, actorLabel: 'kyb-worker' })).toThrow(
      InvalidAuditEntryError,
    );
  });
});

describe('AuditLogService.record', () => {
  interface MockManager {
    insert: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  }

  function createMockManager(): MockManager {
    return {
      insert: jest.fn().mockResolvedValue(undefined),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
  }

  let defaultManager: MockManager;
  let service: AuditLogService;

  beforeEach(() => {
    defaultManager = createMockManager();
    service = new AuditLogService({ manager: defaultManager } as unknown as DataSource);
  });

  const entry: AuditEntry = {
    actorType: AuditActorType.USER,
    actorId: USER_ID,
    actorRole: UserRole.SALES,
    action: AuditAction.APPLICATION_UPDATED,
    entityType: 'merchant_application',
    entityId: APPLICATION_ID,
    meta: { accessToken: 'fixture', ownerEmail: 'jane@example.com', changed: ['businessName'] },
  };

  it('inserts with sanitised meta through the given manager, not the default one', async () => {
    const txManager = createMockManager();

    await service.record(entry, txManager as unknown as EntityManager);

    expect(defaultManager.insert).not.toHaveBeenCalled();
    expect(txManager.insert).toHaveBeenCalledTimes(1);
    expect(txManager.insert).toHaveBeenCalledWith(AuditLog, {
      actorType: AuditActorType.USER,
      actorId: USER_ID,
      actorRole: UserRole.SALES,
      actorLabel: null,
      action: AuditAction.APPLICATION_UPDATED,
      entityType: 'merchant_application',
      entityId: APPLICATION_ID,
      meta: { accessToken: REDACTED, ownerEmail: 'j•••@example.com', changed: ['businessName'] },
    });
    expect(txManager.save).not.toHaveBeenCalled();
    expect(txManager.update).not.toHaveBeenCalled();
    expect(txManager.delete).not.toHaveBeenCalled();
  });

  it('uses the data source manager when no manager is given', async () => {
    await service.record(entry);

    expect(defaultManager.insert).toHaveBeenCalledTimes(1);
    expect(defaultManager.save).not.toHaveBeenCalled();
    expect(defaultManager.update).not.toHaveBeenCalled();
    expect(defaultManager.delete).not.toHaveBeenCalled();
  });

  it('rejects an invalid entry without inserting', async () => {
    await expect(service.record({ ...entry, actorLabel: 'kyb-worker' })).rejects.toThrow(
      InvalidAuditEntryError,
    );
    expect(defaultManager.insert).not.toHaveBeenCalled();
  });
});
