// Token and metadata constants for auth (docs/adrs/auth.md §Auth details).

/** The only signing algorithm. Pinned on sign and verify, so `none` and others are refused. */
export const JWT_ALGORITHM = 'HS256' as const;

/** Access token lifetime: 1h, no refresh tokens. */
export const JWT_EXPIRES_IN_SECONDS = 3600;

/** The one message for every rejected login, so an unknown email and a wrong password look alike. */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';

/** Metadata key set by `@Public()`. */
export const IS_PUBLIC_KEY = 'isPublic';

/** Metadata key set by `@Roles(...)`. */
export const ROLES_KEY = 'roles';
