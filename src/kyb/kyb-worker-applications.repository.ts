import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, Repository, UpdateQueryBuilder } from 'typeorm';
import { ApplicationStatus, KybLevel, KybStatus } from '../applications/application.enums';
import { nextSystemStatus, TransitionAction } from '../applications/application-state-machine';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { KybCheck } from './kyb-check.entity';

/** The only application columns the worker reads. No PII column is loaded. */
export type KybWorkerApplication = Pick<
  MerchantApplication,
  | 'id'
  | 'status'
  | 'submissionCount'
  | 'merchantCategoryCode'
  | 'businessType'
  | 'expectedMonthlyVolumeMinor'
  | 'averageTicketSizeMinor'
>;

/** Every column the worker sets when it stores a KYB result. */
export type NewKybCheck = Pick<
  KybCheck,
  'applicationId' | 'submissionNo' | 'providerReference' | 'score' | 'level' | 'reasons' | 'meta'
>;

// The worker's select list, as property paths on alias `app`.
const WORKER_SELECT: readonly string[] = [
  'app.id',
  'app.status',
  'app.submissionCount',
  'app.merchantCategoryCode',
  'app.businessType',
  'app.expectedMonthlyVolumeMinor',
  'app.averageTicketSizeMinor',
];

// docs/adrs/kyb-check.md, step 4: a second result for the same submission is silently dropped.
const INSERT_KYB_CHECK_SQL =
  'INSERT INTO "kyb_checks" ("application_id","submission_no","provider_reference","score","level","reasons","meta") ' +
  'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ' +
  'ON CONFLICT ("application_id","submission_no") DO NOTHING RETURNING "id"';

/**
 * Worker-only data access for the KYB check (actor_type SYSTEM, docs/adrs/kyb-check.md). It is
 * never reachable from a request: it takes no `AuthUser`, it does not use `applyScope`,
 * `KybModule` does not export it, and only `KybCheckProcessor` injects it. Request paths must use
 * `ApplicationsRepository`.
 *
 * Every write is guarded by `id`, `submission_count = :submissionNo` and
 * `status = 'RISK_REVIEW'`, so a stale job (resubmitted or already moved on) changes nothing. Every
 * write bumps `version` and `updated_at` explicitly (the same convention as
 * `ApplicationsRepository`).
 */
@Injectable()
export class KybWorkerApplicationsRepository {
  constructor(
    @InjectRepository(MerchantApplication)
    private readonly repository: Repository<MerchantApplication>,
    @InjectRepository(KybCheck)
    private readonly kybChecks: Repository<KybCheck>,
  ) {}

  /**
   * The non-PII fields the worker needs, or `null` when the application does not exist. Returns
   * `null` without querying when the id is not a UUID.
   */
  async findForWorker(applicationId: string): Promise<KybWorkerApplication | null> {
    if (!isUUID(applicationId)) {
      return null;
    }
    const row = await this.repository
      .createQueryBuilder('app')
      .select([...WORKER_SELECT])
      .where('app.id = :id', { id: applicationId })
      .getOne();
    return row ?? null;
  }

  /** True when a KYB result is already stored for this submission. */
  kybCheckExists(applicationId: string, submissionNo: number): Promise<boolean> {
    return this.kybChecks.exists({ where: { applicationId, submissionNo } });
  }

  /**
   * Counts one attempt (`kyb_attempts + 1`, `kyb_last_attempt_at = now()`) before the provider
   * call. Returns false when the guard matched no row (the job became stale).
   */
  async recordAttemptIfCurrent(applicationId: string, submissionNo: number): Promise<boolean> {
    const query = this.repository.manager
      .createQueryBuilder()
      .update<MerchantApplication>(MerchantApplication)
      .set({
        kybAttempts: () => 'kyb_attempts + 1',
        kybLastAttemptAt: () => 'now()',
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      });
    const result = await this.applyGuard(query, applicationId, submissionNo).execute();
    return result.affected === 1;
  }

  /**
   * Stores the result inside the caller's transaction. Returns false when a result for
   * `(application_id, submission_no)` already exists (the unique constraint, final guard).
   */
  async insertKybCheckIfAbsent(values: NewKybCheck, manager: EntityManager): Promise<boolean> {
    const rows: unknown = await manager.query(INSERT_KYB_CHECK_SQL, [
      values.applicationId,
      values.submissionNo,
      values.providerReference,
      values.score,
      values.level,
      JSON.stringify(values.reasons),
      JSON.stringify(values.meta),
    ]);
    return Array.isArray(rows) && rows.length > 0;
  }

  /** `KYB_COMPLETE` on success: UNDER_REVIEW with the result. False when the guard matched no row. */
  async completeIfCurrent(
    applicationId: string,
    submissionNo: number,
    result: { level: KybLevel; score: number },
    manager: EntityManager,
  ): Promise<boolean> {
    const query = manager
      .createQueryBuilder()
      .update<MerchantApplication>(MerchantApplication)
      .set({
        status: this.kybCompleteTarget(),
        kybStatus: KybStatus.COMPLETED,
        kybLevel: result.level,
        kybScore: result.score,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      });
    const updated = await this.applyGuard(query, applicationId, submissionNo).execute();
    return updated.affected === 1;
  }

  /**
   * `KYB_COMPLETE` after the final failed attempt: UNDER_REVIEW with `kyb_status = FAILED` and no
   * level or score (docs/adrs/workflow.md §1.3). False when the guard matched no row.
   */
  async failIfCurrent(
    applicationId: string,
    submissionNo: number,
    manager: EntityManager,
  ): Promise<boolean> {
    const query = manager
      .createQueryBuilder()
      .update<MerchantApplication>(MerchantApplication)
      .set({
        status: this.kybCompleteTarget(),
        kybStatus: KybStatus.FAILED,
        kybLevel: null,
        kybScore: null,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      });
    const updated = await this.applyGuard(query, applicationId, submissionNo).execute();
    return updated.affected === 1;
  }

  /** The worker's guard. The UPDATE has no alias, so it uses bare column names. */
  private applyGuard(
    query: UpdateQueryBuilder<MerchantApplication>,
    applicationId: string,
    submissionNo: number,
  ): UpdateQueryBuilder<MerchantApplication> {
    return query
      .where('id = :id', { id: applicationId })
      .andWhere('submission_count = :submissionNo', { submissionNo })
      .andWhere('status = :riskReview', { riskReview: ApplicationStatus.RISK_REVIEW });
  }

  /** The target of `KYB_COMPLETE`, from the transition table (the single source). */
  private kybCompleteTarget(): ApplicationStatus {
    const target = nextSystemStatus(ApplicationStatus.RISK_REVIEW, TransitionAction.KYB_COMPLETE);
    if (target === null) {
      throw new Error('The transition table has no KYB_COMPLETE row from RISK_REVIEW');
    }
    return target;
  }
}
