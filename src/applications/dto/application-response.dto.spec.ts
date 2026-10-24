import { ApplicationStatus, BusinessType, KybStatus } from '../application.enums';
import { MerchantApplication, bigintNumberTransformer } from '../merchant-application.entity';
import { toApplicationResponse } from './application-response.dto';

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

describe('bigintNumberTransformer', () => {
  it('reads a bigint string as a number and keeps null', () => {
    expect(bigintNumberTransformer.from('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigintNumberTransformer.from(null)).toBeNull();
  });

  it('writes the number unchanged', () => {
    expect(bigintNumberTransformer.to(2500000)).toBe(2500000);
  });
});
