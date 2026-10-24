import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../../common/common.enums';
import { AuthUser } from '../auth-user';
import { currentUserFromContext } from './current-user.decorator';

function contextWith(request: { user?: AuthUser }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('currentUserFromContext', () => {
  it('returns request.user', () => {
    const user: AuthUser = { id: '00000000-0000-0000-0000-000000000001', role: UserRole.SALES };

    expect(currentUserFromContext(contextWith({ user }))).toBe(user);
  });

  it('denied: throws UnauthorizedException when request.user is missing', () => {
    expect(() => currentUserFromContext(contextWith({}))).toThrow(UnauthorizedException);
  });
});
