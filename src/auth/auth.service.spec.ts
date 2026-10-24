import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditEntry, AuditLogService } from '../audit/audit-log.service';
import { UserRole } from '../common/common.enums';
import { BCRYPT_COST } from '../common/password';
import { User } from '../users/user.entity';
import { UsersRepository } from '../users/users.repository';
import { AuthService } from './auth.service';

jest.mock('bcrypt');

const USER_ID = '00000000-0000-0000-0000-000000000001';
// Obviously fake values: bcrypt and JwtService are mocked, so nothing here is a real credential.
const FAKE_PASSWORD = 'fixture-password';
const FAKE_USER_HASH = 'fixture-user-hash';
const FAKE_DUMMY_HASH = 'fixture-dummy-hash';
const FAKE_TOKEN = 'fixture-token';
const RAW_EMAIL = 'Sales@Example.com';
// The service stores maskEmail(normalizeEmail(email)). AuditLogService (mocked here) runs
// maskSensitiveFields over meta, which re-masks the `email` key; maskEmail is idempotent, so the
// stored value matches this one.
const MASKED_EMAIL = 's•••@example.com';

const bcryptMock = jest.mocked(bcrypt);

function fakeUser(): User {
  return Object.assign(new User(), {
    id: USER_ID,
    email: 'sales@example.com',
    fullName: 'Sam Sales',
    role: UserRole.SALES,
    passwordHash: FAKE_USER_HASH,
  });
}

async function setup(
  found: User | null,
  matches: boolean,
): Promise<{
  service: AuthService;
  record: jest.Mock;
  signAsync: jest.Mock;
}> {
  (bcryptMock.hash as jest.Mock).mockResolvedValue(FAKE_DUMMY_HASH);
  (bcryptMock.compare as jest.Mock).mockResolvedValue(matches);
  const usersRepository = {
    findByEmailWithPasswordHash: jest.fn().mockResolvedValue(found),
  } as unknown as UsersRepository;
  const record = jest.fn().mockResolvedValue(undefined);
  const signAsync = jest.fn().mockResolvedValue(FAKE_TOKEN);
  const service = new AuthService(
    usersRepository,
    { record } as unknown as AuditLogService,
    { signAsync } as unknown as JwtService,
  );
  await service.onModuleInit();
  return { service, record, signAsync };
}

function onlyAuditEntry(record: jest.Mock): AuditEntry {
  expect(record).toHaveBeenCalledTimes(1);
  const [entry] = record.mock.calls[0] as [AuditEntry];
  return entry;
}

function expectNoSecrets(entry: AuditEntry): void {
  const json = JSON.stringify(entry);
  expect(json).not.toContain(FAKE_PASSWORD);
  expect(json).not.toContain(FAKE_USER_HASH);
  expect(json).not.toContain(FAKE_DUMMY_HASH);
  expect(json.toLowerCase()).not.toContain('sales@example.com');
}

describe('AuthService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('onModuleInit hashes a random dummy value with BCRYPT_COST', async () => {
    await setup(null, false);

    expect(bcryptMock.hash).toHaveBeenCalledTimes(1);
    expect(bcryptMock.hash).toHaveBeenCalledWith(expect.any(String), BCRYPT_COST);
  });

  describe('login success', () => {
    it('returns the signed token and expiresIn 3600', async () => {
      const { service } = await setup(fakeUser(), true);

      await expect(service.login(RAW_EMAIL, FAKE_PASSWORD)).resolves.toEqual({
        accessToken: FAKE_TOKEN,
        expiresIn: 3600,
      });
      expect(bcryptMock.compare).toHaveBeenCalledWith(FAKE_PASSWORD, FAKE_USER_HASH);
    });

    it('signs exactly { sub, role }', async () => {
      const { service, signAsync } = await setup(fakeUser(), true);

      await service.login(RAW_EMAIL, FAKE_PASSWORD);

      expect(signAsync).toHaveBeenCalledTimes(1);
      expect(signAsync.mock.calls[0]).toEqual([{ sub: USER_ID, role: UserRole.SALES }]);
    });

    it('audits LOGIN_SUCCEEDED with the user as actor and entity and the email masked', async () => {
      const { service, record } = await setup(fakeUser(), true);

      await service.login(RAW_EMAIL, FAKE_PASSWORD);

      const entry = onlyAuditEntry(record);
      expect(entry).toEqual({
        actorType: AuditActorType.USER,
        actorId: USER_ID,
        actorRole: UserRole.SALES,
        action: AuditAction.LOGIN_SUCCEEDED,
        entityType: 'user',
        entityId: USER_ID,
        meta: { email: MASKED_EMAIL },
      });
      expectNoSecrets(entry);
    });
  });

  describe('denied: unknown email', () => {
    it('throws Invalid credentials after one compare against the dummy hash', async () => {
      const { service, signAsync } = await setup(null, false);

      const error: unknown = await service
        .login('nobody@example.com', FAKE_PASSWORD)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe('Invalid credentials');
      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(bcryptMock.compare).toHaveBeenCalledWith(FAKE_PASSWORD, FAKE_DUMMY_HASH);
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('audits LOGIN_FAILED with no actor, no entity and the email masked', async () => {
      const { service, record } = await setup(null, false);

      await expect(service.login('Nobody@Example.com', FAKE_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );

      const entry = onlyAuditEntry(record);
      expect(entry).toEqual({
        actorType: AuditActorType.USER,
        actorId: null,
        actorRole: null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        entityId: null,
        meta: { email: 'n•••@example.com' },
      });
      expectNoSecrets(entry);
      expect(JSON.stringify(entry).toLowerCase()).not.toContain('nobody@example.com');
    });
  });

  describe('denied: wrong password', () => {
    it('throws the same Invalid credentials and audits LOGIN_FAILED naming the user', async () => {
      const { service, record, signAsync } = await setup(fakeUser(), false);

      const error: unknown = await service
        .login(RAW_EMAIL, FAKE_PASSWORD)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe('Invalid credentials');
      expect(bcryptMock.compare).toHaveBeenCalledTimes(1);
      expect(signAsync).not.toHaveBeenCalled();

      const entry = onlyAuditEntry(record);
      expect(entry).toEqual({
        actorType: AuditActorType.USER,
        actorId: null,
        actorRole: null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        entityId: USER_ID,
        meta: { email: MASKED_EMAIL },
      });
      expectNoSecrets(entry);
    });
  });
});
