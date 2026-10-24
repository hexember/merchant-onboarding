import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../../common/common.enums';
import { UsersRepository } from '../../users/users.repository';
import { AuthUser } from '../auth-user';
import { JwtAuthGuard } from './jwt-auth.guard';

const USER_ID = '00000000-0000-0000-0000-000000000001';
// Not a real token: verifyAsync is mocked, so only the string is passed through.
const FAKE_TOKEN = 'fixture.token.value';

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

function setup(
  options: { isPublic?: boolean; verify?: jest.Mock; findAuthUserById?: jest.Mock } = {},
): {
  guard: JwtAuthGuard;
  verifyAsync: jest.Mock;
  findAuthUserById: jest.Mock;
} {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(options.isPublic),
  } as unknown as Reflector;
  const verifyAsync =
    options.verify ??
    jest.fn().mockResolvedValue({ sub: USER_ID, role: UserRole.SALES, iat: 1, exp: 3601 });
  const jwtService = { verifyAsync } as unknown as JwtService;
  // By default the user still exists with the role from the token.
  const findAuthUserById =
    options.findAuthUserById ?? jest.fn().mockResolvedValue({ id: USER_ID, role: UserRole.SALES });
  const usersRepository = { findAuthUserById } as unknown as UsersRepository;
  return {
    guard: new JwtAuthGuard(reflector, jwtService, usersRepository),
    verifyAsync,
    findAuthUserById,
  };
}

function contextWith(request: FakeRequest): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('allows a @Public() route without verifying anything', async () => {
    const { guard, verifyAsync, findAuthUserById } = setup({ isPublic: true });

    await expect(guard.canActivate(contextWith({ headers: {} }))).resolves.toBe(true);
    expect(verifyAsync).not.toHaveBeenCalled();
    expect(findAuthUserById).not.toHaveBeenCalled();
  });

  it('accepts a valid bearer token, sets request.user and pins HS256', async () => {
    const { guard, verifyAsync, findAuthUserById } = setup();
    const request: FakeRequest = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
    expect(request.user).toEqual({ id: USER_ID, role: UserRole.SALES });
    expect(verifyAsync).toHaveBeenCalledWith(FAKE_TOKEN, { algorithms: ['HS256'] });
    expect(findAuthUserById).toHaveBeenCalledWith(USER_ID);
  });

  it('takes the role from the database, not from the token', async () => {
    const { guard } = setup({
      verify: jest.fn().mockResolvedValue({ sub: USER_ID, role: UserRole.ADMIN }),
      findAuthUserById: jest.fn().mockResolvedValue({ id: USER_ID, role: UserRole.SALES }),
    });
    const request: FakeRequest = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
    expect(request.user).toEqual({ id: USER_ID, role: UserRole.SALES });
  });

  it('denied: a valid token for a user that no longer exists gets 401', async () => {
    const { guard } = setup({ findAuthUserById: jest.fn().mockResolvedValue(null) });
    const request: FakeRequest = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('accepts a lowercase bearer scheme', async () => {
    const { guard } = setup();
    const request: FakeRequest = { headers: { authorization: `bearer ${FAKE_TOKEN}` } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
  });

  it.each<[string, string | string[] | undefined]>([
    ['no header', undefined],
    ['Basic scheme', 'Basic abc'],
    ['Bearer with no token', 'Bearer'],
    ['Bearer with an empty token', 'Bearer '],
    ['Bearer with two parts', 'Bearer a b'],
    ['an array header', [`Bearer ${FAKE_TOKEN}`, `Bearer ${FAKE_TOKEN}`]],
  ])('denied: throws UnauthorizedException for %s', async (_label, authorization) => {
    const { guard, verifyAsync } = setup();
    const request: FakeRequest = { headers: { authorization } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(UnauthorizedException);
    expect(verifyAsync).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('denied: a verify failure becomes a plain 401 without the library message', async () => {
    const { guard } = setup({ verify: jest.fn().mockRejectedValue(new Error('jwt expired')) });
    const request: FakeRequest = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } };

    const error: unknown = await guard
      .canActivate(contextWith(request))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('Unauthorized');
    expect(JSON.stringify((error as UnauthorizedException).getResponse())).not.toContain(
      'jwt expired',
    );
    expect(request.user).toBeUndefined();
  });

  it('denied: a payload with an invalid role is refused', async () => {
    const { guard, findAuthUserById } = setup({
      verify: jest.fn().mockResolvedValue({ sub: USER_ID, role: 'SUPERUSER' }),
    });
    const request: FakeRequest = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(findAuthUserById).not.toHaveBeenCalled();
  });
});
