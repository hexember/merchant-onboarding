import { MASK } from '../common/mask';
import { REDACTED } from '../common/redact';
import { DATABASE_ERROR_MESSAGE, sanitizeForLog, serializeError } from './log-sanitizer';

// Fake fixture values only. None of them is a real credential or identifier.
const FAKE_QUERY = 'SELECT fake_fixture_query';
const FAKE_PARAM = 'fake-hash-param';
const FAKE_DETAIL = 'fake-detail-text';
const FAKE_DRIVER = 'fake-driver-error';
const FAKE_PASSWORD = 'fake-password-for-test';

// An Error shaped like a TypeORM QueryFailedError: enumerable query, parameters, driverError, detail.
function queryError(): Error {
  return Object.assign(new Error('fake db failure'), {
    code: '23505',
    query: FAKE_QUERY,
    parameters: [FAKE_PARAM],
    driverError: { message: FAKE_DRIVER },
    detail: FAKE_DETAIL,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

describe('sanitizeForLog', () => {
  it('redacts denylisted keys at the top level, nested and inside arrays', () => {
    const result = sanitizeForLog({
      password: 'p',
      accessToken: 't',
      nested: { authorization: 'Bearer fake' },
      list: [{ password: 'p' }],
    });

    expect(result).toEqual({
      password: REDACTED,
      accessToken: REDACTED,
      nested: { authorization: REDACTED },
      list: [{ password: REDACTED }],
    });
  });

  it('masks sensitive fields', () => {
    const result = sanitizeForLog({
      taxId: 'TAX123456789',
      email: 'jane@example.com',
      ownerEmail: 'jane@example.com',
      ownerPhone: '+1-555-0100-123',
    });

    expect(result).toEqual({
      taxId: MASK + '6789',
      email: 'j•••@example.com',
      ownerEmail: 'j•••@example.com',
      ownerPhone: MASK + '123',
    });
  });

  it('does not mutate the input', () => {
    const input = { password: 'p', taxId: 'TAX123456789', nested: { email: 'jane@example.com' } };
    const before = JSON.parse(JSON.stringify(input)) as unknown;

    sanitizeForLog(input);

    expect(input).toEqual(before);
  });

  it('serializes a nested Error without its enumerable fields or stack', () => {
    const result = asRecord(sanitizeForLog({ cause: queryError() }));

    expect(result.cause).toEqual({ name: 'Error', message: DATABASE_ERROR_MESSAGE, code: '23505' });
    const text = JSON.stringify(result);
    // Keys are matched with their quotes: the fixed message itself contains the word "query".
    for (const forbidden of [
      '"query"',
      '"parameters"',
      '"driverError"',
      '"detail"',
      '"stack"',
      FAKE_QUERY,
      FAKE_PARAM,
      FAKE_DETAIL,
      FAKE_DRIVER,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('serializes an Error inside an array and keeps other items', () => {
    const result = asRecord(sanitizeForLog({ errors: [queryError(), 'ok'] }));
    const errors = result.errors as unknown[];

    expect(errors[0]).toEqual({ name: 'Error', message: DATABASE_ERROR_MESSAGE, code: '23505' });
    expect(errors[1]).toBe('ok');
  });

  it('serializes a top-level Error', () => {
    expect(sanitizeForLog(queryError())).toEqual({
      name: 'Error',
      message: DATABASE_ERROR_MESSAGE,
      code: '23505',
    });
  });

  it('handles a circular structure that contains an Error', () => {
    const o: Record<string, unknown> = { err: queryError() };
    o.self = o;

    const result = asRecord(sanitizeForLog(o));

    expect(result.self).toBe('[Circular]');
    expect(result.err).toEqual({ name: 'Error', message: DATABASE_ERROR_MESSAGE, code: '23505' });
    expect(JSON.stringify(result)).not.toContain('parameters');
  });

  it('does not mutate an Error in the input', () => {
    const err = queryError();

    sanitizeForLog({ cause: err });

    expect((err as Error & { parameters?: unknown }).parameters).toEqual([FAKE_PARAM]);
  });
});

describe('serializeError', () => {
  it('copies only name, message and a string code', () => {
    const err = Object.assign(queryError(), { password: FAKE_PASSWORD });

    const result = serializeError(err, { includeStack: false });

    expect(result).toEqual({ name: 'Error', message: DATABASE_ERROR_MESSAGE, code: '23505' });
    expect(Object.keys(result).sort()).toEqual(['code', 'message', 'name']);
    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
  });

  it('includes the stack only when asked', () => {
    const err = new Error('fake');

    expect(serializeError(err, { includeStack: true }).stack).toBe(err.stack);
    expect(serializeError(err, { includeStack: false })).not.toHaveProperty('stack');
  });

  it('drops a numeric code', () => {
    const err = Object.assign(new Error('fake'), { code: 42 });

    expect(serializeError(err, { includeStack: false })).not.toHaveProperty('code');
  });

  it.each<[string, unknown]>([
    ['a string', 'secret string'],
    ['an object', { password: 'x' }],
  ])('gives a fixed form for %s and includes nothing from it', (_label, thrown) => {
    const result = serializeError(thrown, { includeStack: true });

    expect(result).toEqual({ name: 'UnknownError', message: 'Non-error value thrown' });
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret string');
    expect(text).not.toContain('password');
  });

  describe('database errors', () => {
    const FAKE_INPUT = 'fake-uuid-input-value';

    function driverMessageError(): Error {
      return Object.assign(new Error(`invalid input syntax for type uuid: "${FAKE_INPUT}"`), {
        code: '22P02',
        driverError: { message: FAKE_INPUT },
      });
    }

    it('denied: an error with a driverError gets a fixed message and keeps its code', () => {
      const result = serializeError(driverMessageError(), { includeStack: false });

      expect(result).toEqual({ name: 'Error', message: DATABASE_ERROR_MESSAGE, code: '22P02' });
      expect(JSON.stringify(result)).not.toContain(FAKE_INPUT);
    });

    it('denied: an error named QueryFailedError gets a fixed message', () => {
      const err = new Error(`invalid input syntax for type uuid: "${FAKE_INPUT}"`);
      err.name = 'QueryFailedError';

      const result = serializeError(err, { includeStack: false });

      expect(result).toEqual({ name: 'QueryFailedError', message: DATABASE_ERROR_MESSAGE });
    });

    it('denied: the stack header does not repeat the driver message', () => {
      const err = driverMessageError();

      const result = serializeError(err, { includeStack: true });

      expect(result.stack).toMatch(new RegExp(`^Error: ${DATABASE_ERROR_MESSAGE}\\n\\s+at `));
      expect(result.stack).not.toContain(FAKE_INPUT);
    });

    it('keeps the message of an ordinary error', () => {
      expect(serializeError(new Error('fixture plain failure'), { includeStack: false })).toEqual({
        name: 'Error',
        message: 'fixture plain failure',
      });
    });
  });
});
