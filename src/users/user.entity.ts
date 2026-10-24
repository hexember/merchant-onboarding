import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../common/user-role.enum';
import { normalizeEmail } from './normalize-email';

// Schema: docs/adrs/database.md §users. Only seeded fake users exist.
@Entity('users')
@Check('CHK_users_email_lowercase', '"email" = lower("email")')
export class User {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_users' })
  id!: string;

  // Stored lowercased; the CHECK constraint rejects anything else written by raw SQL.
  @Column({
    type: 'varchar',
    transformer: { to: normalizeEmail, from: (value: string): string => value },
  })
  @Index('UQ_users_email', { unique: true })
  email!: string;

  // bcrypt hash. Never selected unless a query asks for it explicitly.
  @Column({ name: 'password_hash', type: 'varchar', select: false })
  passwordHash!: string;

  @Column({ name: 'full_name', type: 'varchar' })
  fullName!: string;

  @Column({ type: 'enum', enum: UserRole, enumName: 'user_role' })
  role!: UserRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
