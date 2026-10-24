// Prepares log `meta` and errors for output (docs/adrs/sensitive-data.md).
import { maskSensitiveFields } from '../common/mask';
import { redact } from '../common/redact';
import type { SerializedError } from './log-entry';

const CIRCULAR = '[Circular]';

/**
 * Returns a sanitised deep copy of `value`, in three passes:
 * 1. every `Error` at any depth is replaced with its serialized form (never with a stack),
 * 2. `redact()` replaces denylisted keys,
 * 3. `maskSensitiveFields()` masks sensitive values.
 * Errors are reduced first so enumerable fields such as TypeORM's `query`, `parameters`,
 * `driverError` and `detail` never reach `redact()`'s copy. The input is never mutated.
 */
export function sanitizeForLog(value: unknown): unknown {
  return maskSensitiveFields(redact(replaceErrors(value, new WeakSet<object>())));
}

/** The message logged in place of a database error's own message. */
export const DATABASE_ERROR_MESSAGE = 'Database query failed';

/**
 * Reads `name`, `message`, a string `code` and (only when asked) `stack` by name. It never
 * iterates the error, so other enumerable fields are never copied. A non-`Error` value gives a
 * fixed form that holds nothing from the value. A database error (TypeORM's `QueryFailedError`,
 * or any error with a `driverError`) gets a fixed message, because the driver's message can echo
 * input values (`invalid input syntax for type uuid: "..."`); its SQLSTATE `code` is kept.
 */
export function serializeError(
  error: unknown,
  options: { includeStack: boolean },
): SerializedError {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: 'Non-error value thrown' };
  }
  const isDatabaseError = isDatabaseQueryError(error);
  const serialized: SerializedError = {
    name: error.name,
    message: isDatabaseError ? DATABASE_ERROR_MESSAGE : error.message,
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    serialized.code = code;
  }
  if (options.includeStack && typeof error.stack === 'string') {
    serialized.stack = isDatabaseError ? withoutHeader(error.stack, error.name) : error.stack;
  }
  return serialized;
}

function isDatabaseQueryError(error: Error): boolean {
  return error.name === 'QueryFailedError' || 'driverError' in error;
}

// A stack starts with `<name>: <message>`; for a database error that header is replaced so the
// driver's message does not come back through the stack. Only the frames are kept.
function withoutHeader(stack: string, name: string): string {
  const firstFrame = stack.search(/\n\s+at /);
  const frames = firstFrame === -1 ? '' : stack.slice(firstFrame);
  return `${name}: ${DATABASE_ERROR_MESSAGE}${frames}`;
}

// `seen` holds the objects on the current path, so a cycle becomes '[Circular]' (as in redact()).
function replaceErrors(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return serializeError(value, { includeStack: false });
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    const copy = value.map((item) => replaceErrors(item, seen));
    seen.delete(value);
    return copy;
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    // Non-plain objects are copied as plain objects of their own enumerable properties,
    // the same way redact() treats them.
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = replaceErrors(child, seen);
    }
    seen.delete(value);
    return copy;
  }
  return value;
}
