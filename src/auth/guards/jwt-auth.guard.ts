import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UsersRepository } from '../../users/users.repository';
import { IS_PUBLIC_KEY, JWT_ALGORITHM } from '../auth.constants';
import { AuthUser, toAuthUser } from '../auth-user';

// Local shape of the request fields the guard uses (no express types needed).
interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

// `Bearer <token>`: the scheme is case-insensitive, then exactly one space and a non-empty token
// without whitespace.
const BEARER_PATTERN = /^bearer (\S+)$/i;

/** Returns the token from a single-string `Bearer <token>` header, or null. */
function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = BEARER_PATTERN.exec(header);
  return match?.[1] ?? null;
}

/**
 * Global guard: every route needs a valid HS256 bearer token unless it is marked `@Public()`.
 * Every failure is a plain 401; the library's error text (e.g. "jwt expired") is never passed on.
 * After the token checks out, the guard re-reads the caller's own `id` and `role` from the users
 * table (one primary-key lookup), so a deleted user gets 401 and a role change takes effect on
 * the next request. `request.user.role` comes from the database, not from the token.
 * It does not log.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly usersRepository: UsersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthRequestLike>();
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      throw new UnauthorizedException();
    }

    let payload: unknown;
    try {
      payload = await this.jwtService.verifyAsync<object>(token, { algorithms: [JWT_ALGORITHM] });
    } catch {
      throw new UnauthorizedException();
    }

    const claims = toAuthUser(payload);
    if (claims === null) {
      throw new UnauthorizedException();
    }

    // Auth-only lookup of the caller's own row by `sub`; not an application lookup.
    const row = await this.usersRepository.findAuthUserById(claims.id);
    if (row === null) {
      throw new UnauthorizedException();
    }
    request.user = { id: row.id, role: row.role };
    return true;
  }
}
