// Validates the environment once at startup (ConfigModule `validate`) and for the CLI data source.
// Error messages name the invalid variables, never their values.

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  SWAGGER_ENABLED: boolean;
  JWT_SECRET: string;
}

const DEFAULT_NODE_ENV = 'development';
const DEFAULT_APP_PORT = 3000;
const DEFAULT_DB_PORT = 5432;
const MIN_PORT = 1;
const MAX_PORT = 65535;
// HS256 key floor: 32 characters (256 bits). A short placeholder such as `change-me` fails fast.
export const JWT_SECRET_MIN_LENGTH = 32;
// A long but trivial key (e.g. 32 times 'a', or 'abab...') is refused: it needs at least this
// many distinct characters. Random hex or base64 output has far more.
export const JWT_SECRET_MIN_DISTINCT_CHARS = 8;
// The `.env.example` placeholder, refused in any case even when padded to the minimum length.
const SECRET_PLACEHOLDER = 'change-me';

function readRequiredString(raw: Record<string, unknown>, name: string, invalid: string[]): string {
  const value = raw[name];
  if (typeof value !== 'string' || value.trim() === '') {
    invalid.push(name);
    return '';
  }
  return value;
}

// Required secret: a string that is not blank, has at least `minLength` characters and
// `JWT_SECRET_MIN_DISTINCT_CHARS` distinct characters, and does not contain the `change-me`
// placeholder (any case). The value is returned as given (not trimmed), so the key is exactly
// what was configured. Only the name is reported, never the value.
function readSecret(
  raw: Record<string, unknown>,
  name: string,
  minLength: number,
  invalid: string[],
): string {
  const value = raw[name];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length < minLength ||
    new Set(value).size < JWT_SECRET_MIN_DISTINCT_CHARS ||
    value.toLowerCase().includes(SECRET_PLACEHOLDER)
  ) {
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
    JWT_SECRET: readSecret(raw, 'JWT_SECRET', JWT_SECRET_MIN_LENGTH, invalid),
  };

  if (invalid.length > 0) {
    throw new Error(`Invalid or missing environment variables: ${invalid.join(', ')}`);
  }

  return { ...raw, ...typed };
}
