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

/**
 * Picks the mask function for a key, or `undefined` if the key is not sensitive. Like `redact()`,
 * it matches parts of the normalised key name (lowercased, `_` and `-` removed), so variants such
 * as `oldTaxId`, `national_id`, `ownerEmailAddress` or `ownerPhoneNumber` are masked too. It errs
 * on the side of masking too much: `emailVerified: true` becomes `MASK`.
 */
export function maskerForKey(key: string): ((value: string) => string) | undefined {
  const normalized = normalizeKey(key);
  if (normalized.includes('taxid') || normalized.includes('nationalid')) {
    return maskLast4;
  }
  if (normalized.includes('email')) {
    return maskEmail;
  }
  if (normalized.includes('phone')) {
    return maskPhone;
  }
  return undefined;
}

/**
 * Returns a deep copy of `value` with sensitive keys (see `maskerForKey`) masked at any depth. A non-string value
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
      const masker = maskerForKey(key);
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
