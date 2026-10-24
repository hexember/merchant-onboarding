import { LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../logging/app-logger.service';
import type { LogEntry } from '../../logging/log-entry';
import type { LogTransport } from '../../logging/log-transport';
import { logSeedFailure, writeSeedFailureWithoutContext } from './seed-failure';

// Fake fixture values only.
const FAKE_HASH = 'fake-hash';
const FAKE_SECRET_STRING = 'fake-secret-string';

interface LoggerCall {
  method: string;
  args: unknown[];
}

class RecordingLogger implements LoggerService {
  readonly calls: LoggerCall[] = [];

  log(...args: unknown[]): void {
    this.calls.push({ method: 'log', args });
  }

  error(...args: unknown[]): void {
    this.calls.push({ method: 'error', args });
  }

  warn(...args: unknown[]): void {
    this.calls.push({ method: 'warn', args });
  }
}

class RecordingTransport implements LogTransport {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

function realLogger(): { logger: AppLogger; transport: RecordingTransport } {
  const values: Record<string, string> = { LOG_LEVEL: 'log', NODE_ENV: 'development' };
  const config = {
    getOrThrow: (key: string): unknown => values[key],
  } as unknown as ConfigService;
  const transport = new RecordingTransport();
  return { logger: new AppLogger(config, [transport]), transport };
}

function errorWithParameters(): Error {
  return Object.assign(new Error('fake seed failure'), {
    code: '23505',
    parameters: [FAKE_HASH],
  });
}

describe('logSeedFailure', () => {
  it('logs an Error once as error("Seed failed", err, "Seed")', () => {
    const logger = new RecordingLogger();
    const err = new Error('fake seed failure');

    logSeedFailure(logger, err);

    expect(logger.calls).toEqual([{ method: 'error', args: ['Seed failed', err, 'Seed'] }]);
  });

  it('denied: a thrown object is not passed to the logger', () => {
    const logger = new RecordingLogger();

    logSeedFailure(logger, { parameters: [FAKE_HASH] });

    expect(logger.calls).toEqual([
      { method: 'error', args: ['Seed failed (non-error value thrown)', 'Seed'] },
    ]);
    const text = JSON.stringify(logger.calls);
    expect(text).not.toContain(FAKE_HASH);
    expect(text).not.toContain('parameters');
  });

  it('denied: a thrown string is not passed to the logger', () => {
    const logger = new RecordingLogger();

    logSeedFailure(logger, FAKE_SECRET_STRING);

    expect(logger.calls).toEqual([
      { method: 'error', args: ['Seed failed (non-error value thrown)', 'Seed'] },
    ]);
    expect(JSON.stringify(logger.calls)).not.toContain(FAKE_SECRET_STRING);
  });

  it.each<[string, unknown]>([
    ['a thrown object', { parameters: [FAKE_HASH] }],
    ['a thrown string', FAKE_SECRET_STRING],
  ])('denied, through the real AppLogger: %s leaves nothing in the entry', (_label, thrown) => {
    const { logger, transport } = realLogger();

    logSeedFailure(logger, thrown);

    expect(transport.entries).toHaveLength(1);
    const [entry] = transport.entries;
    expect(entry?.context).toBe('Seed');
    expect(entry?.error?.stack).toBeUndefined();
    const text = JSON.stringify(entry);
    expect(text).not.toContain(FAKE_HASH);
    expect(text).not.toContain('parameters');
    expect(text).not.toContain(FAKE_SECRET_STRING);
  });
});

describe('writeSeedFailureWithoutContext', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  function onlyStderrLine(): string {
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    const calls = stderr.mock.calls as unknown[][];
    const chunk: unknown = calls[0]?.[0];
    if (typeof chunk !== 'string') {
      throw new Error('expected a string chunk');
    }
    expect(chunk.endsWith('\n')).toBe(true);
    return chunk;
  }

  it('writes one JSON error line on stderr with name, message and code only', () => {
    writeSeedFailureWithoutContext(errorWithParameters());

    const parsed: unknown = JSON.parse(onlyStderrLine());
    expect(parsed).toMatchObject({ level: 'error', context: 'Seed', message: 'Seed failed' });
    expect((parsed as LogEntry).error).toEqual({
      name: 'Error',
      message: 'fake seed failure',
      code: '23505',
    });
  });

  it.each<[string, unknown]>([
    ['a thrown object', { parameters: [FAKE_HASH] }],
    ['a thrown string', FAKE_SECRET_STRING],
  ])('denied: %s leaves nothing from the value in the line', (_label, thrown) => {
    writeSeedFailureWithoutContext(thrown);

    const line = onlyStderrLine();
    const parsed = JSON.parse(line) as LogEntry;
    expect(parsed.message).toBe('Seed failed (non-error value thrown)');
    expect(parsed.error?.name).toBe('UnknownError');
    expect(line).not.toContain(FAKE_HASH);
    expect(line).not.toContain('parameters');
    expect(line).not.toContain(FAKE_SECRET_STRING);
  });
});
