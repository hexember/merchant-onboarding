import { ApplicationStatus, BusinessType, KybLevel, KybStatus } from '../application.enums';
import { MerchantApplication, bigintNumberTransformer } from '../merchant-application.entity';
import {
  KYB_LEVEL_LABELS,
  kybLevelLabel,
  toApplicationDetailResponse,
  toApplicationResponse,
} from './application-response.dto';

// Fake application row, as the repository would return it.
function fakeApplication(overrides: Partial<MerchantApplication> = {}): MerchantApplication {
  const app = new MerchantApplication();
  Object.assign(app, {
    id: '00000000-0000-4000-8000-0000000000a1',
    createdById: '00000000-0000-4000-8000-0000000000b1',
    salesOwnerId: '00000000-0000-4000-8000-0000000000b1',
    assignedReviewerId: null,
    businessName: 'Example Grocers',
    legalBusinessName: 'Example Grocers Pvt. Ltd.',
    businessType: BusinessType.PRIVATE_LIMITED,
    registrationNumber: 'REG-FAKE-0001',
    taxId: 'PAN-FAKE-00001234',
    ownerFullName: 'Jane Example',
    ownerEmail: 'owner@example.com',
    ownerPhone: '+977-0000000123',
    ownerNationalId: 'NID-FAKE-5678',
    merchantCategoryCode: '5411',
    websiteUrl: null,
    expectedMonthlyVolumeMinor: 2500000,
    averageTicketSizeMinor: 150000,
    currency: 'NPR',
    status: ApplicationStatus.DRAFT,
    kybStatus: KybStatus.NOT_STARTED,
    kybLevel: null,
    kybScore: null,
    kybAttempts: 0,
    kybLastAttemptAt: null,
    submissionCount: 0,
    decisionNote: null,
    submittedAt: null,
    decidedAt: null,
    version: 1,
    meta: { source: 'api' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
  return app;
}

describe('toApplicationResponse', () => {
  it('masks taxId, ownerNationalId, ownerEmail and ownerPhone', () => {
    const response = toApplicationResponse(fakeApplication());

    expect(response.taxId).toBe('••••••1234');
    expect(response.ownerNationalId).toBe('••••••5678');
    expect(response.ownerEmail).toBe('o•••@example.com');
    expect(response.ownerPhone).toBe('••••••123');
  });

  it('returns exactly the allow-listed keys (no meta, version, KYB fields or relations)', () => {
    const response = toApplicationResponse(
      fakeApplication({ createdBy: undefined, salesOwner: undefined }),
    );

    expect(Object.keys(response).sort()).toEqual(
      [
        'id',
        'createdById',
        'salesOwnerId',
        'assignedReviewerId',
        'businessName',
        'legalBusinessName',
        'businessType',
        'registrationNumber',
        'taxId',
        'ownerFullName',
        'ownerEmail',
        'ownerPhone',
        'ownerNationalId',
        'merchantCategoryCode',
        'websiteUrl',
        'expectedMonthlyVolumeMinor',
        'averageTicketSizeMinor',
        'currency',
        'status',
        'decisionNote',
        'submittedAt',
        'decidedAt',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });

  it('never contains a raw sensitive value', () => {
    const serialized = JSON.stringify(toApplicationResponse(fakeApplication()));

    for (const raw of ['PAN-FAKE-00001234', 'NID-FAKE-5678', 'owner@example.com', '0000000123']) {
      expect(serialized).not.toContain(raw);
    }
  });

  it('keeps websiteUrl null and amounts as numbers', () => {
    const response = toApplicationResponse(fakeApplication());

    expect(response.websiteUrl).toBeNull();
    expect(response.expectedMonthlyVolumeMinor).toBe(2500000);
    expect(response.averageTicketSizeMinor).toBe(150000);
  });
});

describe('toApplicationResponse (no KYB block)', () => {
  it('has no kybCheck, kybStatus or meta key', () => {
    const response = toApplicationResponse(fakeApplication());

    expect(response).not.toHaveProperty('kybCheck');
    expect(response).not.toHaveProperty('kybStatus');
    expect(response).not.toHaveProperty('meta');
  });
});

describe('kybLevelLabel', () => {
  it.each([
    [KybLevel.LOW, 'Good to go'],
    [KybLevel.MEDIUM, 'Fair deal'],
    [KybLevel.HIGH, 'Needs double check'],
    [null, null],
  ])('%s → %s', (level, label) => {
    expect(kybLevelLabel(level)).toBe(label);
  });

  it('has a label for every KYB level and nothing else', () => {
    expect(Object.keys(KYB_LEVEL_LABELS).sort()).toEqual(Object.values(KybLevel).sort());
  });
});

describe('toApplicationDetailResponse', () => {
  const LAST_ATTEMPT_AT = new Date('2026-01-02T00:00:00.000Z');

  it('a completed check → kybCheck with the derived label', () => {
    const response = toApplicationDetailResponse(
      fakeApplication({
        status: ApplicationStatus.UNDER_REVIEW,
        kybStatus: KybStatus.COMPLETED,
        kybLevel: KybLevel.HIGH,
        kybScore: 78,
        kybAttempts: 2,
        kybLastAttemptAt: LAST_ATTEMPT_AT,
      }),
    );

    expect(response.kybCheck).toEqual({
      status: KybStatus.COMPLETED,
      level: KybLevel.HIGH,
      label: 'Needs double check',
      score: 78,
      attempts: 2,
      lastAttemptAt: LAST_ATTEMPT_AT,
    });
    expect(Object.keys(response.kybCheck)).toEqual([
      'status',
      'level',
      'label',
      'score',
      'attempts',
      'lastAttemptAt',
    ]);
  });

  it('a failed check → level, label and score null', () => {
    const response = toApplicationDetailResponse(
      fakeApplication({
        status: ApplicationStatus.UNDER_REVIEW,
        kybStatus: KybStatus.FAILED,
        kybLevel: null,
        kybScore: null,
        kybAttempts: 5,
        kybLastAttemptAt: LAST_ATTEMPT_AT,
      }),
    );

    expect(response.kybCheck).toEqual({
      status: KybStatus.FAILED,
      level: null,
      label: null,
      score: null,
      attempts: 5,
      lastAttemptAt: LAST_ATTEMPT_AT,
    });
  });

  it('has the base keys plus kybCheck, in order, and stays masked', () => {
    const app = fakeApplication({ createdBy: undefined, salesOwner: undefined });
    const response = toApplicationDetailResponse(app);

    expect(Object.keys(response)).toEqual([...Object.keys(toApplicationResponse(app)), 'kybCheck']);
    expect(response.taxId).toBe('••••••1234');
    expect(response.ownerNationalId).toBe('••••••5678');
    expect(response.ownerEmail).toBe('o•••@example.com');
    expect(response.ownerPhone).toBe('••••••123');
    const serialized = JSON.stringify(response);
    for (const raw of ['PAN-FAKE-00001234', 'NID-FAKE-5678', 'owner@example.com', '0000000123']) {
      expect(serialized).not.toContain(raw);
    }
    expect(response).not.toHaveProperty('meta');
    expect(response).not.toHaveProperty('version');
    expect(response).not.toHaveProperty('kybStatus');
  });
});

describe('bigintNumberTransformer', () => {
  it('reads a bigint string as a number and keeps null', () => {
    expect(bigintNumberTransformer.from('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigintNumberTransformer.from(null)).toBeNull();
  });

  it('writes the number unchanged', () => {
    expect(bigintNumberTransformer.to(2500000)).toBe(2500000);
  });
});
