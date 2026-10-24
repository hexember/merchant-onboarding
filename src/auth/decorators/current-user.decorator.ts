import { ExecutionContext, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { AuthUser } from '../auth-user';

/**
 * Reads the caller set by `JwtAuthGuard`. Throws 401 if it is missing (defensive: the global
 * guard normally guarantees it on every non-public route).
 */
export function currentUserFromContext(ctx: ExecutionContext): AuthUser {
  const request = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  if (request.user === undefined) {
    throw new UnauthorizedException();
  }
  return request.user;
}

/** Handler parameter decorator: `@CurrentUser() user: AuthUser`. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser =>
  currentUserFromContext(ctx),
);
