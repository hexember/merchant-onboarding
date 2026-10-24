import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { SEED_USERS, SeedService } from '../src/database/seeds/seed.service';
import { SeedModule } from '../src/database/seeds/seed.module';
import { resetTables } from './utils/test-db';

// Rows carry a digest of the hash, never the hash itself, so a failed assertion cannot print it.
interface UserRow {
  email: string;
  role: string;
  hash_digest: string;
}

// bcrypt cost 12 makes each run take a few seconds.
jest.setTimeout(60_000);

describe('SeedService (e2e)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let seedService: SeedService;
  let config: ConfigService;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [SeedModule] }).compile();
    dataSource = module.get(DataSource);
    seedService = module.get(SeedService);
    config = module.get(ConfigService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetTables(dataSource);
  });

  async function readUsers(): Promise<UserRow[]> {
    return dataSource.query(
      'SELECT email, role, md5(password_hash) AS hash_digest FROM users ORDER BY email',
    );
  }

  // Returns only a boolean, so no hash reaches Jest output.
  async function passwordMatches(email: string, password: string): Promise<boolean> {
    const rows: Array<{ password_hash: string }> = await dataSource.query(
      'SELECT password_hash FROM users WHERE email = $1',
      [email],
    );
    return bcrypt.compare(password, rows[0]?.password_hash ?? '');
  }

  it('inserts one user per role and is idempotent', async () => {
    await expect(seedService.run()).resolves.toEqual({ inserted: 3, skipped: 0 });
    const afterFirst = await readUsers();

    await expect(seedService.run()).resolves.toEqual({ inserted: 0, skipped: 3 });
    const afterSecond = await readUsers();

    expect(afterFirst).toHaveLength(3);
    expect(afterFirst.map((row) => row.role).sort()).toEqual(['ADMIN', 'REVIEWER', 'SALES']);
    expect(afterFirst.every((row) => row.email.endsWith('@example.com'))).toBe(true);
    // The second run skips existing users, so their hashes are untouched.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('hashes each password from env with bcrypt', async () => {
    await seedService.run();

    for (const seedUser of SEED_USERS) {
      const password = config.getOrThrow<string>(seedUser.passwordEnv);
      await expect(passwordMatches(seedUser.email, password)).resolves.toBe(true);
    }
  });
});
