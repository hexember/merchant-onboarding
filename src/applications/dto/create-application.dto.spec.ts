import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { BusinessType } from '../application.enums';
import { CreateApplicationDto, MIN_ID_LENGTH } from './create-application.dto';

// Obviously fake values; only their shape matters to the validator.
const FAKE_UUID = '00000000-0000-4000-8000-000000000001';

function validBody(): Record<string, unknown> {
  return {
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
    websiteUrl: 'https://shop.example.com',
    expectedMonthlyVolumeMinor: 2500000,
    averageTicketSizeMinor: 150000,
    currency: 'NPR',
  };
}

function check(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(CreateApplicationDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('CreateApplicationDto', () => {
  it('accepts a valid body', async () => {
    await expect(check(validBody())).resolves.toEqual([]);
  });

  it('accepts a body without the optional websiteUrl and currency', async () => {
    const body = validBody();
    delete body.websiteUrl;
    delete body.currency;

    await expect(check(body)).resolves.toEqual([]);
  });

  it.each([
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
    'expectedMonthlyVolumeMinor',
    'averageTicketSizeMinor',
  ])('denied: missing required field %s', async (field) => {
    const body = validBody();
    delete body[field];

    expect(failedProperties(await check(body))).toEqual([field]);
  });

  it.each(['541', '54a1', '54111'])('denied: merchantCategoryCode %p', async (value) => {
    const errors = await check({ ...validBody(), merchantCategoryCode: value });

    expect(failedProperties(errors)).toEqual(['merchantCategoryCode']);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'])('denied: amount %p', async (value) => {
    const errors = await check({
      ...validBody(),
      expectedMonthlyVolumeMinor: value,
      averageTicketSizeMinor: value,
    });

    expect(failedProperties(errors).sort()).toEqual([
      'averageTicketSizeMinor',
      'expectedMonthlyVolumeMinor',
    ]);
  });

  it('accepts amounts of 0 and MAX_SAFE_INTEGER', async () => {
    await expect(
      check({
        ...validBody(),
        expectedMonthlyVolumeMinor: Number.MAX_SAFE_INTEGER,
        averageTicketSizeMinor: 0,
      }),
    ).resolves.toEqual([]);
  });

  it.each(['npr', 'NP', null])('denied: currency %p', async (value) => {
    const errors = await check({ ...validBody(), currency: value });

    expect(failedProperties(errors)).toEqual(['currency']);
  });

  it('denied: a malformed ownerEmail', async () => {
    const errors = await check({ ...validBody(), ownerEmail: 'not-an-email' });

    expect(failedProperties(errors)).toEqual(['ownerEmail']);
  });

  it.each(['abc', '12', '+977-00000001234567890123456789'])(
    'denied: ownerPhone %p',
    async (value) => {
      const errors = await check({ ...validBody(), ownerPhone: value });

      expect(failedProperties(errors)).toEqual(['ownerPhone']);
    },
  );

  it.each(['taxId', 'ownerNationalId'])('%s: 7 characters denied, 8 accepted', async (field) => {
    expect(MIN_ID_LENGTH).toBe(8);

    const tooShort = await check({ ...validBody(), [field]: 'FAKE-12' });
    expect(failedProperties(tooShort)).toEqual([field]);
    await expect(check({ ...validBody(), [field]: 'FAKE-123' })).resolves.toEqual([]);
  });

  it('denied: a 201-character businessName', async () => {
    const errors = await check({ ...validBody(), businessName: 'x'.repeat(201) });

    expect(failedProperties(errors)).toEqual(['businessName']);
  });

  it('denied: an empty businessName', async () => {
    const errors = await check({ ...validBody(), businessName: '' });

    expect(failedProperties(errors)).toEqual(['businessName']);
  });

  it('denied: an unknown businessType', async () => {
    const errors = await check({ ...validBody(), businessType: 'LLC' });

    expect(failedProperties(errors)).toEqual(['businessType']);
  });

  it.each(['ftp://files.example.com', 'shop.example.com'])(
    'denied: websiteUrl %p',
    async (value) => {
      const errors = await check({ ...validBody(), websiteUrl: value });

      expect(failedProperties(errors)).toEqual(['websiteUrl']);
    },
  );

  it('accepts websiteUrl null', async () => {
    await expect(check({ ...validBody(), websiteUrl: null })).resolves.toEqual([]);
  });

  // The key is whitelisted with no format check: the service decides (403 for SALES, 400 for a bad
  // ADMIN value). The value must reach the service untouched.
  it.each([null, 'not-a-uuid', FAKE_UUID, 123, {}, []])(
    'salesOwnerId %p passes validation untouched',
    async (value) => {
      const dto = plainToInstance(CreateApplicationDto, { ...validBody(), salesOwnerId: value });

      await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual(
        [],
      );
      expect(dto.salesOwnerId).toEqual(value);
    },
  );

  it.each([
    ['createdById', FAKE_UUID],
    ['status', 'APPROVED'],
    ['kybStatus', 'COMPLETED'],
    ['kybLevel', 'LOW'],
    ['kybScore', 10],
    ['version', 5],
    ['meta', { source: 'api' }],
    ['assignedReviewerId', FAKE_UUID],
    ['id', FAKE_UUID],
    ['submissionCount', 3],
  ])('denied: mass-assignment field %s', async (field, value) => {
    const errors = await check({ ...validBody(), [field]: value });

    expect(failedProperties(errors)).toEqual([field]);
    expect(errors[0]?.constraints).toHaveProperty('whitelistValidation');
  });
});
