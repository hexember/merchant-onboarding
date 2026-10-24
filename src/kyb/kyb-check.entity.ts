import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { KYB_LEVEL_ENUM, KybLevel } from '../applications/application.enums';
import { MerchantApplication } from '../applications/merchant-application.entity';

// One stored KYB result per submission. Schema: docs/adrs/database.md §`kyb_checks`.
// `UNIQUE (application_id, submission_no)` is the final idempotency guard
// (docs/adrs/kyb-check.md): a second result for the same submission cannot be stored.
// Only the KYB worker writes rows; they are never returned by the API.
@Entity('kyb_checks')
@Unique('UQ_kyb_checks_application_submission', ['applicationId', 'submissionNo'])
@Check('CHK_kyb_checks_score_range', '"score" >= 0 AND "score" <= 100')
export class KybCheck {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_kyb_checks' })
  id!: string;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId!: string;

  // Exists only so the schema (and the migration) gets the FK. Never loaded.
  @ManyToOne(() => MerchantApplication, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'FK_kyb_checks_application' })
  application?: MerchantApplication;

  // The application's `submission_count` this check belongs to.
  @Column({ name: 'submission_no', type: 'int' })
  submissionNo!: number;

  @Column({ name: 'provider_reference', type: 'varchar', length: 100 })
  providerReference!: string;

  // 0..100 (CHK_kyb_checks_score_range); a higher score means a higher risk.
  @Column({ type: 'smallint' })
  score!: number;

  // Reuses the `kyb_level` type created by CreateMerchantApplications1792800000002.
  @Column({ type: 'enum', enum: KybLevel, enumName: KYB_LEVEL_ENUM })
  level!: KybLevel;

  // Reason codes such as 'HIGH_RISK_MCC'; never PII.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  reasons!: string[];

  // Server-written fixed fields only (providerVersion, latencyMs, attempt), passed through
  // buildAuditMeta (docs/adrs/database.md §`meta` columns). Never returned.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  meta!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
