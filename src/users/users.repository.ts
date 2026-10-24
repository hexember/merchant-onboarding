import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../common/user-role.enum';
import { normalizeEmail } from './normalize-email';
import { User } from './user.entity';

export interface NewUser {
  email: string;
  fullName: string;
  role: UserRole;
  passwordHash: string;
}

// Only the lookups the seed needs. There is deliberately no find-by-id; later tasks add
// what they need.
@Injectable()
export class UsersRepository {
  constructor(@InjectRepository(User) private readonly repository: Repository<User>) {}

  /** Looks a user up by email (normalised first). `passwordHash` is not selected. */
  findByEmail(email: string): Promise<User | null> {
    return this.repository.findOne({ where: { email: normalizeEmail(email) } });
  }

  /**
   * Inserts the user unless the email already exists (`ON CONFLICT DO NOTHING`).
   * Returns true when a row was inserted: Postgres returns the `RETURNING` row only then.
   */
  async insertIfAbsent(input: NewUser): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({
        email: normalizeEmail(input.email),
        fullName: input.fullName,
        role: input.role,
        passwordHash: input.passwordHash,
      })
      .orIgnore()
      .returning('id')
      .execute();
    const raw: unknown = result.raw;
    return Array.isArray(raw) && raw.length > 0;
  }
}
