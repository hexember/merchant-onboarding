// Shape of one structured log line. No Nest imports, so config validation can use it too.

// Severity order: index 0 is the most severe.
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context?: string;
  message: string;
  meta?: Record<string, unknown>;
  error?: SerializedError;
}
