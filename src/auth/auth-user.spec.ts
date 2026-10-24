import { UserRole } from '../common/common.enums';
import { toAuthUser } from './auth-user';

const USER_ID = '00000000-0000-0000-0000-000000000001';

describe('toAuthUser', () => {
  it('maps a valid payload to { id, role } and ignores iat and exp', () => {
    expect(toAuthUser({ sub: USER_ID, role: UserRole.SALES, iat: 1, exp: 3601 })).toEqual({
      id: USER_ID,
      role: UserRole.SALES,
    });
  });

  it.each<[string, unknown]>([
    ['missing sub', { role: UserRole.SALES }],
    ['empty sub', { sub: '', role: UserRole.SALES }],
    ['numeric sub', { sub: 42, role: UserRole.SALES }],
    ['unknown role', { sub: USER_ID, role: 'SUPERUSER' }],
    ['missing role', { sub: USER_ID }],
    ['null', null],
    ['a string', 'not-a-payload'],
    ['an array', [USER_ID, UserRole.ADMIN]],
  ])('denied: returns null for %s', (_label, payload) => {
    expect(toAuthUser(payload)).toBeNull();
  });
});
