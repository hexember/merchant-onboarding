import { REDACTED, redact } from './redact';

describe('redact', () => {
  it.each(['password', 'passwordHash', 'accessToken', 'jwtSecret'])('redacts %p', (key) => {
    expect(redact({ [key]: 'value', keep: 'ok' })).toEqual({ [key]: REDACTED, keep: 'ok' });
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    'redacts %p case-insensitively',
    (key) => {
      expect(redact({ [key]: 'Bearer value' })).toEqual({ [key]: REDACTED });
    },
  );

  it.each(['password_hash', 'access_token', 'JWT_SECRET', 'password-hash'])(
    'redacts the snake/kebab variant %p',
    (key) => {
      expect(redact({ [key]: 'value' })).toEqual({ [key]: REDACTED });
    },
  );

  it.each([
    'DB_PASSWORD',
    'newPassword',
    'currentPassword',
    'token',
    'refreshToken',
    'idToken',
    'secret',
    'apiKey',
    'api_key',
    'cookie',
    'Set-Cookie',
    'hash',
    'jwt',
    'jwtPayload',
    'bearer',
    'credentials',
    'awsCredential',
    'privateKey',
    'private_key',
  ])('redacts %p because it contains a denylisted part', (key) => {
    expect(redact({ [key]: 'value', keep: 'ok' })).toEqual({ [key]: REDACTED, keep: 'ok' });
  });

  it.each(['email', 'taxId', 'ownerNationalId', 'ownerPhone', 'status', 'changed'])(
    'does not redact %p (masking handles it, or it is not sensitive)',
    (key) => {
      expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
    },
  );

  it.each(['authorId', 'pinCode', 'shipping', 'otpSentAt'])(
    'does not redact %p (bare auth, pin and otp are not denylisted)',
    (key) => {
      expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
    },
  );

  it.each(['Bearer abc.def', 'bearer abc', 'BEARER\tabc'])(
    'redacts the bearer-shaped value %p under any key',
    (value) => {
      expect(redact({ note: value, nested: [{ header: value }] })).toEqual({
        note: REDACTED,
        nested: [{ header: REDACTED }],
      });
    },
  );

  it('redacts a JWT-shaped value under any key', () => {
    const jwtShaped = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fake-signature_123';

    expect(redact({ note: jwtShaped, keep: 'ok' })).toEqual({ note: REDACTED, keep: 'ok' });
    expect(redact(jwtShaped)).toBe(REDACTED);
  });

  it.each(['eyJ', 'eyJabc', 'eyJa.b', 'Bearer', 'a Bearer token', 'x.eyJa.b.c'])(
    'leaves the ordinary string %p untouched',
    (value) => {
      expect(redact({ note: value })).toEqual({ note: value });
    },
  );

  it('redacts inside class instances instead of passing them through', () => {
    class Holder {
      constructor(
        public readonly id: number,
        public readonly passwordHash: string,
      ) {}
    }

    expect(redact({ holder: new Holder(1, 'fixture') })).toEqual({
      holder: { id: 1, passwordHash: REDACTED },
    });
  });

  it('redacts inside nested objects and arrays of objects', () => {
    const input = {
      user: { email: 'a@example.com', password: 'value' },
      items: [{ accessToken: 'value', id: 1 }, { id: 2 }],
    };

    expect(redact(input)).toEqual({
      user: { email: 'a@example.com', password: REDACTED },
      items: [{ accessToken: REDACTED, id: 1 }, { id: 2 }],
    });
  });

  it('leaves non-denylisted keys unchanged', () => {
    const input = { name: 'Sam Sales', count: 3, flag: true, nothing: null };

    expect(redact(input)).toEqual(input);
  });

  it('does not mutate the input', () => {
    const input = { password: 'value', nested: { passwordHash: 'value' } };

    redact(input);

    expect(input).toEqual({ password: 'value', nested: { passwordHash: 'value' } });
  });

  it.each([42, 'text', true, null, undefined])('passes the primitive %p through', (value) => {
    expect(redact(value)).toBe(value);
  });

  it('converts a Date to an ISO string', () => {
    expect(redact({ at: new Date('2026-01-02T03:04:05.000Z') })).toEqual({
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('replaces circular references with [Circular]', () => {
    const input: Record<string, unknown> = { name: 'loop' };
    input.self = input;

    expect(redact(input)).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('keeps a repeated (non-circular) reference', () => {
    const shared = { id: 1 };

    expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });
});
