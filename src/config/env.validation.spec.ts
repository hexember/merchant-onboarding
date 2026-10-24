import {
  DEFAULT_KYB_FAILURE_RATE,
  DEFAULT_KYB_SCORE_HIGH_MIN,
  DEFAULT_KYB_SCORE_MEDIUM_MIN,
  DEFAULT_QUEUE_PREFIX,
  DEFAULT_REDIS_PORT,
  JWT_SECRET_MIN_DISTINCT_CHARS,
  JWT_SECRET_MIN_LENGTH,
  validateEnv,
} from './env.validation';

// Neutral sentinel for every string variable. It is not a credential for any system.
const FIXTURE = 'fixture';
// Obviously fake signing key of exactly the minimum length ('fixture-xxx...'). Not a real secret.
// It has exactly the minimum of 8 distinct characters (f, i, x, t, u, r, e, -).
const JWT_SECRET_FIXTURE = 'fixture-'.padEnd(JWT_SECRET_MIN_LENGTH, 'x');

function validRaw(): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3001',
    DB_HOST: FIXTURE,
    DB_PORT: '5433',
    DB_USER: FIXTURE,
    DB_PASSWORD: FIXTURE,
    DB_NAME: FIXTURE,
    JWT_SECRET: JWT_SECRET_FIXTURE,
    REDIS_HOST: FIXTURE,
  };
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected function to throw');
}

describe('validateEnv', () => {
  it('returns numeric ports and keeps extra keys', () => {
    const result = validateEnv({ ...validRaw(), SEED_EXTRA: FIXTURE });

    expect(result.PORT).toBe(3001);
    expect(result.DB_PORT).toBe(5433);
    expect(result.NODE_ENV).toBe('test');
    expect(result.SEED_EXTRA).toBe(FIXTURE);
  });

  it('applies defaults for PORT, DB_PORT and NODE_ENV', () => {
    const raw = validRaw();
    delete raw.PORT;
    delete raw.DB_PORT;
    delete raw.NODE_ENV;

    const result = validateEnv(raw);

    expect(result.PORT).toBe(3000);
    expect(result.DB_PORT).toBe(5432);
    expect(result.NODE_ENV).toBe('development');
  });

  it('throws naming DB_HOST when it is missing', () => {
    const raw = validRaw();
    delete raw.DB_HOST;

    expect(errorMessage(() => validateEnv(raw))).toContain('DB_HOST');
  });

  it('throws one error naming every missing variable', () => {
    const raw = validRaw();
    delete raw.DB_HOST;
    delete raw.DB_USER;
    delete raw.DB_PASSWORD;

    const message = errorMessage(() => validateEnv(raw));

    expect(message).toContain('DB_HOST');
    expect(message).toContain('DB_USER');
    expect(message).toContain('DB_PASSWORD');
    expect(message).not.toContain('DB_NAME');
  });

  it.each(['abc', '70000', '0'])('throws naming DB_PORT for %p', (port) => {
    const message = errorMessage(() => validateEnv({ ...validRaw(), DB_PORT: port }));

    expect(message).toContain('DB_PORT');
  });

  it('throws naming PORT when it is not a number', () => {
    expect(errorMessage(() => validateEnv({ ...validRaw(), PORT: 'abc' }))).toContain('PORT');
  });

  it('throws naming DB_NAME when it is an empty string', () => {
    expect(errorMessage(() => validateEnv({ ...validRaw(), DB_NAME: '' }))).toContain('DB_NAME');
  });

  it('does not put variable values in the error message', () => {
    const message = errorMessage(() =>
      validateEnv({ ...validRaw(), DB_PORT: 'not-a-port-value', DB_HOST: '' }),
    );

    expect(message).not.toContain('not-a-port-value');
  });

  describe('SWAGGER_ENABLED', () => {
    it('defaults to true when unset and NODE_ENV=test', () => {
      expect(validateEnv(validRaw()).SWAGGER_ENABLED).toBe(true);
    });

    it('defaults to true when NODE_ENV is unset (development)', () => {
      const raw = validRaw();
      delete raw.NODE_ENV;

      expect(validateEnv(raw).SWAGGER_ENABLED).toBe(true);
    });

    it('defaults to false when NODE_ENV=production', () => {
      expect(validateEnv({ ...validRaw(), NODE_ENV: 'production' }).SWAGGER_ENABLED).toBe(false);
    });

    it.each([
      ['true', true],
      ['false', false],
      [' TRUE ', true],
    ])('parses %p as %p', (value, expected) => {
      expect(validateEnv({ ...validRaw(), SWAGGER_ENABLED: value }).SWAGGER_ENABLED).toBe(expected);
    });

    it('allows an explicit true to override the production default', () => {
      const result = validateEnv({
        ...validRaw(),
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
      });

      expect(result.SWAGGER_ENABLED).toBe(true);
    });

    it('allows an explicit false in development', () => {
      const result = validateEnv({
        ...validRaw(),
        NODE_ENV: 'development',
        SWAGGER_ENABLED: 'false',
      });

      expect(result.SWAGGER_ENABLED).toBe(false);
    });

    it('falls back to the default for an empty string', () => {
      expect(validateEnv({ ...validRaw(), SWAGGER_ENABLED: '' }).SWAGGER_ENABLED).toBe(true);
      expect(
        validateEnv({ ...validRaw(), NODE_ENV: 'production', SWAGGER_ENABLED: '' }).SWAGGER_ENABLED,
      ).toBe(false);
    });

    it.each(['yes', '1', '0', 'enabled'])('throws naming SWAGGER_ENABLED for %p', (value) => {
      const message = errorMessage(() => validateEnv({ ...validRaw(), SWAGGER_ENABLED: value }));

      expect(message).toContain('SWAGGER_ENABLED');
    });

    it('does not put the invalid value in the error message', () => {
      const message = errorMessage(() =>
        validateEnv({ ...validRaw(), SWAGGER_ENABLED: 'not-a-bool-value' }),
      );

      expect(message).toContain('SWAGGER_ENABLED');
      expect(message).not.toContain('not-a-bool-value');
    });
  });

  describe('JWT_SECRET', () => {
    it('accepts exactly the minimum length and returns the value unchanged', () => {
      expect(JWT_SECRET_FIXTURE).toHaveLength(32);
      expect(validateEnv(validRaw()).JWT_SECRET).toBe(JWT_SECRET_FIXTURE);
    });

    it('denied: throws naming JWT_SECRET when it is missing', () => {
      const raw = validRaw();
      delete raw.JWT_SECRET;

      expect(errorMessage(() => validateEnv(raw))).toContain('JWT_SECRET');
    });

    it('denied: throws naming JWT_SECRET for an empty string', () => {
      expect(errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: '' }))).toContain(
        'JWT_SECRET',
      );
    });

    it('denied: throws naming JWT_SECRET for a whitespace-only value', () => {
      const blank = ' '.repeat(JWT_SECRET_MIN_LENGTH);

      expect(errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: blank }))).toContain(
        'JWT_SECRET',
      );
    });

    it('denied: throws naming JWT_SECRET when one character too short', () => {
      const short = JWT_SECRET_FIXTURE.slice(0, JWT_SECRET_MIN_LENGTH - 1);

      expect(errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: short }))).toContain(
        'JWT_SECRET',
      );
    });

    it('the fixture has exactly the minimum number of distinct characters', () => {
      expect(new Set(JWT_SECRET_FIXTURE).size).toBe(JWT_SECRET_MIN_DISTINCT_CHARS);
    });

    // Deterministic stand-ins with the shape of `openssl rand -hex 32` / `-base64 48` output.
    it.each([
      ['hex', '0123456789abcdef'.repeat(4)],
      ['base64', 'Zml4dHVyZS1vbmx5LW5vdC1hLXJlYWwta2V5LWp1c3QtYS10ZXN0LXZhbHVlMTIz'],
    ])('accepts a %s-shaped secret', (_label, secret) => {
      expect(validateEnv({ ...validRaw(), JWT_SECRET: secret }).JWT_SECRET).toBe(secret);
    });

    it.each([
      ['one repeated character', 'a'.repeat(64)],
      ['a short repeated pattern', 'abcd'.repeat(16)],
      ['one distinct character too few', 'abcdefg'.repeat(6)],
    ])('denied: throws naming JWT_SECRET for %s', (_label, secret) => {
      const message = errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: secret }));

      expect(message).toContain('JWT_SECRET');
      expect(message).not.toContain(secret);
    });

    it.each([
      ['padded after', 'change-me-'.padEnd(JWT_SECRET_MIN_LENGTH + 8, 'q1w2e3r4t5')],
      ['in upper case', `prefix-${'CHANGE-ME'}-0123456789abcdefghij`],
    ])('denied: throws naming JWT_SECRET for the change-me placeholder %s', (_label, secret) => {
      expect(secret.length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH);
      const message = errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: secret }));

      expect(message).toContain('JWT_SECRET');
      expect(message).not.toContain(secret);
    });

    it('denied: throws naming JWT_SECRET for a non-string value', () => {
      expect(errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: 12345 }))).toContain(
        'JWT_SECRET',
      );
    });

    it('does not put the secret value in the error message', () => {
      const sentinel = 'sentinel10';
      const message = errorMessage(() => validateEnv({ ...validRaw(), JWT_SECRET: sentinel }));

      expect(message).toContain('JWT_SECRET');
      expect(message).not.toContain(sentinel);
    });
  });

  describe('Redis, queue and KYB settings', () => {
    it('applies the defaults', () => {
      const result = validateEnv(validRaw());

      expect(result.REDIS_HOST).toBe(FIXTURE);
      expect(result.REDIS_PORT).toBe(DEFAULT_REDIS_PORT);
      expect(DEFAULT_REDIS_PORT).toBe(6379);
      expect(result.QUEUE_PREFIX).toBe(DEFAULT_QUEUE_PREFIX);
      expect(DEFAULT_QUEUE_PREFIX).toBe('bull');
      expect(result.KYB_WORKER_ENABLED).toBe(true);
      expect(result.KYB_FAILURE_RATE).toBe(DEFAULT_KYB_FAILURE_RATE);
      expect(DEFAULT_KYB_FAILURE_RATE).toBe(0.2);
      expect(result.KYB_SCORE_MEDIUM_MIN).toBe(DEFAULT_KYB_SCORE_MEDIUM_MIN);
      expect(DEFAULT_KYB_SCORE_MEDIUM_MIN).toBe(40);
      expect(result.KYB_SCORE_HIGH_MIN).toBe(DEFAULT_KYB_SCORE_HIGH_MIN);
      expect(DEFAULT_KYB_SCORE_HIGH_MIN).toBe(70);
    });

    it('parses valid overrides', () => {
      const result = validateEnv({
        ...validRaw(),
        REDIS_PORT: '6380',
        QUEUE_PREFIX: 'mo-e2e-abc_1',
        KYB_WORKER_ENABLED: 'false',
        KYB_SCORE_MEDIUM_MIN: '30',
        KYB_SCORE_HIGH_MIN: '80',
      });

      expect(result.REDIS_PORT).toBe(6380);
      expect(result.QUEUE_PREFIX).toBe('mo-e2e-abc_1');
      expect(result.KYB_WORKER_ENABLED).toBe(false);
      expect(result.KYB_SCORE_MEDIUM_MIN).toBe(30);
      expect(result.KYB_SCORE_HIGH_MIN).toBe(80);
    });

    it.each([
      ['0', 0],
      ['1', 1],
      ['0.5', 0.5],
    ])('parses KYB_FAILURE_RATE %p as %p', (value, expected) => {
      expect(validateEnv({ ...validRaw(), KYB_FAILURE_RATE: value }).KYB_FAILURE_RATE).toBe(
        expected,
      );
    });

    it('falls back to the default QUEUE_PREFIX for an empty string', () => {
      expect(validateEnv({ ...validRaw(), QUEUE_PREFIX: '' }).QUEUE_PREFIX).toBe('bull');
    });

    it('denied: throws naming REDIS_HOST when it is missing', () => {
      const raw = validRaw();
      delete raw.REDIS_HOST;

      expect(errorMessage(() => validateEnv(raw))).toContain('REDIS_HOST');
    });

    it('denied: throws naming REDIS_HOST when it is blank', () => {
      expect(errorMessage(() => validateEnv({ ...validRaw(), REDIS_HOST: '   ' }))).toContain(
        'REDIS_HOST',
      );
    });

    it.each([
      ['REDIS_PORT', '0'],
      ['REDIS_PORT', '70000'],
      ['REDIS_PORT', 'abc'],
      ['QUEUE_PREFIX', 'a:b'],
      ['QUEUE_PREFIX', 'p'.repeat(51)],
      ['KYB_FAILURE_RATE', '-0.1'],
      ['KYB_FAILURE_RATE', '1.5'],
      ['KYB_FAILURE_RATE', 'abc'],
      ['KYB_FAILURE_RATE', 'NaN'],
      ['KYB_SCORE_MEDIUM_MIN', '101'],
      ['KYB_SCORE_MEDIUM_MIN', '-1'],
      ['KYB_SCORE_MEDIUM_MIN', '4.5'],
      ['KYB_SCORE_HIGH_MIN', '101'],
      ['KYB_SCORE_HIGH_MIN', '-1'],
      ['KYB_SCORE_HIGH_MIN', '4.5'],
    ])('denied: throws naming %s for %p without echoing the value', (name, value) => {
      const message = errorMessage(() => validateEnv({ ...validRaw(), [name]: value }));

      expect(message).toContain(name);
      expect(message).not.toContain(value);
    });

    it('accepts a QUEUE_PREFIX of exactly 50 characters', () => {
      const prefix = 'p'.repeat(50);

      expect(validateEnv({ ...validRaw(), QUEUE_PREFIX: prefix }).QUEUE_PREFIX).toBe(prefix);
    });

    it('denied: throws naming KYB_SCORE_HIGH_MIN when MEDIUM_MIN is not below HIGH_MIN', () => {
      const message = errorMessage(() =>
        validateEnv({ ...validRaw(), KYB_SCORE_MEDIUM_MIN: '70', KYB_SCORE_HIGH_MIN: '70' }),
      );

      expect(message).toContain('KYB_SCORE_HIGH_MIN');
      expect(message).not.toContain('KYB_SCORE_MEDIUM_MIN');
    });

    it('denied: throws naming KYB_WORKER_ENABLED for a non-boolean value', () => {
      expect(
        errorMessage(() => validateEnv({ ...validRaw(), KYB_WORKER_ENABLED: 'yes' })),
      ).toContain('KYB_WORKER_ENABLED');
    });
  });
});
