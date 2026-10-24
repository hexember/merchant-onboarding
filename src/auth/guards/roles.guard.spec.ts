import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../common/common.enums';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../auth.constants';
import { AuthUser } from '../auth-user';
import { RolesGuard } from './roles.guard';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function setup(metadata: { isPublic?: boolean; roles?: UserRole[] }): RolesGuard {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) {
        return metadata.isPublic;
      }
      if (key === ROLES_KEY) {
        return metadata.roles;
      }
      return undefined;
    }),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

function contextWith(user?: AuthUser): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows a @Public() route without @Roles', () => {
    expect(setup({ isPublic: true }).canActivate(contextWith())).toBe(true);
  });

  it('denied: @Public() with @Roles and no request.user throws UnauthorizedException', () => {
    const guard = setup({ isPublic: true, roles: [UserRole.ADMIN] });

    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });

  it('denied: @Public() with @Roles and the wrong role throws ForbiddenException', () => {
    const guard = setup({ isPublic: true, roles: [UserRole.ADMIN] });

    expect(() => guard.canActivate(contextWith({ id: USER_ID, role: UserRole.SALES }))).toThrow(
      ForbiddenException,
    );
  });

  it('@Public() with @Roles allows a user in the list', () => {
    const guard = setup({ isPublic: true, roles: [UserRole.ADMIN] });

    expect(guard.canActivate(contextWith({ id: USER_ID, role: UserRole.ADMIN }))).toBe(true);
  });

  it('allows any authenticated user when there is no @Roles', () => {
    const guard = setup({});

    expect(guard.canActivate(contextWith({ id: USER_ID, role: UserRole.SALES }))).toBe(true);
  });

  it('allows a role in the list', () => {
    const guard = setup({ roles: [UserRole.ADMIN, UserRole.SALES] });

    expect(guard.canActivate(contextWith({ id: USER_ID, role: UserRole.SALES }))).toBe(true);
  });

  it('denied: throws ForbiddenException for a role not in the list', () => {
    const guard = setup({ roles: [UserRole.ADMIN] });

    expect(() => guard.canActivate(contextWith({ id: USER_ID, role: UserRole.SALES }))).toThrow(
      ForbiddenException,
    );
  });

  it('denied: throws UnauthorizedException when @Roles is set but there is no request.user', () => {
    const guard = setup({ roles: [UserRole.ADMIN] });

    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });
});
