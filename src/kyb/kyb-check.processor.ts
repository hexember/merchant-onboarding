import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { ApplicationStatus } from '../applications/application.enums';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditLogService, buildAuditMeta } from '../audit/audit-log.service';
import { AppEnv } from '../config/env.validation';
import { logError, logInfo } from '../logging/logger';
import {
  KYB_CHECK_QUEUE,
  KYB_WORKER_LABEL,
  KybCheckJobData,
  parseKybCheckJobData,
} from './kyb-job';
import { scoreToLevel, KybScoreThresholds } from './kyb-level';
import { KYB_PROVIDER, KybProvider, KybProviderInput } from './kyb-provider';
import {
  KybWorkerApplication,
  KybWorkerApplicationsRepository,
} from './kyb-worker-applications.repository';

const AUDIT_ENTITY_TYPE = 'merchant_application';

/** What one job run concluded. Every outcome is an ack; failures are thrown instead. */
export type KybJobOutcome = 'invalid' | 'stale' | 'already-done' | 'completed';

/** The parts of a BullMQ job the handler reads, so tests can pass crafted jobs without casts. */
export type KybJobLike = Pick<Job<unknown>, 'data' | 'attemptsMade' | 'opts'>;

/**
 * The job no longer matches the application at commit time (a result row already exists, or the
 * guarded UPDATE matched no row). Thrown inside the success transaction so it rolls back; the
 * handler turns it into `'stale'`. Not a failure: no audit row and no retry.
 */
class StaleKybJobError extends Error {
  constructor() {
    super('KYB job is stale at commit');
    this.name = 'StaleKybJobError';
  }
}

/**
 * The KYB worker (docs/adrs/kyb-check.md). It is the only actor that moves an application
 * RISK_REVIEW → UNDER_REVIEW, and it audits as actor_type SYSTEM / `kyb-worker`. It is never a
 * user: it builds no `AuthUser` and never uses `ApplicationsRepository`; it reads and writes only
 * through the worker-only `KybWorkerApplicationsRepository`.
 *
 * `autorun: false`: the BullMQ worker only runs when `KYB_WORKER_ENABLED` is true (see
 * `onApplicationBootstrap`), or when a test calls `startWorker()`.
 */
@Processor(KYB_CHECK_QUEUE, { autorun: false })
export class KybCheckProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly thresholds: KybScoreThresholds;
  private readonly workerEnabled: boolean;

  constructor(
    private readonly dataSource: DataSource,
    private readonly applications: KybWorkerApplicationsRepository,
    private readonly auditLogService: AuditLogService,
    @Inject(KYB_PROVIDER) private readonly provider: KybProvider,
    config: ConfigService<AppEnv, true>,
  ) {
    super();
    this.thresholds = {
      mediumMin: config.get('KYB_SCORE_MEDIUM_MIN', { infer: true }),
      highMin: config.get('KYB_SCORE_HIGH_MIN', { infer: true }),
    };
    this.workerEnabled = config.get('KYB_WORKER_ENABLED', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.workerEnabled) {
      this.startWorker();
    }
  }

  /**
   * Starts the BullMQ worker unless it is already running, so calling it twice is harmless. Used
   * by `onApplicationBootstrap` and by the one Redis-backed e2e test.
   */
  startWorker(): void {
    if (this.worker.isRunning()) {
      return;
    }
    void this.worker.run().catch((error: unknown) => {
      logError('kyb-worker', 'KYB worker stopped with an error', { error });
    });
  }

  process(job: Job<KybCheckJobData>): Promise<KybJobOutcome> {
    return this.handle(job);
  }

  /**
   * The idempotent KYB flow (docs/adrs/kyb-check.md, steps 1-5). Returns an outcome to ack the
   * job, or rethrows the attempt's error so BullMQ schedules the retry (or marks the job failed
   * after the last attempt, once the application has been moved to UNDER_REVIEW / FAILED).
   */
  async handle(job: KybJobLike): Promise<KybJobOutcome> {
    const data = parseKybCheckJobData(job.data);
    if (data === null) {
      // No job data in the log: a retry cannot fix it, so ack.
      logError('kyb-worker', 'Invalid KYB job data');
      return 'invalid';
    }
    const { applicationId, submissionNo } = data;
    // BullMQ counts finished attempts in `attemptsMade`, so this run is the next one.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    // Decided before any DB work, so any error on the last attempt (a read or write in steps 1-3,
    // the provider or the success transaction) runs the final-failure path.
    const isFinal = attempt >= maxAttempts;
    try {
      return await this.runSteps(applicationId, submissionNo, attempt);
    } catch (error) {
      if (error instanceof StaleKybJobError) {
        return 'stale';
      }
      logError('kyb-worker', 'KYB provider attempt failed', {
        applicationId,
        submissionNo,
        attempt,
        error,
      });
      const failMeta = {
        submissionNo,
        attempt,
        maxAttempts,
        final: isFinal,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      };
      if (isFinal) {
        // Safe even when the read failed: failIfCurrent is guarded by id, submission_count and
        // status RISK_REVIEW, so it moves nothing for a stale job.
        await this.recordFinalFailure(applicationId, submissionNo, attempt, failMeta);
      } else {
        await this.recordAttemptFailed(applicationId, submissionNo, attempt, failMeta);
      }
      throw error;
    }
  }

  /** Steps 1-4 for one attempt. Any thrown error is handled by `handle`. */
  private async runSteps(
    applicationId: string,
    submissionNo: number,
    attempt: number,
  ): Promise<KybJobOutcome> {
    // Step 1: stale check.
    const application = await this.applications.findForWorker(applicationId);
    if (
      application === null ||
      application.submissionCount !== submissionNo ||
      application.status !== ApplicationStatus.RISK_REVIEW
    ) {
      logInfo('kyb-worker', 'Stale KYB job skipped', { applicationId, submissionNo });
      return 'stale';
    }

    // Step 2: a result for this submission is already stored.
    if (await this.applications.kybCheckExists(applicationId, submissionNo)) {
      return 'already-done';
    }

    // Step 3: count the attempt before calling the provider.
    if (!(await this.applications.recordAttemptIfCurrent(applicationId, submissionNo))) {
      return 'stale';
    }

    await this.checkAndComplete(application, submissionNo, attempt);
    return 'completed';
  }

  /** Step 4: provider call, then the result row, the status change and the audit row in one transaction. */
  private async checkAndComplete(
    application: KybWorkerApplication,
    submissionNo: number,
    attempt: number,
  ): Promise<void> {
    // Only non-PII fields go to the provider (docs/adrs/sensitive-data.md).
    const input: KybProviderInput = {
      applicationId: application.id,
      merchantCategoryCode: application.merchantCategoryCode,
      businessType: application.businessType,
      expectedMonthlyVolumeMinor: application.expectedMonthlyVolumeMinor,
      averageTicketSizeMinor: application.averageTicketSizeMinor,
    };
    const startedAt = Date.now();
    const result = await this.provider.check(input);
    const latencyMs = Date.now() - startedAt;
    const level = scoreToLevel(result.score, this.thresholds);

    await this.dataSource.transaction(async (manager) => {
      const inserted = await this.applications.insertKybCheckIfAbsent(
        {
          applicationId: application.id,
          submissionNo,
          providerReference: result.providerReference,
          score: result.score,
          level,
          reasons: result.reasons,
          meta: buildAuditMeta({ providerVersion: result.providerVersion, latencyMs, attempt }),
        },
        manager,
      );
      if (!inserted) {
        throw new StaleKybJobError();
      }
      const moved = await this.applications.completeIfCurrent(
        application.id,
        submissionNo,
        { level, score: result.score },
        manager,
      );
      if (!moved) {
        // Rolls back the result row too, so no orphan row is kept.
        throw new StaleKybJobError();
      }
      await this.auditLogService.record(
        {
          actorType: AuditActorType.SYSTEM,
          actorLabel: KYB_WORKER_LABEL,
          action: AuditAction.KYB_CHECK_COMPLETED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: application.id,
          meta: {
            submissionNo,
            attempt,
            score: result.score,
            level,
            reasons: result.reasons,
            providerReference: result.providerReference,
          },
        },
        manager,
      );
    });
  }

  /** A non-final failed attempt: best-effort audit row. The caller rethrows the original error. */
  private async recordAttemptFailed(
    applicationId: string,
    submissionNo: number,
    attempt: number,
    failMeta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogService.record({
        actorType: AuditActorType.SYSTEM,
        actorLabel: KYB_WORKER_LABEL,
        action: AuditAction.KYB_CHECK_ATTEMPT_FAILED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: applicationId,
        meta: failMeta,
      });
    } catch (auditError) {
      logError('kyb-worker', 'KYB attempt-failed audit write failed', {
        applicationId,
        submissionNo,
        attempt,
        error: auditError,
      });
    }
  }

  /**
   * Step 5, after the last failed attempt: one best-effort transaction records the attempt, moves
   * the application to UNDER_REVIEW / FAILED (same guard) and, when it moved, records
   * KYB_CHECK_FAILED. So the application never stays in RISK_REVIEW once BullMQ gives up
   * (docs/adrs/workflow.md §1.2). The caller rethrows the original error.
   */
  private async recordFinalFailure(
    applicationId: string,
    submissionNo: number,
    attempt: number,
    failMeta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.auditLogService.record(
          {
            actorType: AuditActorType.SYSTEM,
            actorLabel: KYB_WORKER_LABEL,
            action: AuditAction.KYB_CHECK_ATTEMPT_FAILED,
            entityType: AUDIT_ENTITY_TYPE,
            entityId: applicationId,
            meta: failMeta,
          },
          manager,
        );
        const moved = await this.applications.failIfCurrent(applicationId, submissionNo, manager);
        if (moved) {
          await this.auditLogService.record(
            {
              actorType: AuditActorType.SYSTEM,
              actorLabel: KYB_WORKER_LABEL,
              action: AuditAction.KYB_CHECK_FAILED,
              entityType: AUDIT_ENTITY_TYPE,
              entityId: applicationId,
              meta: { submissionNo, attempts: attempt },
            },
            manager,
          );
        }
      });
    } catch (writeError) {
      logError('kyb-worker', 'KYB final-failure write failed', {
        applicationId,
        submissionNo,
        attempt,
        error: writeError,
      });
    }
  }
}
