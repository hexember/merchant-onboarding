// Validates the environment once at startup (ConfigModule `validate`) and for the CLI data source.
// Error messages name the invalid variables, never their values.
import { isLogLevel, type LogLevel } from '../logging/log-entry';

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  SWAGGER_ENABLED: boolean;
  LOG_LEVEL: LogLevel;
}

const DEFAULT_NODE_ENV = 'development';
const DEFAULT_APP_PORT = 3000;
const DEFAULT_DB_PORT = 5432;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_LOG_LEVEL: LogLevel = 'log';

function readRequiredString(raw: Record<string, unknown>, name: string, invalid: string[]): string {
  const value = raw[name];
  if (typeof value !== 'string' || value.trim() === '') {
    invalid.push(name);
    return '';
  }
  return value;
}

function readPort(
  raw: Record<string, unknown>,
  name: string,
  defaultPort: number,
  invalid: string[],
): number {
  const value = raw[name];
  if (value === undefined || value === '') {
    return defaultPort;
  }
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text.trim())) {
    invalid.push(name);
    return defaultPort;
  }
  const port = Number(text.trim());
  if (port < MIN_PORT || port > MAX_PORT) {
    invalid.push(name);
    return defaultPort;
  }
  return port;
}

// Accepts only 'true' or 'false' (trimmed, any case) so the value has one clear spelling;
// '1', '0', 'yes' and 'no' are rejected on purpose.
function readBoolean(
  raw: Record<string, unknown>,
  name: string,
  defaultValue: boolean,
  invalid: string[],
): boolean {
  const value = raw[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') {
      return true;
    }
    if (text === 'false') {
      return false;
    }
  }
  invalid.push(name);
  return defaultValue;
}

// Accepts one of the LOG_LEVELS names (trimmed, any case).
function readLogLevel(
  raw: Record<string, unknown>,
  name: string,
  defaultLevel: LogLevel,
  invalid: string[],
): LogLevel {
  const value = raw[name];
  if (value === undefined || value === '') {
    return defaultLevel;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (isLogLevel(text)) {
      return text;
    }
  }
  invalid.push(name);
  return defaultLevel;
}

export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> & AppEnv {
  const invalid: string[] = [];

  const nodeEnvRaw = raw.NODE_ENV;
  const nodeEnv =
    typeof nodeEnvRaw === 'string' && nodeEnvRaw.trim() !== '' ? nodeEnvRaw : DEFAULT_NODE_ENV;

  const typed: AppEnv = {
    NODE_ENV: nodeEnv,
    PORT: readPort(raw, 'PORT', DEFAULT_APP_PORT, invalid),
    DB_HOST: readRequiredString(raw, 'DB_HOST', invalid),
    DB_PORT: readPort(raw, 'DB_PORT', DEFAULT_DB_PORT, invalid),
    DB_USER: readRequiredString(raw, 'DB_USER', invalid),
    DB_PASSWORD: readRequiredString(raw, 'DB_PASSWORD', invalid),
    DB_NAME: readRequiredString(raw, 'DB_NAME', invalid),
    // Swagger UI (/docs) stays off in production unless someone sets SWAGGER_ENABLED=true on purpose.
    SWAGGER_ENABLED: readBoolean(raw, 'SWAGGER_ENABLED', nodeEnv !== 'production', invalid),
    LOG_LEVEL: readLogLevel(raw, 'LOG_LEVEL', DEFAULT_LOG_LEVEL, invalid),
  };

  if (invalid.length > 0) {
    throw new Error(`Invalid or missing environment variables: ${invalid.join(', ')}`);
  }

  return { ...raw, ...typed };
}
