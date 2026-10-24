// Plain log functions for the app (docs/adrs/sensitive-data.md). `meta` is cleaned with the shared
// redact() and mask helpers before anything is printed. In production nothing is printed to the
// terminal; a log service can be added later inside `write`.
import { maskSensitiveFields } from '../common/mask';
import { redact } from '../common/redact';

export type LogMeta = Record<string, unknown>;

type LogLevel = 'info' | 'error';

// Silent until configureLogger runs, so nothing is printed before the environment is known.
let printToTerminal = false;

/** Called once at startup with the validated environment. */
export function configureLogger(options: { production: boolean }): void {
  printToTerminal = !options.production;
}

export function logInfo(context: string, message: string, meta?: LogMeta): void {
  write('info', context, message, meta);
}

export function logError(context: string, message: string, meta?: LogMeta): void {
  write('error', context, message, meta);
}

/**
 * Returns a cleaned copy of `meta`: denylisted keys (password, token, ...) are redacted and
 * personal fields (taxId, email, ...) are masked. A top-level `Error` keeps only its name, message
 * and stack, so extra properties such as a database error's query parameters are never printed.
 */
export function sanitizeMeta(meta: LogMeta): unknown {
  const plain: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    plain[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  return maskSensitiveFields(redact(plain));
}

function write(level: LogLevel, context: string, message: string, meta?: LogMeta): void {
  if (!printToTerminal) {
    return;
  }
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    meta: meta === undefined ? undefined : sanitizeMeta(meta),
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
