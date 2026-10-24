import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/common.enums';
import { UsersRepository } from '../src/users/users.repository';
import { resetTables } from './utils/test-db';

// Not a real bcrypt hash; the column only stores what it is given.
const HASH_SENTINEL = 'hash-sentinel';

async function sqlStateOf(promise: Promise<unknown>): Promise<unknown> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return (error as { code?: unknown } | undefined)?.code;
}

describe('Database schema (e2e)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let usersRepository: UsersRepository;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    dataSource = module.get(DataSource);
    usersRepository = module.get(UsersRepository);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetTables(dataSource);
  });

  it('has no pending migrations', async () => {
    await expect(dataSource.showMigrations()).resolves.toBe(false);
  });

  it('matches the entities (no schema diff)', async () => {
    const sql = await dataSource.driver.createSchemaBuilder().log();

    expect(sql.upQueries.map((query) => query.query)).toEqual([]);
  });

  it('defines user_role as exactly ADMIN, REVIEWER, SALES', async () => {
    const rows: Array<{ label: string }> = await dataSource.query(
      `SELECT unnest(enum_range(NULL::user_role))::text AS label`,
    );

    expect(rows.map((row) => row.label)).toEqual(['ADMIN', 'REVIEWER', 'SALES']);
  });

  it('stores emails lowercased through the repository', async () => {
    await usersRepository.insertIfAbsent({
      email: 'Mixed@Example.com',
      fullName: 'Morgan Example',
      role: UserRole.SALES,
      passwordHash: HASH_SENTINEL,
    });

    const rows: Array<{ email: string }> = await dataSource.query('SELECT email FROM users');
    expect(rows).toEqual([{ email: 'mixed@example.com' }]);
  });

  it('rejects an uppercase email written by raw SQL (check constraint)', async () => {
    const insert = dataSource.query(
      `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, 'SALES')`,
      ['Upper@Example.com', HASH_SENTINEL, 'Morgan Example'],
    );

    await expect(sqlStateOf(insert)).resolves.toBe('23514');
  });

  it('rejects a duplicate email (unique index)', async () => {
    const insertSql = `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, 'SALES')`;
    const params = ['dup@example.com', HASH_SENTINEL, 'Morgan Example'];
    await dataSource.query(insertSql, params);

    await expect(sqlStateOf(dataSource.query(insertSql, params))).resolves.toBe('23505');
  });

  it('findByEmail does not select passwordHash', async () => {
    await usersRepository.insertIfAbsent({
      email: 'hidden@example.com',
      fullName: 'Morgan Example',
      role: UserRole.REVIEWER,
      passwordHash: HASH_SENTINEL,
    });

    const user = await usersRepository.findByEmail('Hidden@Example.com');

    expect(user).not.toBeNull();
    expect(user?.email).toBe('hidden@example.com');
    // ES2022 class fields exist as own properties, so check the value, not the key.
    expect(user?.passwordHash).toBeUndefined();
  });
});
