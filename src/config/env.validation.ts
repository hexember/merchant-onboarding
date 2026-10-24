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
  REDIS_HOST: string;
  REDIS_PORT: number;
  QUEUE_PREFIX: string;
  KYB_WORKER_ENABLED: boolean;
  KYB_FAILURE_RATE: number;
  KYB_SCORE_MEDIUM_MIN: number;
  KYB_SCORE_HIGH_MIN: number;
}

const DEFAULT_NODE_ENV = 'development';
const DEFAULT_APP_PORT = 3000;
const DEFAULT_DB_PORT = 5432;
export const DEFAULT_REDIS_PORT = 6379;
// BullMQ's own default key prefix.
export const DEFAULT_QUEUE_PREFIX = 'bull';
// Letters, digits, '_' and '-' only: BullMQ uses ':' as its Redis key separator.
const QUEUE_PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
// Share of simulated provider calls that fail (docs/adrs/kyb-check.md, simulated provider).
export const DEFAULT_KYB_FAILURE_RATE = 0.2;
// KYB score thresholds (docs/adrs/workflow.md §1.3): score >= HIGH_MIN is HIGH, score >=
// MEDIUM_MIN is MEDIUM, anything lower is LOW. Scores are 0..100.
export const DEFAULT_KYB_SCORE_MEDIUM_MIN = 40;
export const DEFAULT_KYB_SCORE_HIGH_MIN = 70;
const MIN_KYB_SCORE = 0;
const MAX_KYB_SCORE = 100;
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

// Optional string that must match `pattern`; unset or empty falls back to the default.
function readPattern(
  raw: Record<string, unknown>,
  name: string,
  pattern: RegExp,
  defaultValue: string,
  invalid: string[],
): string {
  const value = raw[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (typeof value !== 'string' || !pattern.test(value)) {
    invalid.push(name);
    return defaultValue;
  }
  return value;
}

// A rate in [0, 1], given as a decimal string (e.g. '0.2') or a number.
// 'NaN', negatives, values above 1 and non-numeric text are rejected.
function readRate(
  raw: Record<string, unknown>,
  name: string,
  defaultValue: number,
  invalid: string[],
): number {
  const value = raw[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text.trim())) {
    invalid.push(name);
    return defaultValue;
  }
  const rate = Number(text.trim());
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    invalid.push(name);
    return defaultValue;
  }
  return rate;
}

// A whole number in [min, max]; unset or empty falls back to the default.
function readIntInRange(
  raw: Record<string, unknown>,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
  invalid: string[],
): number {
  const value = raw[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text.trim())) {
    invalid.push(name);
    return defaultValue;
  }
  const parsed = Number(text.trim());
  if (parsed < min || parsed > max) {
    invalid.push(name);
    return defaultValue;
  }
  return parsed;
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
    REDIS_HOST: readRequiredString(raw, 'REDIS_HOST', invalid),
    REDIS_PORT: readPort(raw, 'REDIS_PORT', DEFAULT_REDIS_PORT, invalid),
    QUEUE_PREFIX: readPattern(
      raw,
      'QUEUE_PREFIX',
      QUEUE_PREFIX_PATTERN,
      DEFAULT_QUEUE_PREFIX,
      invalid,
    ),
    KYB_WORKER_ENABLED: readBoolean(raw, 'KYB_WORKER_ENABLED', true, invalid),
    KYB_FAILURE_RATE: readRate(raw, 'KYB_FAILURE_RATE', DEFAULT_KYB_FAILURE_RATE, invalid),
    KYB_SCORE_MEDIUM_MIN: readIntInRange(
      raw,
      'KYB_SCORE_MEDIUM_MIN',
      DEFAULT_KYB_SCORE_MEDIUM_MIN,
      MIN_KYB_SCORE,
      MAX_KYB_SCORE,
      invalid,
    ),
    KYB_SCORE_HIGH_MIN: readIntInRange(
      raw,
      'KYB_SCORE_HIGH_MIN',
      DEFAULT_KYB_SCORE_HIGH_MIN,
      MIN_KYB_SCORE,
      MAX_KYB_SCORE,
      invalid,
    ),
  };

  // The levels need a non-empty MEDIUM band: MEDIUM_MIN must be strictly below HIGH_MIN.
  if (
    typed.KYB_SCORE_MEDIUM_MIN >= typed.KYB_SCORE_HIGH_MIN &&
    !invalid.includes('KYB_SCORE_HIGH_MIN')
  ) {
    invalid.push('KYB_SCORE_HIGH_MIN');
  }

  if (invalid.length > 0) {
    throw new Error(`Invalid or missing environment variables: ${invalid.join(', ')}`);
  }

  return { ...raw, ...typed };
}
