import { Repository } from 'typeorm';
import { UserRole } from '../common/common.enums';
import { User } from './user.entity';
import { UsersRepository } from './users.repository';

// Non-secret sentinel: the repository only passes the hash through.
const HASH_SENTINEL = 'hash-sentinel';

function createQueryBuilderMock(raw: unknown): {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
} {
  const qb = {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    returning: jest.fn(),
    execute: jest.fn().mockResolvedValue({ raw, identifiers: [], generatedMaps: [] }),
  };
  qb.insert.mockReturnValue(qb);
  qb.into.mockReturnValue(qb);
  qb.values.mockReturnValue(qb);
  qb.orIgnore.mockReturnValue(qb);
  qb.returning.mockReturnValue(qb);
  return qb;
}

function createSelectQueryBuilderMock(found: User | null): {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  getOne: jest.Mock;
} {
  const qb = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    getOne: jest.fn().mockResolvedValue(found),
  };
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  return qb;
}

function setup(raw: unknown = []): {
  usersRepository: UsersRepository;
  findOne: jest.Mock;
  qb: ReturnType<typeof createQueryBuilderMock>;
} {
  const qb = createQueryBuilderMock(raw);
  const findOne = jest.fn().mockResolvedValue(null);
  const repository = {
    findOne,
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<User>;
  return { usersRepository: new UsersRepository(repository), findOne, qb };
}

function setupSelect(found: User | null): {
  usersRepository: UsersRepository;
  createQueryBuilder: jest.Mock;
  qb: ReturnType<typeof createSelectQueryBuilderMock>;
} {
  const qb = createSelectQueryBuilderMock(found);
  const createQueryBuilder = jest.fn().mockReturnValue(qb);
  const repository = { createQueryBuilder } as unknown as Repository<User>;
  return { usersRepository: new UsersRepository(repository), createQueryBuilder, qb };
}

const newUser = {
  email: ' Mixed@Example.com ',
  fullName: 'Morgan Example',
  role: UserRole.SALES,
  passwordHash: HASH_SENTINEL,
};

describe('UsersRepository', () => {
  it('findByEmail queries with the normalised email', async () => {
    const { usersRepository, findOne } = setup();

    await usersRepository.findByEmail(' Admin@Example.COM ');

    expect(findOne).toHaveBeenCalledWith({ where: { email: 'admin@example.com' } });
  });

  it('insertIfAbsent builds an insert with orIgnore and returning id', async () => {
    const { usersRepository, qb } = setup();

    await usersRepository.insertIfAbsent(newUser);

    expect(qb.into).toHaveBeenCalledWith(User);
    expect(qb.values).toHaveBeenCalledWith({
      email: 'mixed@example.com',
      fullName: 'Morgan Example',
      role: UserRole.SALES,
      passwordHash: HASH_SENTINEL,
    });
    expect(qb.orIgnore).toHaveBeenCalled();
    expect(qb.returning).toHaveBeenCalledWith('id');
  });

  it('insertIfAbsent returns true when a row was returned', async () => {
    const { usersRepository } = setup([{ id: '00000000-0000-0000-0000-000000000001' }]);

    await expect(usersRepository.insertIfAbsent(newUser)).resolves.toBe(true);
  });

  it('insertIfAbsent returns false when the email already existed', async () => {
    const { usersRepository } = setup([]);

    await expect(usersRepository.insertIfAbsent(newUser)).resolves.toBe(false);
  });

  it('findByEmailWithPasswordHash normalises the email and selects passwordHash', async () => {
    const found = Object.assign(new User(), {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'sales@example.com',
      passwordHash: HASH_SENTINEL,
    });
    const { usersRepository, createQueryBuilder, qb } = setupSelect(found);

    await expect(usersRepository.findByEmailWithPasswordHash(' Sales@Example.COM ')).resolves.toBe(
      found,
    );

    expect(createQueryBuilder).toHaveBeenCalledWith('user');
    expect(qb.addSelect).toHaveBeenCalledWith('user.passwordHash');
    expect(qb.where).toHaveBeenCalledWith('user.email = :email', { email: 'sales@example.com' });
  });

  it('findByEmailWithPasswordHash returns null when no user matches', async () => {
    const { usersRepository } = setupSelect(null);

    await expect(
      usersRepository.findByEmailWithPasswordHash('nobody@example.com'),
    ).resolves.toBeNull();
  });

  describe('findAuthUserById', () => {
    const USER_ID = '00000000-0000-4000-8000-000000000003';

    it('selects only id and role by primary key and returns just those fields', async () => {
      const found = Object.assign(new User(), {
        id: USER_ID,
        email: 'admin@example.com',
        fullName: 'Alex Admin',
        role: UserRole.ADMIN,
      });
      const { usersRepository, createQueryBuilder, qb } = setupSelect(found);

      await expect(usersRepository.findAuthUserById(USER_ID)).resolves.toEqual({
        id: USER_ID,
        role: UserRole.ADMIN,
      });

      expect(createQueryBuilder).toHaveBeenCalledWith('user');
      expect(qb.select).toHaveBeenCalledWith(['user.id', 'user.role']);
      expect(qb.addSelect).not.toHaveBeenCalled();
      expect(qb.where).toHaveBeenCalledWith('user.id = :id', { id: USER_ID });
    });

    it('returns null when no user matches', async () => {
      const { usersRepository } = setupSelect(null);

      await expect(usersRepository.findAuthUserById(USER_ID)).resolves.toBeNull();
    });

    it('returns null for a non-UUID id without querying', async () => {
      const { usersRepository, createQueryBuilder } = setupSelect(null);

      await expect(usersRepository.findAuthUserById('not-a-uuid')).resolves.toBeNull();
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });
  });
  describe('existsWithRole', () => {
    const USER_ID = '00000000-0000-4000-8000-000000000004';

    function setupExists(result: boolean): {
      usersRepository: UsersRepository;
      exists: jest.Mock;
    } {
      const exists = jest.fn().mockResolvedValue(result);
      const repository = { exists } as unknown as Repository<User>;
      return { usersRepository: new UsersRepository(repository), exists };
    }

    it('returns false for a non-UUID id without querying', async () => {
      const { usersRepository, exists } = setupExists(true);

      await expect(usersRepository.existsWithRole('not-a-uuid', UserRole.SALES)).resolves.toBe(
        false,
      );
      expect(exists).not.toHaveBeenCalled();
    });

    it.each([true, false])('checks id and role with exists and returns %s', async (result) => {
      const { usersRepository, exists } = setupExists(result);

      await expect(usersRepository.existsWithRole(USER_ID, UserRole.SALES)).resolves.toBe(result);
      expect(exists).toHaveBeenCalledTimes(1);
      expect(exists).toHaveBeenCalledWith({ where: { id: USER_ID, role: UserRole.SALES } });
    });
  });
});
