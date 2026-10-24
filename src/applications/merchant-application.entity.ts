import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
  VersionColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import {
  APPLICATION_STATUS_ENUM,
  ApplicationStatus,
  BUSINESS_TYPE_ENUM,
  BusinessType,
  KYB_LEVEL_ENUM,
  KYB_STATUS_ENUM,
  KybLevel,
  KybStatus,
} from './application.enums';

/**
 * Maps a Postgres `bigint` (returned by the driver as a string) to a JS number. The DTOs cap
 * money input at `Number.MAX_SAFE_INTEGER`, so the round trip is exact.
 */
export const bigintNumberTransformer: ValueTransformer = {
  to: (value: number): number => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
};

// Schema: docs/adrs/database.md §`merchant_applications`.
// The two `created_at DESC` indexes cannot be expressed with `@Index`, so they are declared by
// name with `synchronize: false` (TypeORM's overload for hand-made indexes takes no columns) and
// created by hand in the migration; the schema builder ignores them:
//   IDX_merchant_applications_sales_owner_created: (sales_owner_id, created_at DESC)
//   IDX_merchant_applications_status_created:      (status, created_at DESC)
@Entity('merchant_applications')
@Index('IDX_merchant_applications_reviewer_status', ['assignedReviewerId', 'status'])
@Index('IDX_merchant_applications_sales_owner_created', { synchronize: false })
@Index('IDX_merchant_applications_status_created', { synchronize: false })
export class MerchantApplication {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_merchant_applications' })
  id!: string;

  // Who created the row (SALES or ADMIN). Immutable, history only.
  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById!: string;

  // The SALES user who owns the application; drives SALES access.
  @Column({ name: 'sales_owner_id', type: 'uuid' })
  salesOwnerId!: string;

  @Column({ name: 'assigned_reviewer_id', type: 'uuid', nullable: true })
  assignedReviewerId!: string | null;

  // The relation properties below exist only so the schema (and the migration) gets the FKs.
  // They are never loaded (no `eager`, no `relations`).
  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_merchant_applications_created_by',
  })
  createdBy?: User;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'sales_owner_id',
    foreignKeyConstraintName: 'FK_merchant_applications_sales_owner',
  })
  salesOwner?: User;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'assigned_reviewer_id',
    foreignKeyConstraintName: 'FK_merchant_applications_assigned_reviewer',
  })
  assignedReviewer?: User | null;

  @Column({ name: 'business_name', type: 'varchar', length: 200 })
  businessName!: string;

  @Column({ name: 'legal_business_name', type: 'varchar', length: 200 })
  legalBusinessName!: string;

  @Column({ name: 'business_type', type: 'enum', enum: BusinessType, enumName: BUSINESS_TYPE_ENUM })
  businessType!: BusinessType;

  @Column({ name: 'registration_number', type: 'varchar', length: 50 })
  registrationNumber!: string;

  // Sensitive (PAN/VAT): masked in responses, never logged.
  @Column({ name: 'tax_id', type: 'varchar', length: 50 })
  taxId!: string;

  @Column({ name: 'owner_full_name', type: 'varchar', length: 200 })
  ownerFullName!: string;

  @Column({ name: 'owner_email', type: 'varchar', length: 254 })
  ownerEmail!: string;

  @Column({ name: 'owner_phone', type: 'varchar', length: 30 })
  ownerPhone!: string;

  // Sensitive: masked in responses, never logged.
  @Column({ name: 'owner_national_id', type: 'varchar', length: 50 })
  ownerNationalId!: string;

  @Column({ name: 'merchant_category_code', type: 'char', length: 4 })
  merchantCategoryCode!: string;

  @Column({ name: 'website_url', type: 'varchar', length: 500, nullable: true })
  websiteUrl!: string | null;

  // Money in minor units (paisa).
  @Column({
    name: 'expected_monthly_volume_minor',
    type: 'bigint',
    transformer: bigintNumberTransformer,
  })
  expectedMonthlyVolumeMinor!: number;

  @Column({
    name: 'average_ticket_size_minor',
    type: 'bigint',
    transformer: bigintNumberTransformer,
  })
  averageTicketSizeMinor!: number;

  @Column({ type: 'char', length: 3, default: 'NPR' })
  currency!: string;

  // No database default: the service sets DRAFT on create.
  @Column({ type: 'enum', enum: ApplicationStatus, enumName: APPLICATION_STATUS_ENUM })
  status!: ApplicationStatus;

  @Column({ name: 'kyb_status', type: 'enum', enum: KybStatus, enumName: KYB_STATUS_ENUM })
  kybStatus!: KybStatus;

  @Column({
    name: 'kyb_level',
    type: 'enum',
    enum: KybLevel,
    enumName: KYB_LEVEL_ENUM,
    nullable: true,
  })
  kybLevel!: KybLevel | null;

  @Column({ name: 'kyb_score', type: 'smallint', nullable: true })
  kybScore!: number | null;

  @Column({ name: 'kyb_attempts', type: 'smallint', default: 0 })
  kybAttempts!: number;

  @Column({ name: 'kyb_last_attempt_at', type: 'timestamptz', nullable: true })
  kybLastAttemptAt!: Date | null;

  @Column({ name: 'submission_count', type: 'int', default: 0 })
  submissionCount!: number;

  @Column({ name: 'decision_note', type: 'text', nullable: true })
  decisionNote!: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  // Optimistic lock. Never settable by a client and never returned.
  @VersionColumn({ type: 'int' })
  version!: number;

  // Server-written context only (docs/adrs/database.md §`meta` columns). Never returned.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  meta!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
