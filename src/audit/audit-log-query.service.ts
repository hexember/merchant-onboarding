import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MERCHANT_APPLICATION_ENTITY_TYPE } from './audit.enums';
import { AuditLog } from './audit-log.entity';

/**
 * Read-only access to `audit_logs`. The table is append-only: rows are written only through
 * `AuditLogService.record`, and this service has no insert, save, update or delete path.
 *
 * It does no authorization itself. Callers must pass an application id that the scoped
 * `ApplicationsRepository.findAccessible` returned.
 */
@Injectable()
export class AuditLogQueryService {
  constructor(@InjectRepository(AuditLog) private readonly repository: Repository<AuditLog>) {}

  /**
   * One page of an application's audit history, oldest first (`created_at ASC, id ASC`), plus
   * the total row count. The entity type is fixed to `merchant_application`, so no caller can
   * read `user` rows (LOGIN_*) or another entity's rows.
   *
   * `id` only breaks ties, so the order is deterministic but not causal: rows written in one
   * transaction share `created_at` (`now()` is the transaction start time). Today
   * `KybCheckProcessor.recordFinalFailure` writes KYB_CHECK_ATTEMPT_FAILED and KYB_CHECK_FAILED in
   * one transaction, so those two can come back in either order.
   *
   * The index `IDX_audit_logs_entity (entity_type, entity_id, created_at)` covers the filter and
   * the sort.
   */
  async findApplicationHistoryPage(
    applicationId: string,
    page: number,
    limit: number,
  ): Promise<{ items: AuditLog[]; total: number }> {
    const [items, total] = await this.repository.findAndCount({
      where: { entityType: MERCHANT_APPLICATION_ENTITY_TYPE, entityId: applicationId },
      order: { createdAt: 'ASC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }
}
