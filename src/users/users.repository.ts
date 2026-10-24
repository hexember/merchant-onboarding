import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { UserRole } from '../common/common.enums';
import { normalizeEmail } from './normalize-email';
import { User } from './user.entity';

export interface NewUser {
  email: string;
  fullName: string;
  role: UserRole;
  passwordHash: string;
}

/** The only user fields the auth guard needs on each request. */
export type AuthUserRow = Pick<User, 'id' | 'role'>;

// Only the lookups the seed, auth and the target-role check need: email lookups for the seed and
// login, `findAuthUserById` for the auth guard, and `existsWithRole` for checking the role of a
// target user an ADMIN names. There is still no general find-by-id: neither id lookup returns
// another user's data to a caller. Later tasks add what they need.
@Injectable()
export class UsersRepository {
  constructor(@InjectRepository(User) private readonly repository: Repository<User>) {}

  /** Looks a user up by email (normalised first). `passwordHash` is not selected. */
  findByEmail(email: string): Promise<User | null> {
    return this.repository.findOne({ where: { email: normalizeEmail(email) } });
  }

  /**
   * Looks a user up by email (normalised first) and also selects `passwordHash`, which is
   * `select: false` everywhere else. For login only: never return its result from an endpoint.
   */
  findByEmailWithPasswordHash(email: string): Promise<User | null> {
    return this.repository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: normalizeEmail(email) })
      .getOne();
  }

  /**
   * AUTH ONLY: re-reads the caller's own user row by the token's `sub`, selecting only `id` and
   * `role` (primary-key lookup). `JwtAuthGuard` calls it on every authenticated request so that a
   * deleted user or a changed role takes effect immediately. It is not an application lookup:
   * never use it to load another user for a request, and never return its result from an
   * endpoint. Returns null when no row matches, or when `id` is not a UUID (Postgres would
   * otherwise reject the query with an error).
   */
  async findAuthUserById(id: string): Promise<AuthUserRow | null> {
    if (!isUUID(id)) {
      return null;
    }
    const row = await this.repository
      .createQueryBuilder('user')
      .select(['user.id', 'user.role'])
      .where('user.id = :id', { id })
      .getOne();
    return row === null ? null : { id: row.id, role: row.role };
  }

  /**
   * Target-role check: true when a user with this id has this role. Used for an ADMIN's
   * `salesOwnerId` on create (later also transfer/assign). Selects nothing sensitive and never
   * returns user data to a caller. Returns false without querying when `id` is not a UUID
   * (Postgres would otherwise reject the query with an error).
   */
  existsWithRole(id: string, role: UserRole): Promise<boolean> {
    if (!isUUID(id)) {
      return Promise.resolve(false);
    }
    return this.repository.exists({ where: { id, role } });
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
