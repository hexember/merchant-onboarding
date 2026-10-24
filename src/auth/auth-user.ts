import { UserRole } from '../common/common.enums';

/** The authenticated caller, as set on `request.user` by `JwtAuthGuard`. */
export interface AuthUser {
  id: string;
  role: UserRole;
}

/** The only claims put into an access token. */
export interface JwtClaims {
  sub: string;
  role: UserRole;
}

const USER_ROLES: readonly unknown[] = Object.values(UserRole);

function isUserRole(value: unknown): value is UserRole {
  return USER_ROLES.includes(value);
}

/**
 * Turns a verified token payload into an `AuthUser`. Returns null unless the payload is an object
 * with a non-empty string `sub` and a known `role`. Other claims (`iat`, `exp`) are ignored.
 */
export function toAuthUser(payload: unknown): AuthUser | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const { sub, role } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || sub === '' || !isUserRole(role)) {
    return null;
  }
  return { id: sub, role };
}
