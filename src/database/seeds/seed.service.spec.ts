import { ConfigService } from '@nestjs/config';
import { UsersRepository } from '../../users/users.repository';
import { SeedService } from './seed.service';

jest.mock('bcrypt');

const SEED_VARS = ['SEED_ADMIN_PASSWORD', 'SEED_REVIEWER_PASSWORD', 'SEED_SALES_PASSWORD'];

// Builds a ConfigService mock from a map of variable name → value. No password literals:
// the values used here are not credentials for anything, and only their presence matters.
function setup(values: Record<string, string | undefined>): {
  service: SeedService;
  insertIfAbsent: jest.Mock;
} {
  const config = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  const insertIfAbsent = jest.fn().mockResolvedValue(true);
  const usersRepository = { insertIfAbsent } as unknown as UsersRepository;
  return { service: new SeedService(config, usersRepository), insertIfAbsent };
}

function allSet(): Record<string, string> {
  return Object.fromEntries(SEED_VARS.map((name) => [name, `value-of-${name}`]));
}

describe('SeedService.run', () => {
  it('throws naming the one missing variable and writes nothing', async () => {
    const values: Record<string, string | undefined> = allSet();
    values.SEED_REVIEWER_PASSWORD = undefined;
    const { service, insertIfAbsent } = setup(values);

    await expect(service.run()).rejects.toThrow('SEED_REVIEWER_PASSWORD');
    expect(insertIfAbsent).not.toHaveBeenCalled();
  });

  it('treats an empty string as missing', async () => {
    const { service, insertIfAbsent } = setup({ ...allSet(), SEED_SALES_PASSWORD: '' });

    await expect(service.run()).rejects.toThrow('SEED_SALES_PASSWORD');
    expect(insertIfAbsent).not.toHaveBeenCalled();
  });

  it('names all three variables in one error when all are missing', async () => {
    const { service, insertIfAbsent } = setup({});

    const error: unknown = await service.run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    for (const name of SEED_VARS) {
      expect((error as Error).message).toContain(name);
    }
    expect(insertIfAbsent).not.toHaveBeenCalled();
  });
});
