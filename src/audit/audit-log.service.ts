import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryDeepPartialEntity } from 'typeorm';
import { maskSensitiveFields } from '../common/mask';
import { isPlainObject, redact } from '../common/redact';
import { UserRole } from '../common/user-role.enum';
import { AuditAction } from './audit-action.enum';
import { AuditActorType } from './audit-actor-type.enum';
import { AuditLog } from './audit-log.entity';

// Largest `meta` kept as-is, in bytes of UTF-8 JSON (docs/adrs/database.md §`meta` columns).
export const AUDIT_META_MAX_BYTES = 8192;

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  actorRole?: UserRole | null;
  actorLabel?: string | null;
  action: AuditAction;
  entityType: 'merchant_application' | 'user';
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

export class InvalidAuditEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuditEntryError';
  }
}

/**
 * Redacts, then masks `meta`. Both helpers copy every object (class instances such as entities
 * included) into a plain object, and circular references become a marker, so the result is then
 * turned into plain JSON. What is stored is exactly what was redacted, masked and measured.
 * A result larger than AUDIT_META_MAX_BYTES is replaced with a `{ truncated: true, originalBytes }`
 * marker, so the action itself still succeeds.
 */
export function buildAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitised: unknown = JSON.parse(JSON.stringify(maskSensitiveFields(redact(meta ?? {}))));
  const result = isPlainObject(sanitised) ? sanitised : {};
  const originalBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (originalBytes > AUDIT_META_MAX_BYTES) {
    return { truncated: true, originalBytes };
  }
  return result;
}

/**
 * Actor columns follow the ADR: SYSTEM rows carry only a component label; USER rows carry the
 * user's id and role and no label. A USER row with a null `actorId` is allowed for now
 * (failed login for an unknown email).
 */
export function assertValidAuditEntry(entry: AuditEntry): void {
  if (entry.actorType === AuditActorType.SYSTEM) {
    if (entry.actorId != null) {
      throw new InvalidAuditEntryError('SYSTEM audit entries must not have an actorId');
    }
    if (entry.actorRole != null) {
      throw new InvalidAuditEntryError('SYSTEM audit entries must not have an actorRole');
    }
    if (entry.actorLabel == null || entry.actorLabel === '') {
      throw new InvalidAuditEntryError('SYSTEM audit entries need an actorLabel');
    }
  } else if (entry.actorLabel != null) {
    throw new InvalidAuditEntryError('USER audit entries must not have an actorLabel');
  }
}

// Insert-only writer for audit_logs. There is deliberately no update, delete or save path.
@Injectable()
export class AuditLogService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Writes one audit row. Pass the transaction's `manager` so the row commits or rolls back
   * together with the change it describes.
   */
  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    assertValidAuditEntry(entry);
    const meta = buildAuditMeta(entry.meta);
    await (manager ?? this.dataSource.manager).insert(AuditLog, {
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      // TypeORM's partial type cannot express `unknown` jsonb values; the value is plain,
      // already-sanitised JSON, so the cast only satisfies the type checker.
      meta: meta as QueryDeepPartialEntity<AuditLog>['meta'],
    });
  }
}
