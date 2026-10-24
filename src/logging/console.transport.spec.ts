import { ConsoleTransport, UNSERIALIZABLE_ENTRY_MESSAGE, writeLogLine } from './console.transport';
import type { LogEntry, LogLevel } from './log-entry';

function entry(level: LogLevel): LogEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    level,
    context: 'Spec',
    message: 'fixture message',
    meta: { a: 1 },
  };
}

function chunkText(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as unknown[][];
  const chunk = calls[0]?.[0];
  return typeof chunk === 'string' ? chunk : '';
}

describe('ConsoleTransport', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it.each<LogLevel>(['fatal', 'error', 'warn'])('writes %p to stderr only', (level) => {
    new ConsoleTransport().write(entry(level));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it.each<LogLevel>(['log', 'debug', 'verbose'])('writes %p to stdout only', (level) => {
    new ConsoleTransport().write(entry(level));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes one JSON line that parses back to the entry', () => {
    const logEntry = entry('log');

    new ConsoleTransport().write(logEntry);

    const text = chunkText(stdoutSpy);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(logEntry);
  });

  describe('writeLogLine', () => {
    it('writes an error entry to stderr as one JSON line', () => {
      const logEntry = entry('error');

      writeLogLine(logEntry);

      expect(stdoutSpy).not.toHaveBeenCalled();
      const text = chunkText(stderrSpy);
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toEqual(logEntry);
    });

    it('writes a log entry to stdout as one JSON line', () => {
      const logEntry = entry('log');

      writeLogLine(logEntry);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(JSON.parse(chunkText(stdoutSpy))).toEqual(logEntry);
    });

    it('writes a bigint in meta as a decimal string', () => {
      writeLogLine({ ...entry('log'), meta: { count: BigInt('12345678901234567890') } });

      const parsed = JSON.parse(chunkText(stdoutSpy)) as LogEntry;
      expect(parsed.meta).toEqual({ count: '12345678901234567890' });
    });

    it('writes a fixed line on the same stream when the entry cannot be serialized', () => {
      const failing = {
        toJSON: (): never => {
          throw new Error('fixture serialization failure');
        },
        secret: 'fake-secret-value',
      };

      expect(() => writeLogLine({ ...entry('error'), meta: { failing } })).not.toThrow();

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const text = chunkText(stderrSpy);
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toEqual({
        timestamp: expect.any(String) as unknown,
        level: 'error',
        message: UNSERIALIZABLE_ENTRY_MESSAGE,
      });
      expect(text).not.toContain('fake-secret-value');
      expect(text).not.toContain('fixture message');
    });
  });
});
