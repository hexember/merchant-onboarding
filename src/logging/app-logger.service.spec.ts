import { ConfigService } from '@nestjs/config';
import { MASK } from '../common/mask';
import { REDACTED } from '../common/redact';
import { AppLogger, STACK_OMITTED, UNBUILDABLE_ENTRY_MESSAGE } from './app-logger.service';
import type { LogEntry, LogLevel } from './log-entry';
import type { LogTransport } from './log-transport';

// Fake fixture values only. The stack below points at a made-up file.
const FAKE_FILE = '/fake/path/fixture-file.ts';
const FAKE_STACK = `Error: fixture failure\n    at fixtureFn (${FAKE_FILE}:10:5)\n    at other (${FAKE_FILE}:20:7)`;
// A JSON.parse failure: the first frame has no `file:line:col`.
const FAKE_JSON_PARSE_STACK = `SyntaxError: Unexpected token 'x', "xfake" is not valid JSON\n    at JSON.parse (<anonymous>)\n    at parseFixture (${FAKE_FILE}:3:9)`;
// An Error whose message spans several lines.
const FAKE_MULTILINE_STACK = `Error: fixture failure\nsecond message line\n    at fixtureFn (${FAKE_FILE}:10:5)`;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class RecordingTransport implements LogTransport {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

function fakeConfig(values: { LOG_LEVEL: LogLevel; NODE_ENV: string }): ConfigService {
  return {
    getOrThrow: (key: string): unknown => values[key as keyof typeof values],
  } as unknown as ConfigService;
}

function setup(
  options: { LOG_LEVEL?: LogLevel; NODE_ENV?: string } = {},
  transports?: LogTransport[],
): { logger: AppLogger; transport: RecordingTransport } {
  const transport = new RecordingTransport();
  const logger = new AppLogger(
    fakeConfig({
      LOG_LEVEL: options.LOG_LEVEL ?? 'verbose',
      NODE_ENV: options.NODE_ENV ?? 'development',
    }),
    transports ?? [transport],
  );
  return { logger, transport };
}

function only(transport: RecordingTransport): LogEntry {
  expect(transport.entries).toHaveLength(1);
  const [entry] = transport.entries;
  if (entry === undefined) {
    throw new Error('expected one entry');
  }
  return entry;
}

function errorWithParameters(): Error {
  return Object.assign(new Error('fake db failure'), {
    code: '23505',
    parameters: ['fake-hash-param'],
  });
}

describe('AppLogger', () => {
  describe('argument mapping', () => {
    it('log(msg) gives level and message, no context', () => {
      const { logger, transport } = setup();

      logger.log('msg');

      const entry = only(transport);
      expect(entry).toMatchObject({ level: 'log', message: 'msg' });
      expect(entry).not.toHaveProperty('context');
      expect(entry).not.toHaveProperty('meta');
    });

    it('log(msg, ctx) sets the context', () => {
      const { logger, transport } = setup();

      logger.log('msg', 'Ctx');

      expect(only(transport).context).toBe('Ctx');
    });

    it('log(msg, meta, ctx) sets meta and context', () => {
      const { logger, transport } = setup();

      logger.log('msg', { a: 1 }, 'Ctx');

      const entry = only(transport);
      expect(entry.meta).toEqual({ a: 1 });
      expect(entry.context).toBe('Ctx');
    });

    it('error(msg, stack, ctx) keeps the stack outside production', () => {
      const { logger, transport } = setup({ NODE_ENV: 'development' });

      logger.error('msg', FAKE_STACK, 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry.error).toEqual({ name: 'Error', message: 'msg', stack: FAKE_STACK });
    });

    it('error(msg, stack, ctx) drops the stack in production', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.error('msg', FAKE_STACK, 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry.error).toEqual({ name: 'Error', message: 'msg' });
      expect(JSON.stringify(entry)).not.toContain(FAKE_FILE);
    });

    it('error(msg, non-stack string, ctx) still treats the middle string as the stack (as Nest does)', () => {
      const { logger, transport } = setup({ NODE_ENV: 'development' });

      logger.error('msg', 'not a stack', 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry.error?.stack).toBe('not a stack');
      expect(entry).not.toHaveProperty('meta');
    });

    it('denied: error(msg, stack) in production has no context and no stack text', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.error('msg', FAKE_STACK);

      const entry = only(transport);
      expect(entry).not.toHaveProperty('context');
      const text = JSON.stringify(entry);
      expect(text).not.toContain('    at ');
      expect(text).not.toContain(FAKE_FILE);
      expect(text).not.toContain('fixtureFn');
    });

    it('error(msg, stack) outside production keeps the stack, no context', () => {
      const { logger, transport } = setup({ NODE_ENV: 'development' });

      logger.error('msg', FAKE_STACK);

      const entry = only(transport);
      expect(entry.error?.stack).toBe(FAKE_STACK);
      expect(entry).not.toHaveProperty('context');
    });

    it('error(msg, ctx) with a non-stack string takes it as the context', () => {
      const { logger, transport } = setup();

      logger.error('msg', 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry).not.toHaveProperty('error');
    });

    it('error(msg, undefined, ctx) gives the context and no error', () => {
      const { logger, transport } = setup();

      logger.error('msg', undefined, 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry).not.toHaveProperty('error');
      expect(entry).not.toHaveProperty('meta');
    });

    it('denied: log(a, b, ctx) drops the leftover string and only counts it', () => {
      const { logger, transport } = setup();

      logger.log('a', 'fake-leftover-value', 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry.meta).toEqual({ droppedValues: 1 });
      expect(JSON.stringify(entry)).not.toContain('fake-leftover-value');
    });

    it('keeps non-string leftovers in meta.values', () => {
      const { logger, transport } = setup();

      logger.log('a', 42, [1, 2], 'Ctx');

      expect(only(transport).meta).toEqual({ values: [42, [1, 2]] });
    });

    it('sanitises meta alongside leftover strings', () => {
      const { logger, transport } = setup();

      logger.log('a', { password: 'p' }, 'b', 'Ctx');

      const entry = only(transport);
      expect(entry.context).toBe('Ctx');
      expect(entry.meta).toEqual({ password: REDACTED, droppedValues: 1 });
    });

    it('log(msg, undefined) has no meta and no context', () => {
      const { logger, transport } = setup();

      logger.log('msg', undefined);

      const entry = only(transport);
      expect(entry).not.toHaveProperty('meta');
      expect(entry).not.toHaveProperty('context');
    });

    it('error(err, ctx) uses the error message and serializes the error', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });
      const err = new Error('fixture failure');

      logger.error(err, 'Ctx');

      const entry = only(transport);
      expect(entry.message).toBe('fixture failure');
      expect(entry.error).toEqual({ name: 'Error', message: 'fixture failure' });
      expect(entry.context).toBe('Ctx');
    });

    it('log(object) gives an empty message and meta.value', () => {
      const { logger, transport } = setup();

      logger.log({ a: 1 });

      const entry = only(transport);
      expect(entry.message).toBe('');
      expect(entry.meta).toEqual({ value: { a: 1 } });
    });

    it('denied: fatal(msg, stack) in production has no stack text and no context', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.fatal('msg', FAKE_STACK);

      const entry = only(transport);
      expect(entry).not.toHaveProperty('context');
      const text = JSON.stringify(entry);
      expect(text).not.toContain(FAKE_FILE);
      expect(text).not.toContain('    at ');
    });

    it('error(msg, err) serializes the error without enumerable fields', () => {
      const { logger, transport } = setup({ NODE_ENV: 'development' });

      logger.error('msg', errorWithParameters());

      const entry = only(transport);
      expect(entry.error).toMatchObject({
        name: 'Error',
        message: 'fake db failure',
        code: '23505',
      });
      const text = JSON.stringify(entry);
      expect(text).not.toContain('parameters');
      expect(text).not.toContain('fake-hash-param');
    });

    it('keeps a second Error in meta.values, serialized', () => {
      const { logger, transport } = setup();

      logger.error('msg', new Error('first'), errorWithParameters(), {}, 'Ctx');

      const entry = only(transport);
      expect(entry.error?.message).toBe('first');
      expect(entry.meta).toEqual({
        values: [{ name: 'Error', message: 'fake db failure', code: '23505' }],
      });
      expect(JSON.stringify(entry)).not.toContain('fake-hash-param');
    });

    it('redacts and masks meta', () => {
      const { logger, transport } = setup();

      logger.warn('msg', { password: 'p', taxId: 'TAX123456789' });

      expect(only(transport).meta).toEqual({ password: REDACTED, taxId: MASK + '6789' });
    });

    it('does not mutate the meta passed in', () => {
      const { logger } = setup();
      const meta = { password: 'p', nested: { email: 'jane@example.com' } };
      const before = JSON.parse(JSON.stringify(meta)) as unknown;

      logger.log('msg', meta, 'Ctx');

      expect(meta).toEqual(before);
    });
  });

  describe('stacks in production', () => {
    function expectNoStackText(entry: LogEntry): void {
      const text = JSON.stringify(entry);
      expect(text).not.toContain('    at ');
      expect(text).not.toContain(FAKE_FILE);
      expect(text).not.toContain('<anonymous>');
    }

    it.each<[string, string]>([
      ['a JSON.parse stack', FAKE_JSON_PARSE_STACK],
      ['a multi-line-message stack', FAKE_MULTILINE_STACK],
    ])('denied: error(msg, %s) is taken as the stack, not the context', (_label, stack) => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.error('msg', stack);

      const entry = only(transport);
      expect(entry).not.toHaveProperty('context');
      expect(entry.error).toEqual({ name: 'Error', message: 'msg' });
      expectNoStackText(entry);
    });

    it.each<[string, string]>([
      ['a JSON.parse stack', FAKE_JSON_PARSE_STACK],
      ['a multi-line-message stack', FAKE_MULTILINE_STACK],
    ])('error(msg, %s) keeps it as the stack outside production', (_label, stack) => {
      const { logger, transport } = setup({ NODE_ENV: 'development' });

      logger.error('msg', stack);

      const entry = only(transport);
      expect(entry).not.toHaveProperty('context');
      expect(entry.error?.stack).toBe(stack);
    });

    it.each<'log' | 'warn'>(['log', 'warn'])(
      'denied: %s(msg, stack) drops the stack instead of using it as the context',
      (level) => {
        const { logger, transport } = setup({ NODE_ENV: 'production' });

        logger[level]('msg', FAKE_JSON_PARSE_STACK);

        const entry = only(transport);
        expect(entry).not.toHaveProperty('context');
        expect(entry).not.toHaveProperty('error');
        expectNoStackText(entry);
      },
    );

    it('denied: error(msg, stack, meta) drops the stack from the leftovers', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.error('msg', FAKE_MULTILINE_STACK, { a: 1 });

      const entry = only(transport);
      expect(entry.meta).toEqual({ a: 1, droppedValues: 1 });
      expectNoStackText(entry);
    });

    it('denied: error(stack) replaces the message', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.error(FAKE_JSON_PARSE_STACK);

      const entry = only(transport);
      expect(entry.message).toBe(STACK_OMITTED);
      expectNoStackText(entry);
    });

    it('denied: a stack nested in meta is replaced', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.warn('msg', {
        detail: { trace: FAKE_JSON_PARSE_STACK },
        list: [FAKE_MULTILINE_STACK],
      });

      const entry = only(transport);
      expect(entry.meta).toEqual({ detail: { trace: STACK_OMITTED }, list: [STACK_OMITTED] });
    });

    it('error(msg, stack, multi-line ctx) keeps the first as the stack and drops the context', () => {
      const { logger, transport } = setup({ NODE_ENV: 'production' });

      logger.error('msg', FAKE_STACK, FAKE_JSON_PARSE_STACK);

      const entry = only(transport);
      expect(entry).not.toHaveProperty('context');
      expectNoStackText(entry);
    });
  });

  describe('bad arguments', () => {
    it('writes a fallback entry when a getter throws', () => {
      const { logger, transport } = setup();
      const meta = {
        get boom(): never {
          throw new Error('fixture getter failure');
        },
      };

      expect(() => logger.warn('fake-message-text', meta, 'Ctx')).not.toThrow();

      const entry = only(transport);
      expect(entry).toEqual({
        timestamp: expect.stringMatching(ISO_TIMESTAMP) as unknown,
        level: 'warn',
        message: UNBUILDABLE_ENTRY_MESSAGE,
      });
    });

    it('writes a fallback entry for a revoked Proxy', () => {
      const { logger, transport } = setup();
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();

      expect(() => logger.error('msg', proxy)).not.toThrow();

      expect(only(transport).message).toBe(UNBUILDABLE_ENTRY_MESSAGE);
    });
  });

  it.each<LogLevel>(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])(
    '%p sets level and an ISO timestamp',
    (level) => {
      const { logger, transport } = setup();

      logger[level]('msg');

      const entry = only(transport);
      expect(entry.level).toBe(level);
      expect(entry.timestamp).toMatch(ISO_TIMESTAMP);
    },
  );

  describe('level filter', () => {
    it('with LOG_LEVEL=warn writes only warn, error and fatal', () => {
      const { logger, transport } = setup({ LOG_LEVEL: 'warn' });

      logger.log('msg');
      logger.debug('msg');
      logger.verbose('msg');
      expect(transport.entries).toHaveLength(0);

      logger.warn('msg');
      logger.error('msg');
      logger.fatal('msg');
      expect(transport.entries.map((e) => e.level)).toEqual(['warn', 'error', 'fatal']);
    });

    it('with LOG_LEVEL=verbose writes all six levels', () => {
      const { logger, transport } = setup({ LOG_LEVEL: 'verbose' });

      logger.fatal('msg');
      logger.error('msg');
      logger.warn('msg');
      logger.log('msg');
      logger.debug('msg');
      logger.verbose('msg');

      expect(transport.entries).toHaveLength(6);
    });
  });

  describe('fan-out', () => {
    it('writes the entry to every transport', () => {
      const first = new RecordingTransport();
      const second = new RecordingTransport();
      const { logger } = setup({}, [first, second]);

      logger.log('msg');

      expect(first.entries).toHaveLength(1);
      expect(second.entries).toEqual(first.entries);
    });

    it('skips a throwing transport and still writes to the next one', () => {
      const failing: LogTransport = {
        write: (): void => {
          throw new Error('fixture transport failure');
        },
      };
      const next = new RecordingTransport();
      const { logger } = setup({}, [failing, next]);

      expect(() => logger.log('msg')).not.toThrow();
      expect(next.entries).toHaveLength(1);
    });
  });
});
