import { MASK } from '../common/mask';
import { REDACTED } from '../common/redact';
import { configureLogger, logError, logInfo, sanitizeMeta } from './logger';

describe('logger', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function parse(spy: jest.SpyInstance): Record<string, unknown> {
    const firstCall = spy.mock.calls[0] as [string] | undefined;
    return JSON.parse(firstCall?.[0] ?? '') as Record<string, unknown>;
  }

  describe('outside production', () => {
    beforeEach(() => {
      configureLogger({ production: false });
    });

    it('logInfo prints one JSON line to stdout', () => {
      logInfo('Users', 'User created', { role: 'SALES' });

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(parse(logSpy)).toMatchObject({
        level: 'info',
        context: 'Users',
        message: 'User created',
        meta: { role: 'SALES' },
      });
    });

    it('logError prints one JSON line to stderr', () => {
      logError('Users', 'Create failed');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(parse(errorSpy)).toMatchObject({ level: 'error', message: 'Create failed' });
    });

    it('denied: never prints a password, token or raw taxId', () => {
      logInfo('Auth', 'Login', {
        password: 'fake-password',
        accessToken: 'fake-token',
        taxId: 'FAKE-TAX-98765',
      });

      const printed = String((logSpy.mock.calls[0] as [string])[0]);
      expect(printed).not.toContain('fake-password');
      expect(printed).not.toContain('fake-token');
      expect(printed).not.toContain('FAKE-TAX-98765');
    });
  });

  describe('in production', () => {
    beforeEach(() => {
      configureLogger({ production: true });
    });

    it('prints nothing', () => {
      logInfo('Users', 'User created');
      logError('Users', 'Create failed');

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});

describe('sanitizeMeta', () => {
  it('redacts denylisted keys at any depth', () => {
    expect(sanitizeMeta({ user: { passwordHash: 'fake-hash', role: 'ADMIN' } })).toEqual({
      user: { passwordHash: REDACTED, role: 'ADMIN' },
    });
  });

  it('masks personal fields', () => {
    expect(sanitizeMeta({ taxId: 'FAKE-TAX-98765', ownerEmail: 'jane@example.com' })).toEqual({
      taxId: `${MASK}8765`,
      ownerEmail: 'j•••@example.com',
    });
  });

  it('keeps only name, message and stack of an Error', () => {
    const error = Object.assign(new Error('insert failed'), { parameters: ['fake-hash'] });

    const result = sanitizeMeta({ error }) as { error: Record<string, unknown> };

    expect(Object.keys(result.error).sort()).toEqual(['message', 'name', 'stack']);
    expect(JSON.stringify(result)).not.toContain('fake-hash');
  });

  it('does not change the input', () => {
    const meta = { password: 'fake-password' };

    sanitizeMeta(meta);

    expect(meta).toEqual({ password: 'fake-password' });
  });
});
