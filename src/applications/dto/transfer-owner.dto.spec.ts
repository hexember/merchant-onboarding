import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { TransferOwnerDto } from './transfer-owner.dto';

// Obviously fake value; only its shape matters to the validator.
const FAKE_UUID = '00000000-0000-4000-8000-000000000002';

function check(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(TransferOwnerDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('TransferOwnerDto', () => {
  it('accepts a UUID string', async () => {
    await expect(check({ salesOwnerId: FAKE_UUID })).resolves.toEqual([]);
  });

  it('accepts a non-UUID string (the service rejects it)', async () => {
    await expect(check({ salesOwnerId: 'not-a-uuid' })).resolves.toEqual([]);
  });

  it('denied: salesOwnerId missing', async () => {
    expect(failedProperties(await check({}))).toEqual(['salesOwnerId']);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
  ])('denied: salesOwnerId is %s', async (_label, value) => {
    expect(failedProperties(await check({ salesOwnerId: value }))).toEqual(['salesOwnerId']);
  });

  it.each([
    ['status', 'APPROVED'],
    ['assignedReviewerId', FAKE_UUID],
    ['reviewerId', FAKE_UUID],
  ])('denied: extra field %s', async (field, value) => {
    const errors = await check({ salesOwnerId: FAKE_UUID, [field]: value });

    expect(failedProperties(errors)).toEqual([field]);
    expect(errors[0]?.constraints).toHaveProperty('whitelistValidation');
  });
});
