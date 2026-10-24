import {
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

  describe('LOG_LEVEL', () => {
    it('defaults to log when unset', () => {
      expect(validateEnv(validRaw()).LOG_LEVEL).toBe('log');
    });

    it('defaults to log for an empty string', () => {
      expect(validateEnv({ ...validRaw(), LOG_LEVEL: '' }).LOG_LEVEL).toBe('log');
    });

    it.each(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])('accepts %p', (level) => {
      expect(validateEnv({ ...validRaw(), LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    });

    it('trims and lowercases the value', () => {
      expect(validateEnv({ ...validRaw(), LOG_LEVEL: ' DEBUG ' }).LOG_LEVEL).toBe('debug');
    });

    it.each(['info', 'trace', '1', 'warning'])('throws naming LOG_LEVEL for %p', (value) => {
      const message = errorMessage(() => validateEnv({ ...validRaw(), LOG_LEVEL: value }));

      expect(message).toContain('LOG_LEVEL');
    });

    it('does not put the invalid value in the error message', () => {
      const message = errorMessage(() =>
        validateEnv({ ...validRaw(), LOG_LEVEL: 'not-a-level-value' }),
      );

      expect(message).toContain('LOG_LEVEL');
      expect(message).not.toContain('not-a-level-value');
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
});
