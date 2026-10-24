import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../common/common.enums';
import { KYB_WORKER_LABEL } from '../../kyb/kyb-job';
import { AuditAction, AuditActorType } from '../audit.enums';
import { AuditLog } from '../audit-log.entity';
import { buildAuditMeta } from '../audit-log.service';

// `actor_label` values the API may return. Only SYSTEM rows carry a label, and only labels written
// by known server code are returned; anything else (a seed, a manual SQL fix) comes back as null.
export const KNOWN_SYSTEM_ACTOR_LABELS: ReadonlySet<string> = new Set([KYB_WORKER_LABEL]);

/**
 * One audit row as returned by the ADMIN audit-log endpoint. An explicit allow-list:
 * `entityType` and `entityId` are left out because the path already names the application.
 */
export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: AuditAction })
  action!: AuditAction;

  @ApiProperty({ enum: AuditActorType })
  actorType!: AuditActorType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId!: string | null;

  @ApiProperty({ enum: UserRole, nullable: true })
  actorRole!: UserRole | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'kyb-worker',
    description: 'Known SYSTEM actor label; null for USER rows and unknown labels',
  })
  actorLabel!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Server-written context; redacted and masked',
    example: { from: 'DRAFT', to: 'RISK_REVIEW', submissionNo: 1 },
  })
  meta!: Record<string, unknown>;
}

/**
 * `GET /applications/:id/audit-logs` response: one page, oldest first. Same shape as the
 * applications list response, copied rather than imported so src/audit never imports from
 * src/applications.
 */
export class AuditLogListResponseDto {
  @ApiProperty({ type: [AuditLogResponseDto] })
  items!: AuditLogResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 1, description: 'Audit rows of this application across all pages' })
  total!: number;
}

/**
 * Builds the response field by field (never a spread of the entity), so a new column is never
 * returned by accident. `meta` was sanitised at write time, but it goes through `buildAuditMeta`
 * (redact, mask, plain JSON, 8 KB cap) again on read because:
 * (a) a row written by a path that skipped `record()` (a seed, a manual SQL fix, a future bug) is
 *     still masked;
 * (b) a key added later to the redact denylist or the maskers also covers older rows;
 * (c) this is the only API that returns `meta`, so the response is a trust boundary of its own.
 * Redaction and masking match key names by substring (`oldTaxId`, `national_id`,
 * `ownerPhoneNumber`, `jwt`, `credentials`, ...), and any string value shaped like a bearer header
 * or a JWT is redacted under any key.
 * The pipeline maps the values `record()` normally stores to themselves, except a bare `MASK`
 * (stored for an input of 4 characters or fewer): it is longer than 4 characters, so it comes
 * back as `MASK + '••••'`. That still reveals nothing.
 * `actorLabel` is returned only for a SYSTEM row whose label is in `KNOWN_SYSTEM_ACTOR_LABELS`;
 * otherwise it is null, so free text in that column never reaches the response.
 */
export function toAuditLogResponse(row: AuditLog): AuditLogResponseDto {
  return {
    id: row.id,
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    actorRole: row.actorRole,
    actorLabel: toActorLabel(row),
    createdAt: row.createdAt,
    meta: buildAuditMeta(row.meta),
  };
}

function toActorLabel(row: AuditLog): string | null {
  if (row.actorType !== AuditActorType.SYSTEM || row.actorLabel === null) {
    return null;
  }
  return KNOWN_SYSTEM_ACTOR_LABELS.has(row.actorLabel) ? row.actorLabel : null;
}
