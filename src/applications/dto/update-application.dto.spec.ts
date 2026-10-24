import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { UPDATABLE_FIELDS, UpdateApplicationDto } from './update-application.dto';

// Obviously fake value; only its shape matters to the validator.
const FAKE_UUID = '00000000-0000-4000-8000-000000000001';

function check(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(UpdateApplicationDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('UpdateApplicationDto', () => {
  it('accepts an empty body (the service rejects it)', async () => {
    await expect(check({})).resolves.toEqual([]);
  });

  it('accepts a single field', async () => {
    await expect(check({ businessName: 'Example Grocers Two' })).resolves.toEqual([]);
  });

  it('accepts websiteUrl null (clears it)', async () => {
    await expect(check({ websiteUrl: null })).resolves.toEqual([]);
  });

  it.each(['businessName', 'taxId', 'currency', 'expectedMonthlyVolumeMinor', 'businessType'])(
    'denied: %s null',
    async (field) => {
      const errors = await check({ [field]: null });

      expect(failedProperties(errors)).toEqual([field]);
    },
  );

  it.each(['taxId', 'ownerNationalId'])('%s: 7 characters denied, 8 accepted', async (field) => {
    expect(failedProperties(await check({ [field]: 'FAKE-12' }))).toEqual([field]);
    await expect(check({ [field]: 'FAKE-123' })).resolves.toEqual([]);
  });

  it('applies the create rules to present fields', async () => {
    const errors = await check({
      merchantCategoryCode: '54a1',
      averageTicketSizeMinor: -1,
      currency: 'npr',
      websiteUrl: 'ftp://files.example.com',
    });

    expect(failedProperties(errors).sort()).toEqual([
      'averageTicketSizeMinor',
      'currency',
      'merchantCategoryCode',
      'websiteUrl',
    ]);
  });

  it.each([
    ['salesOwnerId', FAKE_UUID],
    ['createdById', FAKE_UUID],
    ['status', 'APPROVED'],
    ['kybStatus', 'COMPLETED'],
    ['kybLevel', 'LOW'],
    ['kybScore', 10],
    ['version', 5],
    ['meta', { source: 'api' }],
    ['assignedReviewerId', FAKE_UUID],
  ])('denied: mass-assignment field %s', async (field, value) => {
    const errors = await check({ businessName: 'Example Grocers', [field]: value });

    expect(failedProperties(errors)).toEqual([field]);
    expect(errors[0]?.constraints).toHaveProperty('whitelistValidation');
  });

  it('UPDATABLE_FIELDS never lists a server-managed or ownership field', () => {
    const forbidden = ['salesOwnerId', 'createdById', 'status', 'kybStatus', 'kybLevel', 'meta'];

    expect(UPDATABLE_FIELDS.filter((field) => forbidden.includes(field))).toEqual([]);
  });
});
