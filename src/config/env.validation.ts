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
}

const DEFAULT_NODE_ENV = 'development';
const DEFAULT_APP_PORT = 3000;
const DEFAULT_DB_PORT = 5432;
const MIN_PORT = 1;
const MAX_PORT = 65535;

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
  };

  if (invalid.length > 0) {
    throw new Error(`Invalid or missing environment variables: ${invalid.join(', ')}`);
  }

  return { ...raw, ...typed };
}
