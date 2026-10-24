import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isPlainObject } from '../common/redact';
import { LOG_LEVELS, LogEntry, LogLevel } from './log-entry';
import { sanitizeForLog, serializeError } from './log-sanitizer';
import { LOG_TRANSPORTS, LogTransport } from './log-transport';

// A stack frame line anywhere in a string. Broader than Nest's own check on purpose: it also
// matches stacks whose first frame has no `file:line:col` (`at JSON.parse (<anonymous>)`) and
// stacks of errors whose message spans several lines.
const STACK_LINE = /\n\s+at /;

/** Replaces a stack-looking message in production. */
export const STACK_OMITTED = '[stack omitted]';

/** The message of the fallback entry written when an entry cannot be built. */
export const UNBUILDABLE_ENTRY_MESSAGE = 'Log entry could not be built';

// Levels whose optional params may carry a stack string. `fatal` is included on purpose
// (Nest does not look for a stack there), so a stack passed to `fatal` is dropped in production too.
const STACK_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(['error', 'fatal']);

/**
 * The application logger. Every call becomes one `LogEntry`: `meta` is sanitised
 * (`sanitizeForLog`), errors are serialized (`serializeError`, stack outside production only)
 * and the entry is passed to every transport under `LOG_TRANSPORTS`. A call never throws.
 */
@Injectable()
export class AppLogger implements LoggerService {
  private readonly minLevel: LogLevel;
  private readonly includeStack: boolean;

  constructor(
    config: ConfigService,
    @Inject(LOG_TRANSPORTS) private readonly transports: LogTransport[],
  ) {
    this.minLevel = config.getOrThrow<LogLevel>('LOG_LEVEL');
    this.includeStack = config.getOrThrow<string>('NODE_ENV') !== 'production';
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf(this.minLevel)) {
      return;
    }
    let entry: LogEntry;
    try {
      entry = this.buildEntry(level, message, optionalParams);
    } catch {
      // A bad argument (throwing getter, revoked Proxy) must not throw into the caller. Nothing
      // from the arguments is kept.
      entry = { timestamp: new Date().toISOString(), level, message: UNBUILDABLE_ENTRY_MESSAGE };
    }
    for (const transport of this.transports) {
      try {
        transport.write(entry);
      } catch {
        // A failing transport is skipped silently: logging here could recurse.
      }
    }
  }

  private buildEntry(level: LogLevel, message: unknown, optionalParams: unknown[]): LogEntry {
    // 1. Drop undefined (`new Logger('X').error(msg)` arrives as `error(msg, undefined, 'X')`).
    const params = optionalParams.filter((param) => param !== undefined);

    // 2. Stack string, only for error/fatal, decided before the context.
    let stack: string | undefined;
    if (STACK_LEVELS.has(level)) {
      stack = takeStack(params);
    }

    // 3. Context: a trailing single-line string. A multi-line one is never a context: for
    //    error/fatal it becomes the stack (if there is none yet), otherwise it is dropped.
    let context: string | undefined;
    const last = params[params.length - 1];
    if (typeof last === 'string') {
      params.pop();
      if (!last.includes('\n')) {
        context = last;
      } else if (STACK_LEVELS.has(level) && stack === undefined) {
        stack = last;
      }
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: '',
    };
    if (context !== undefined) {
      entry.context = context;
    }

    // 5. Message (set first, because the stack-only error in step 4 reuses it). In production
    //    a message that looks like a stack (`error(err.stack)`) is replaced.
    const meta: Record<string, unknown> = {};
    if (typeof message === 'string') {
      entry.message = message;
    } else if (message instanceof Error) {
      entry.message = message.message;
    } else {
      meta.value = message;
    }
    if (!this.includeStack && STACK_LINE.test(entry.message)) {
      entry.message = STACK_OMITTED;
    }

    // 4. Errors: the first Error in `message` or `params` becomes `entry.error`.
    if (message instanceof Error) {
      entry.error = serializeError(message, { includeStack: this.includeStack });
    } else {
      const errorIndex = params.findIndex((param) => param instanceof Error);
      if (errorIndex !== -1) {
        const [found] = params.splice(errorIndex, 1);
        entry.error = serializeError(found, { includeStack: this.includeStack });
      } else if (stack !== undefined) {
        entry.error = { name: 'Error', message: entry.message };
        if (this.includeStack) {
          entry.error.stack = stack;
        }
      }
    }

    // 6. Leftovers: plain objects merge into meta (later wins). Strings have no key, so
    //    redact/mask could never apply to them: they are dropped and only counted. Everything
    //    else goes to meta.values.
    const values: unknown[] = [];
    let droppedValues = 0;
    for (const param of params) {
      if (isPlainObject(param)) {
        Object.assign(meta, param);
      } else if (typeof param === 'string') {
        droppedValues += 1;
      } else {
        values.push(param);
      }
    }
    if (values.length > 0) {
      meta.values = values;
    }
    if (droppedValues > 0) {
      meta.droppedValues = droppedValues;
    }

    // 7. Sanitise. In production, a stack string anywhere in meta is replaced too.
    if (Object.keys(meta).length > 0) {
      const sanitised = sanitizeForLog(meta);
      const cleaned = this.includeStack ? sanitised : omitStackStrings(sanitised);
      if (isPlainObject(cleaned)) {
        entry.meta = cleaned;
      }
    }
    return entry;
  }
}

/** Removes and returns the stack string from `params` using Nest's rules, if there is one. */
function takeStack(params: unknown[]): string | undefined {
  if (params.length >= 2) {
    const secondToLast = params[params.length - 2];
    const last = params[params.length - 1];
    if (typeof secondToLast === 'string' && typeof last === 'string') {
      params.splice(params.length - 2, 1);
      return secondToLast;
    }
    return undefined;
  }
  const only = params[0];
  if (params.length === 1 && typeof only === 'string' && STACK_LINE.test(only)) {
    params.pop();
    return only;
  }
  return undefined;
}

// `value` is the output of sanitizeForLog: plain objects, arrays, Dates and primitives, no cycles
// left (they are already '[Circular]').
function omitStackStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return STACK_LINE.test(value) ? STACK_OMITTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => omitStackStrings(item));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = omitStackStrings(child);
    }
    return copy;
  }
  return value;
}
