import { UserRole } from '../../common/common.enums';
import { MASK } from '../../common/mask';
import { REDACTED } from '../../common/redact';
import { AuditAction, AuditActorType, MERCHANT_APPLICATION_ENTITY_TYPE } from '../audit.enums';
import { AuditLog } from '../audit-log.entity';
import { AUDIT_META_MAX_BYTES } from '../audit-log.service';
import { KYB_WORKER_LABEL } from '../../kyb/kyb-job';
import { KNOWN_SYSTEM_ACTOR_LABELS, toAuditLogResponse } from './audit-log-response.dto';

const ROW_ID = '00000000-0000-4000-8000-0000000000e1';
const APP_ID = '00000000-0000-4000-8000-0000000000a1';
const SALES_ID = '00000000-0000-4000-8000-0000000000b1';
const CREATED_AT = new Date('2026-01-02T03:04:05.000Z');

// Fake audit row, as the repository would return it.
function fakeRow(overrides: Partial<AuditLog> = {}): AuditLog {
  const row = new AuditLog();
  Object.assign(row, {
    id: ROW_ID,
    actorType: AuditActorType.USER,
    actorId: SALES_ID,
    actorRole: UserRole.SALES,
    actorLabel: null,
    action: AuditAction.APPLICATION_SUBMITTED,
    entityType: MERCHANT_APPLICATION_ENTITY_TYPE,
    entityId: APP_ID,
    meta: { from: 'DRAFT', to: 'RISK_REVIEW', submissionNo: 1 },
    createdAt: CREATED_AT,
    ...overrides,
  });
  return row;
}

describe('MERCHANT_APPLICATION_ENTITY_TYPE', () => {
  it('is the merchant_application entity type', () => {
    expect(MERCHANT_APPLICATION_ENTITY_TYPE).toBe('merchant_application');
  });
});

describe('toAuditLogResponse', () => {
  it('returns exactly the allow-listed keys, in order, and no extra row properties', () => {
    const row = Object.assign(fakeRow(), { secretField: 'should-not-leak' });

    const result = toAuditLogResponse(row);

    expect(Object.keys(result)).toEqual([
      'id',
      'action',
      'actorType',
      'actorId',
      'actorRole',
      'actorLabel',
      'createdAt',
      'meta',
    ]);
    expect(result).not.toHaveProperty('entityType');
    expect(result).not.toHaveProperty('entityId');
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
  });

  it('copies the USER row fields', () => {
    expect(toAuditLogResponse(fakeRow())).toEqual({
      id: ROW_ID,
      action: AuditAction.APPLICATION_SUBMITTED,
      actorType: AuditActorType.USER,
      actorId: SALES_ID,
      actorRole: UserRole.SALES,
      actorLabel: null,
      createdAt: CREATED_AT,
      meta: { from: 'DRAFT', to: 'RISK_REVIEW', submissionNo: 1 },
    });
  });

  it('maps a SYSTEM row to a null actorId and actorRole and keeps the label', () => {
    const result = toAuditLogResponse(
      fakeRow({
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        actorRole: null,
        actorLabel: 'kyb-worker',
        action: AuditAction.KYB_CHECK_COMPLETED,
      }),
    );

    expect(result.actorType).toBe(AuditActorType.SYSTEM);
    expect(result.actorId).toBeNull();
    expect(result.actorRole).toBeNull();
    expect(result.actorLabel).toBe('kyb-worker');
  });

  it('knows the KYB worker label', () => {
    expect(KNOWN_SYSTEM_ACTOR_LABELS.has(KYB_WORKER_LABEL)).toBe(true);
  });

  it('returns null for a SYSTEM row with an unknown label', () => {
    const result = toAuditLogResponse(
      fakeRow({
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        actorRole: null,
        actorLabel: 'raw@example.com PAN123456789',
      }),
    );

    expect(result.actorLabel).toBeNull();
  });

  it('returns null for a USER row even when it has a label', () => {
    expect(toAuditLogResponse(fakeRow({ actorLabel: KYB_WORKER_LABEL })).actorLabel).toBeNull();
  });

  it('masks substring-matched sensitive keys on read', () => {
    const result = toAuditLogResponse(
      fakeRow({
        meta: {
          oldTaxId: 'PAN111122223333',
          ownerPhoneNumber: '+977-0000000789',
          nationalId: 'NID-FAKE-5432',
        },
      }),
    );

    expect(result.meta).toEqual({
      oldTaxId: `${MASK}3333`,
      ownerPhoneNumber: `${MASK}789`,
      nationalId: `${MASK}5432`,
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('PAN111122223333');
    expect(text).not.toContain('0000000789');
    expect(text).not.toContain('NID-FAKE-5432');
  });

  it('redacts new denylisted keys and bearer/JWT-shaped values on read', () => {
    const jwtShaped = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fake-signature_456';
    const result = toAuditLogResponse(
      fakeRow({
        meta: {
          credentials: 'x',
          privateKey: 'y',
          note: 'Bearer fake-token-value',
          nested: { anything: jwtShaped },
          from: 'DRAFT',
        },
      }),
    );

    expect(result.meta).toEqual({
      credentials: REDACTED,
      privateKey: REDACTED,
      note: REDACTED,
      nested: { anything: REDACTED },
      from: 'DRAFT',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('fake-token-value');
    expect(text).not.toContain(jwtShaped);
  });

  it('masks and redacts raw stored meta on read', () => {
    const result = toAuditLogResponse(
      fakeRow({
        meta: {
          taxId: 'PAN123456789',
          ownerNationalId: 'NID-FAKE-9876',
          ownerEmail: 'raw@example.com',
          ownerPhone: '+977-0000000456',
          password: 'x',
          accessToken: 'y',
          nested: { authorization: 'Bearer z' },
        },
      }),
    );

    expect(result.meta).toEqual({
      taxId: `${MASK}6789`,
      ownerNationalId: `${MASK}9876`,
      ownerEmail: 'r•••@example.com',
      ownerPhone: `${MASK}456`,
      password: REDACTED,
      accessToken: REDACTED,
      nested: { authorization: REDACTED },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('PAN123456789');
    expect(text).not.toContain('NID-FAKE-9876');
    expect(text).not.toContain('raw@example.com');
    expect(text).not.toContain('Bearer z');
  });

  it('leaves already-masked meta (values longer than 4 characters) unchanged', () => {
    const stored = {
      taxId: `${MASK}6789`,
      ownerEmail: 'r•••@example.com',
      ownerPhone: `${MASK}456`,
      password: REDACTED,
      from: 'DRAFT',
    };

    expect(toAuditLogResponse(fakeRow({ meta: { ...stored } })).meta).toEqual(stored);
  });

  it('turns a stored bare MASK into the known 10-bullet value (documented, not idempotent)', () => {
    const result = toAuditLogResponse(fakeRow({ meta: { taxId: MASK } }));

    expect(result.meta).toEqual({ taxId: `${MASK}••••` });
    expect(result.meta.taxId).toBe('••••••••••');
  });

  it('does not mutate the input row meta', () => {
    const meta = {
      taxId: 'PAN123456789',
      password: 'x',
      nested: { ownerEmail: 'raw@example.com' },
    };
    const snapshot = structuredClone(meta);
    const row = fakeRow({ meta });

    toAuditLogResponse(row);

    expect(row.meta).toBe(meta);
    expect(meta).toEqual(snapshot);
  });

  it('replaces oversized stored meta with a truncation marker', () => {
    const meta = { pad: 'x'.repeat(AUDIT_META_MAX_BYTES + 1) };
    const originalBytes = Buffer.byteLength(JSON.stringify(meta), 'utf8');

    expect(toAuditLogResponse(fakeRow({ meta })).meta).toEqual({ truncated: true, originalBytes });
  });
});
