import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { AssignReviewerDto } from './assign-reviewer.dto';

// Obviously fake value; only its shape matters to the validator.
const FAKE_UUID = '00000000-0000-4000-8000-000000000001';

function check(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(AssignReviewerDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('AssignReviewerDto', () => {
  it('accepts a UUID string', async () => {
    await expect(check({ reviewerId: FAKE_UUID })).resolves.toEqual([]);
  });

  it('accepts a non-UUID string (the service rejects it)', async () => {
    await expect(check({ reviewerId: 'not-a-uuid' })).resolves.toEqual([]);
  });

  it('denied: reviewerId missing', async () => {
    expect(failedProperties(await check({}))).toEqual(['reviewerId']);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
  ])('denied: reviewerId is %s', async (_label, value) => {
    expect(failedProperties(await check({ reviewerId: value }))).toEqual(['reviewerId']);
  });

  it.each([
    ['status', 'APPROVED'],
    ['assignedReviewerId', FAKE_UUID],
    ['salesOwnerId', FAKE_UUID],
  ])('denied: extra field %s', async (field, value) => {
    const errors = await check({ reviewerId: FAKE_UUID, [field]: value });

    expect(failedProperties(errors)).toEqual([field]);
    expect(errors[0]?.constraints).toHaveProperty('whitelistValidation');
  });
});
