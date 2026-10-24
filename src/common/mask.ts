// Masking helpers for sensitive values in API responses and audit meta
// (docs/adrs/sensitive-data.md).
import { normalizeKey } from './redact';

// Fixed-length prefix, so the mask never reveals the length of the original value.
export const MASK = '••••••';

const EMAIL_MASK = '•••';
const CIRCULAR = '[Circular]';

/** `'PAN123456789'` → `'••••••6789'`. Values of 4 characters or fewer become `MASK` only. */
export function maskLast4(value: string): string {
  if (value.length <= 4) {
    return MASK;
  }
  return MASK + value.slice(-4);
}

/** `'jane@example.com'` → `'j•••@example.com'`. No `@` or an empty local part → `'•••'`. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) {
    return EMAIL_MASK;
  }
  return value.charAt(0) + EMAIL_MASK + value.slice(at);
}

/** `'+977-9800000123'` → `'••••••123'`. Fewer than 3 digits → `MASK`. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 3) {
    return MASK;
  }
  return MASK + digits.slice(-3);
}

// Normalised key name → mask function.
const MASKERS: ReadonlyMap<string, (value: string) => string> = new Map([
  ['taxid', maskLast4],
  ['ownernationalid', maskLast4],
  ['owneremail', maskEmail],
  ['email', maskEmail],
  ['ownerphone', maskPhone],
]);

/**
 * Returns a deep copy of `value` with sensitive keys masked at any depth. A non-string value
 * under a sensitive key becomes `MASK`. The input is never mutated. Any non-plain object (a class
 * instance, a `Map`, ...) is copied as a plain object of its own enumerable properties, so it is
 * masked like a plain object and never passed through as-is.
 */
export function maskSensitiveFields(value: unknown): unknown {
  return maskValue(value, new WeakSet<object>());
}

function maskValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    const copy = value.map((item) => maskValue(item, seen));
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
      const masker = MASKERS.get(normalizeKey(key));
      if (masker === undefined) {
        copy[key] = maskValue(child, seen);
      } else {
        copy[key] = typeof child === 'string' ? masker(child) : MASK;
      }
    }
    seen.delete(value);
    return copy;
  }
  return value;
}
