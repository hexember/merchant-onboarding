// Key-based denylist redaction for logs, errors and audit meta (docs/adrs/sensitive-data.md).

export const REDACTED = '[REDACTED]';

const CIRCULAR = '[Circular]';

// A key is redacted when its normalised name (lowercased, `_` and `-` removed) contains any of
// these parts. Substring matching also catches `DB_PASSWORD`, `newPassword`, `refreshToken`,
// `apiKey`, `cookie`, etc. It covers the ADR-listed keys (password, passwordHash, accessToken,
// Authorization, the JWT secret) and errs on the side of redacting too much.
const DENYLIST_PATTERN = /(password|secret|token|authorization|cookie|apikey|hash)/;

export function isDenylistedKey(key: string): boolean {
  return DENYLIST_PATTERN.test(normalizeKey(key));
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a deep copy of `value` in which every denylisted key has its value replaced with
 * `REDACTED`. The input is never mutated. Primitives pass through, `Date` becomes an ISO string
 * and circular references become `'[Circular]'`. Any other object (a class instance such as an
 * entity, a `Map`, ...) is copied as a plain object of its own enumerable properties, so it is
 * redacted like a plain object and never passed through as-is.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    const copy = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return copy;
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = isDenylistedKey(key) ? REDACTED : redactValue(child, seen);
    }
    seen.delete(value);
    return copy;
  }
  return value;
}
