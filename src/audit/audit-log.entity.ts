import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { UserRole } from '../common/user-role.enum';
import { AuditAction, AuditActorType } from './audit.enums';

// Append-only audit trail (docs/adrs/database.md §`audit_logs`). Rows are only ever inserted,
// through AuditLogService; a database trigger rejects UPDATE and DELETE.
@Entity('audit_logs')
@Index('IDX_audit_logs_entity', ['entityType', 'entityId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_audit_logs' })
  id!: string;

  @Column({ name: 'actor_type', type: 'enum', enum: AuditActorType, enumName: 'audit_actor_type' })
  actorType!: AuditActorType;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  // `enumName` reuses the `user_role` type created by the users migration.
  @Column({
    name: 'actor_role',
    type: 'enum',
    enum: UserRole,
    enumName: 'user_role',
    nullable: true,
  })
  actorRole!: UserRole | null;

  @Column({ name: 'actor_label', type: 'varchar', nullable: true })
  actorLabel!: string | null;

  @Column({ type: 'enum', enum: AuditAction, enumName: 'audit_action' })
  action!: AuditAction;

  @Column({ name: 'entity_type', type: 'varchar' })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  meta!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
