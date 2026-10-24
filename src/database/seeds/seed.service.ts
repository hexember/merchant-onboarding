import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../../common/common.enums';
import { UsersRepository } from '../../users/users.repository';

export interface SeedUser {
  email: string;
  fullName: string;
  role: UserRole;
  // Name of the env variable that holds this user's password. The password is never in code.
  passwordEnv: string;
}

// One fake user per role (fake data only).
export const SEED_USERS: readonly SeedUser[] = [
  {
    email: 'admin@example.com',
    fullName: 'Alex Admin',
    role: UserRole.ADMIN,
    passwordEnv: 'SEED_ADMIN_PASSWORD',
  },
  {
    email: 'reviewer@example.com',
    fullName: 'Riley Reviewer',
    role: UserRole.REVIEWER,
    passwordEnv: 'SEED_REVIEWER_PASSWORD',
  },
  {
    email: 'sales@example.com',
    fullName: 'Sam Sales',
    role: UserRole.SALES,
    passwordEnv: 'SEED_SALES_PASSWORD',
  },
];

export const BCRYPT_COST = 12;

export interface SeedResult {
  inserted: number;
  skipped: number;
}

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Inserts every seed user whose email does not exist yet. Existing users are skipped, and
   * their hash and name are left as they are. Fails before any write if a password is missing.
   */
  async run(): Promise<SeedResult> {
    const passwords = this.readPasswords();
    let inserted = 0;
    let skipped = 0;
    for (const user of SEED_USERS) {
      const password = passwords.get(user.passwordEnv) ?? '';
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const created = await this.usersRepository.insertIfAbsent({
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        passwordHash,
      });
      if (created) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }
    this.logger.log(`Seed finished: ${inserted} inserted, ${skipped} skipped`);
    return { inserted, skipped };
  }

  // Error messages name the missing variables, never their values.
  private readPasswords(): Map<string, string> {
    const passwords = new Map<string, string>();
    const missing: string[] = [];
    for (const user of SEED_USERS) {
      const value = this.config.get<string>(user.passwordEnv);
      if (typeof value !== 'string' || value === '') {
        missing.push(user.passwordEnv);
      } else {
        passwords.set(user.passwordEnv, value);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Missing or empty seed password variables: ${missing.join(', ')}`);
    }
    return passwords;
  }
}
