import { validateEnv } from './env.validation';

// Neutral sentinel for every string variable. It is not a credential for any system.
const FIXTURE = 'fixture';

function validRaw(): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3001',
    DB_HOST: FIXTURE,
    DB_PORT: '5433',
    DB_USER: FIXTURE,
    DB_PASSWORD: FIXTURE,
    DB_NAME: FIXTURE,
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
});
