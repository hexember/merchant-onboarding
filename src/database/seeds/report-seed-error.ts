// The two ways `npm run seed` reports a failure. A thrown non-Error value is never passed on, so
// nothing from it (a TypeORM `parameters` array, a string that looks like a stack) can be logged.
import { LoggerService } from '@nestjs/common';
import { writeLogLine } from '../../logging/console.transport';
import type { LogEntry } from '../../logging/log-entry';
import { serializeError } from '../../logging/log-sanitizer';

const SEED_CONTEXT = 'Seed';
const ERROR_MESSAGE = 'Seed failed';
const NON_ERROR_MESSAGE = 'Seed failed (non-error value thrown)';

/** Logs a seed failure through the Nest logger (AppLogger once `useLogger` has run). */
export function logSeedFailure(logger: LoggerService, error: unknown): void {
  if (error instanceof Error) {
    // AppLogger serializes the Error (name, message, string code; stack outside production).
    logger.error(ERROR_MESSAGE, error, SEED_CONTEXT);
    return;
  }
  logger.error(NON_ERROR_MESSAGE, SEED_CONTEXT);
}

/**
 * Writes one JSON failure line when no Nest context (and so no AppLogger) exists, for example
 * when env validation or the DB connection failed. Config is not available here and
 * `process.env` must not be read, so the stack is always omitted.
 */
export function writeSeedFailureWithoutContext(error: unknown): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: 'error',
    context: SEED_CONTEXT,
    message: error instanceof Error ? ERROR_MESSAGE : NON_ERROR_MESSAGE,
    // For a non-Error this is the fixed UnknownError form, which holds nothing from the value.
    error: serializeError(error, { includeStack: false }),
  };
  writeLogLine(entry);
}
