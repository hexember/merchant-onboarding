import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../common/common.enums';
import { ROLES_KEY } from '../auth.constants';
import { AuthUser } from '../auth-user';

/**
 * Global guard, runs after `JwtAuthGuard` (docs/adrs/auth.md §Authorization, layer 1). A route
 * with `@Roles(...)` is open only to those roles (wrong role → 403). A route without `@Roles` is
 * open to any authenticated user. `@Roles(...)` is checked first and applies even on a
 * `@Public()` route: there `JwtAuthGuard` sets no user, so the request gets 401.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (roles === undefined || roles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (user === undefined) {
      throw new UnauthorizedException();
    }
    if (!roles.includes(user.role)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
