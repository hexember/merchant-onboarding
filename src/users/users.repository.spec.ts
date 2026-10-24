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
});
