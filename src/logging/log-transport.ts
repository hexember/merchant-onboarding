import type { LogEntry } from './log-entry';

/** One output for log entries (terminal today; a file or log service later). */
export interface LogTransport {
  write(entry: LogEntry): void;
}

/**
 * Injection token whose value is a `LogTransport[]`. To add an output, write a class that
 * implements `LogTransport`, provide it in `LoggingModule` and add it to the factory list there.
 */
export const LOG_TRANSPORTS = Symbol('LOG_TRANSPORTS');
