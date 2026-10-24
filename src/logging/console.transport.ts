import { Injectable } from '@nestjs/common';
import type { LogEntry, LogLevel } from './log-entry';
import type { LogTransport } from './log-transport';

const STDERR_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(['fatal', 'error', 'warn']);

/** The message of the fixed line written when an entry cannot be serialized. */
export const UNSERIALIZABLE_ENTRY_MESSAGE = 'Log entry could not be serialized';

// JSON.stringify throws on a bigint; write it as a decimal string instead.
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Writes `entry` as one JSON line: `fatal`/`error`/`warn` to stderr, everything else to stdout.
 * If the entry cannot be serialized, a fixed line that holds nothing from it is written instead.
 * Exported so code that runs without a Nest container (the startup fallbacks) writes the same
 * format.
 */
export function writeLogLine(entry: LogEntry): void {
  const toStderr = STDERR_LEVELS.has(entry.level);
  let line: string;
  try {
    line = JSON.stringify(entry, jsonReplacer) + '\n';
  } catch {
    line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: entry.level,
        message: UNSERIALIZABLE_ENTRY_MESSAGE,
      }) + '\n';
  }
  if (toStderr) {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

@Injectable()
export class ConsoleTransport implements LogTransport {
  write(entry: LogEntry): void {
    writeLogLine(entry);
  }
}
