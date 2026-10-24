import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { ApplicationStatus, BusinessType, KybLevel } from '../applications/application.enums';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditEntry, AuditLogService } from '../audit/audit-log.service';
import { AppEnv } from '../config/env.validation';
import * as logger from '../logging/logger';
import { KybCheckProcessor, KybJobLike } from './kyb-check.processor';
import { KybProviderError } from './kyb-provider';
import {
  KybWorkerApplication,
  KybWorkerApplicationsRepository,
} from './kyb-worker-applications.repository';
import { FakeKybProvider } from './testing/fake-kyb-provider';

// Made-up identifiers and amounts; no real merchant.
const APP_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MANAGER = { marker: 'tx-manager' } as unknown as EntityManager;

type WorkerStub = Pick<Worker, 'isRunning' | 'run' | 'close'>;

interface RepoMock {
  findForWorker: jest.MockedFunction<KybWorkerApplicationsRepository['findForWorker']>;
  kybCheckExists: jest.MockedFunction<KybWorkerApplicationsRepository['kybCheckExists']>;
  recordAttemptIfCurrent: jest.MockedFunction<
    KybWorkerApplicationsRepository['recordAttemptIfCurrent']
  >;
  insertKybCheckIfAbsent: jest.MockedFunction<
    KybWorkerApplicationsRepository['insertKybCheckIfAbsent']
  >;
  completeIfCurrent: jest.MockedFunction<KybWorkerApplicationsRepository['completeIfCurrent']>;
  failIfCurrent: jest.MockedFunction<KybWorkerApplicationsRepository['failIfCurrent']>;
}

interface Harness {
  processor: KybCheckProcessor;
  repo: RepoMock;
  record: jest.MockedFunction<AuditLogService['record']>;
  fake: FakeKybProvider;
  checkSpy: jest.SpyInstance;
  transaction: jest.Mock;
  // How each transaction callback ended, in order.
  txOutcomes: ('resolved' | 'rejected')[];
  // Names of the calls, in the order they happened.
  events: string[];
}

function application(overrides: Partial<KybWorkerApplication> = {}): KybWorkerApplication {
  return {
    id: APP_ID,
    status: ApplicationStatus.RISK_REVIEW,
    submissionCount: 1,
    merchantCategoryCode: '5411',
    businessType: BusinessType.PRIVATE_LIMITED,
    expectedMonthlyVolumeMinor: 500_000_00,
    averageTicketSizeMinor: 2_000_00,
    ...overrides,
  };
}

function configStub(workerEnabled = false): ConfigService<AppEnv, true> {
  const values: Partial<AppEnv> = {
    KYB_SCORE_MEDIUM_MIN: 40,
    KYB_SCORE_HIGH_MIN: 70,
    KYB_WORKER_ENABLED: workerEnabled,
  };
  return {
    get: jest.fn((key: keyof AppEnv) => values[key]),
  } as unknown as ConfigService<AppEnv, true>;
}

function createHarness(options: { workerEnabled?: boolean } = {}): Harness {
  const events: string[] = [];
  const txOutcomes: ('resolved' | 'rejected')[] = [];
  const repo: RepoMock = {
    findForWorker: jest.fn().mockResolvedValue(application()),
    kybCheckExists: jest.fn().mockResolvedValue(false),
    recordAttemptIfCurrent: jest.fn().mockImplementation(() => {
      events.push('recordAttempt');
      return Promise.resolve(true);
    }),
    insertKybCheckIfAbsent: jest.fn().mockImplementation(() => {
      events.push('insert');
      return Promise.resolve(true);
    }),
    completeIfCurrent: jest.fn().mockImplementation(() => {
      events.push('complete');
      return Promise.resolve(true);
    }),
    failIfCurrent: jest.fn().mockImplementation(() => {
      events.push('fail');
      return Promise.resolve(true);
    }),
  };
  const record: jest.MockedFunction<AuditLogService['record']> = jest
    .fn()
    .mockImplementation((entry: AuditEntry) => {
      events.push(`audit:${entry.action}`);
      return Promise.resolve();
    });
  const transaction = jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) => {
    try {
      const result = await work(MANAGER);
      txOutcomes.push('resolved');
      return result;
    } catch (error) {
      txOutcomes.push('rejected');
      throw error;
    }
  });
  const fake = new FakeKybProvider();
  const realCheck = fake.check.bind(fake);
  const checkSpy = jest.spyOn(fake, 'check').mockImplementation((input) => {
    events.push('provider');
    return realCheck(input);
  });
  const processor = new KybCheckProcessor(
    { transaction } as unknown as DataSource,
    repo as unknown as KybWorkerApplicationsRepository,
    { record } as unknown as AuditLogService,
    fake,
    configStub(options.workerEnabled ?? false),
  );
  return { processor, repo, record, fake, checkSpy, transaction, txOutcomes, events };
}

function job(
  attemptsMade: number,
  data: unknown = { applicationId: APP_ID, submissionNo: 1 },
): KybJobLike {
  const crafted: KybJobLike = { data, attemptsMade, opts: { attempts: 5 } };
  return crafted;
}

function auditEntries(record: Harness['record']): AuditEntry[] {
  return record.mock.calls.map(([entry]) => entry);
}

function auditActions(record: Harness['record']): AuditAction[] {
  return auditEntries(record).map((entry) => entry.action);
}

/**
 * Replaces the processor's BullMQ worker so unit tests never construct one. Uses
 * `jest.spyOn(..., 'get')` on WorkerHost's prototype getter (configurable on the installed
 * @nestjs/bullmq). The stub only implements the three members the processor calls, so the
 * mocked return value needs the full `Worker` type: this is the one cast in this spec.
 */
function stubWorker(processor: KybCheckProcessor, stub: WorkerStub): void {
  jest.spyOn(processor, 'worker', 'get').mockReturnValue(stub as unknown as Worker);
}

describe('KybCheckProcessor', () => {
  let logError: jest.SpyInstance;
  let logInfo: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(logger, 'logError').mockImplementation(() => undefined);
    logInfo = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('success', () => {
    it('records the attempt, calls the provider, then inserts, completes and audits in one transaction', async () => {
      const h = createHarness();

      await expect(h.processor.handle(job(0))).resolves.toBe('completed');

      expect(h.events).toEqual([
        'recordAttempt',
        'provider',
        'insert',
        'complete',
        `audit:${AuditAction.KYB_CHECK_COMPLETED}`,
      ]);
      expect(h.transaction).toHaveBeenCalledTimes(1);
      expect(h.txOutcomes).toEqual(['resolved']);
      expect(h.repo.recordAttemptIfCurrent).toHaveBeenCalledWith(APP_ID, 1);

      const [insertValues, insertManager] = h.repo.insertKybCheckIfAbsent.mock.calls[0] ?? [];
      expect(insertManager).toBe(MANAGER);
      expect(insertValues).toMatchObject({
        applicationId: APP_ID,
        submissionNo: 1,
        providerReference: 'fake-ref-1',
        score: 78,
        level: KybLevel.HIGH,
        reasons: ['FAKE_REASON'],
      });
      expect(Object.keys(insertValues?.meta ?? {}).sort()).toEqual([
        'attempt',
        'latencyMs',
        'providerVersion',
      ]);
      expect(insertValues?.meta).toMatchObject({ providerVersion: 'fake-1', attempt: 1 });

      expect(h.repo.completeIfCurrent).toHaveBeenCalledWith(
        APP_ID,
        1,
        { level: KybLevel.HIGH, score: 78 },
        MANAGER,
      );
      expect(h.record).toHaveBeenCalledTimes(1);
      const [entry, auditManager] = h.record.mock.calls[0] ?? [];
      expect(auditManager).toBe(MANAGER);
      expect(entry).toEqual({
        actorType: AuditActorType.SYSTEM,
        actorLabel: 'kyb-worker',
        action: AuditAction.KYB_CHECK_COMPLETED,
        entityType: 'merchant_application',
        entityId: APP_ID,
        meta: {
          submissionNo: 1,
          attempt: 1,
          score: 78,
          level: 'HIGH',
          reasons: ['FAKE_REASON'],
          providerReference: 'fake-ref-1',
        },
      });
      expect(entry).not.toHaveProperty('actorId');
      expect(entry).not.toHaveProperty('actorRole');
      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
    });

    it('passes only non-PII fields to the provider', async () => {
      const h = createHarness();

      await h.processor.handle(job(0));

      expect(h.fake.calls).toHaveLength(1);
      expect(Object.keys(h.fake.calls[0] ?? {}).sort()).toEqual(
        [
          'applicationId',
          'merchantCategoryCode',
          'businessType',
          'expectedMonthlyVolumeMinor',
          'averageTicketSizeMinor',
        ].sort(),
      );
    });

    it('process() delegates to handle()', async () => {
      const h = createHarness();
      const handle = jest.spyOn(h.processor, 'handle').mockResolvedValue('completed');
      const bullJob = job(0) as Parameters<KybCheckProcessor['process']>[0];

      await expect(h.processor.process(bullJob)).resolves.toBe('completed');
      expect(handle).toHaveBeenCalledWith(bullJob);
    });
  });

  describe('stale', () => {
    it.each([
      ['no application', null],
      ['submission_count moved on', application({ submissionCount: 2 })],
      ['status no longer RISK_REVIEW', application({ status: ApplicationStatus.UNDER_REVIEW })],
    ])('%s → stale, no provider call, no write, no audit', async (_name, found) => {
      const h = createHarness();
      h.repo.findForWorker.mockResolvedValue(found);

      await expect(h.processor.handle(job(0))).resolves.toBe('stale');

      expect(h.checkSpy).not.toHaveBeenCalled();
      expect(h.repo.recordAttemptIfCurrent).not.toHaveBeenCalled();
      expect(h.repo.insertKybCheckIfAbsent).not.toHaveBeenCalled();
      expect(h.repo.completeIfCurrent).not.toHaveBeenCalled();
      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledWith('kyb-worker', 'Stale KYB job skipped', {
        applicationId: APP_ID,
        submissionNo: 1,
      });
    });

    it('stale between the check and the attempt write → stale, no provider call', async () => {
      const h = createHarness();
      h.repo.recordAttemptIfCurrent.mockResolvedValue(false);

      await expect(h.processor.handle(job(0))).resolves.toBe('stale');

      expect(h.checkSpy).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    });
  });

  it('duplicate job: an existing result row → already-done, no attempt write, no provider call', async () => {
    const h = createHarness();
    h.repo.kybCheckExists.mockResolvedValue(true);

    await expect(h.processor.handle(job(0))).resolves.toBe('already-done');

    expect(h.repo.kybCheckExists).toHaveBeenCalledWith(APP_ID, 1);
    expect(h.repo.recordAttemptIfCurrent).not.toHaveBeenCalled();
    expect(h.checkSpy).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  describe('duplicate at commit', () => {
    it('completeIfCurrent false → stale, rolled back, no audit, no ATTEMPT_FAILED', async () => {
      const h = createHarness();
      h.repo.completeIfCurrent.mockResolvedValue(false);

      await expect(h.processor.handle(job(0))).resolves.toBe('stale');

      expect(h.txOutcomes).toEqual(['rejected']);
      expect(h.record).not.toHaveBeenCalled();
      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    });

    it('insert conflict → stale, completeIfCurrent not called, rolled back, no audit', async () => {
      const h = createHarness();
      h.repo.insertKybCheckIfAbsent.mockResolvedValue(false);

      await expect(h.processor.handle(job(0))).resolves.toBe('stale');

      expect(h.repo.completeIfCurrent).not.toHaveBeenCalled();
      expect(h.txOutcomes).toEqual(['rejected']);
      expect(h.record).not.toHaveBeenCalled();
    });

    it('stale at commit on the final attempt does not run the final-failure path', async () => {
      const h = createHarness();
      h.repo.completeIfCurrent.mockResolvedValue(false);

      await expect(h.processor.handle(job(4))).resolves.toBe('stale');

      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('a failed non-final attempt writes one ATTEMPT_FAILED and rethrows; the next attempt succeeds', async () => {
      const h = createHarness();
      h.fake.failNext(1);

      const first = h.processor.handle(job(0));
      await expect(first).rejects.toBeInstanceOf(KybProviderError);

      expect(h.record).toHaveBeenCalledTimes(1);
      const [failed, failedManager] = h.record.mock.calls[0] ?? [];
      // Best effort, outside any transaction.
      expect(failedManager).toBeUndefined();
      expect(failed).toEqual({
        actorType: AuditActorType.SYSTEM,
        actorLabel: 'kyb-worker',
        action: AuditAction.KYB_CHECK_ATTEMPT_FAILED,
        entityType: 'merchant_application',
        entityId: APP_ID,
        meta: {
          submissionNo: 1,
          attempt: 1,
          maxAttempts: 5,
          final: false,
          errorName: 'KybProviderError',
        },
      });
      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith('kyb-worker', 'KYB provider attempt failed', {
        applicationId: APP_ID,
        submissionNo: 1,
        attempt: 1,
        error: expect.any(KybProviderError) as unknown,
      });

      await expect(h.processor.handle(job(1))).resolves.toBe('completed');
      const completed = auditEntries(h.record)[1];
      expect(completed?.action).toBe(AuditAction.KYB_CHECK_COMPLETED);
      expect(completed?.meta).toMatchObject({ attempt: 2 });
    });

    it('when the ATTEMPT_FAILED write also fails, rejects with the provider error and logs twice', async () => {
      const h = createHarness();
      h.fake.failNext(1);
      h.record.mockRejectedValue(new Error('audit down'));

      await expect(h.processor.handle(job(0))).rejects.toBeInstanceOf(KybProviderError);

      expect(logError).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenNthCalledWith(
        2,
        'kyb-worker',
        'KYB attempt-failed audit write failed',
        {
          applicationId: APP_ID,
          submissionNo: 1,
          attempt: 1,
          error: expect.objectContaining({ message: 'audit down' }) as unknown,
        },
      );
    });

    it('an audit failure on success (not final) rejects with that error, no failIfCurrent', async () => {
      const h = createHarness();
      const auditError = new Error('audit insert failed');
      h.record.mockImplementation((entry: AuditEntry) =>
        entry.action === AuditAction.KYB_CHECK_COMPLETED
          ? Promise.reject(auditError)
          : Promise.resolve(),
      );

      await expect(h.processor.handle(job(0))).rejects.toBe(auditError);

      expect(h.txOutcomes).toEqual(['rejected']);
      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
      expect(auditActions(h.record)).toEqual([
        AuditAction.KYB_CHECK_COMPLETED,
        AuditAction.KYB_CHECK_ATTEMPT_FAILED,
      ]);
      expect(auditEntries(h.record)[1]?.meta).toMatchObject({ final: false, errorName: 'Error' });
    });
  });

  describe('final failure', () => {
    it('provider error on the last attempt: ATTEMPT_FAILED (final), failIfCurrent, KYB_CHECK_FAILED in one transaction', async () => {
      const h = createHarness();
      h.fake.alwaysFail();

      await expect(h.processor.handle(job(4))).rejects.toBeInstanceOf(KybProviderError);

      expect(h.transaction).toHaveBeenCalledTimes(1);
      expect(h.txOutcomes).toEqual(['resolved']);
      expect(h.events).toEqual([
        'recordAttempt',
        'provider',
        `audit:${AuditAction.KYB_CHECK_ATTEMPT_FAILED}`,
        'fail',
        `audit:${AuditAction.KYB_CHECK_FAILED}`,
      ]);
      expect(h.repo.failIfCurrent).toHaveBeenCalledWith(APP_ID, 1, MANAGER);
      const [attemptFailed, failed] = h.record.mock.calls;
      expect(attemptFailed?.[1]).toBe(MANAGER);
      expect(attemptFailed?.[0].meta).toEqual({
        submissionNo: 1,
        attempt: 5,
        maxAttempts: 5,
        final: true,
        errorName: 'KybProviderError',
      });
      expect(failed?.[1]).toBe(MANAGER);
      expect(failed?.[0]).toEqual({
        actorType: AuditActorType.SYSTEM,
        actorLabel: 'kyb-worker',
        action: AuditAction.KYB_CHECK_FAILED,
        entityType: 'merchant_application',
        entityId: APP_ID,
        meta: { submissionNo: 1, attempts: 5 },
      });
    });

    it('a failed success transaction on the last attempt still runs the final-failure path', async () => {
      const h = createHarness();
      const auditError = new Error('audit insert failed');
      let failedOnce = false;
      h.record.mockImplementation((entry: AuditEntry) => {
        h.events.push(`audit:${entry.action}`);
        if (entry.action === AuditAction.KYB_CHECK_COMPLETED && !failedOnce) {
          failedOnce = true;
          return Promise.reject(auditError);
        }
        return Promise.resolve();
      });

      await expect(h.processor.handle(job(4))).rejects.toBe(auditError);

      expect(h.txOutcomes).toEqual(['rejected', 'resolved']);
      expect(h.events).toEqual([
        'recordAttempt',
        'provider',
        'insert',
        'complete',
        `audit:${AuditAction.KYB_CHECK_COMPLETED}`,
        `audit:${AuditAction.KYB_CHECK_ATTEMPT_FAILED}`,
        'fail',
        `audit:${AuditAction.KYB_CHECK_FAILED}`,
      ]);
      expect(auditEntries(h.record)[1]?.meta).toMatchObject({ final: true, errorName: 'Error' });
    });

    it('when the final-failure transaction also fails, rejects with the original error and logs ids only', async () => {
      const h = createHarness();
      h.fake.alwaysFail();
      h.repo.failIfCurrent.mockRejectedValue(new Error('db down'));

      await expect(h.processor.handle(job(4))).rejects.toBeInstanceOf(KybProviderError);

      expect(h.txOutcomes).toEqual(['rejected']);
      const finalLog = logError.mock.calls.find(
        (call: unknown[]) => call[1] === 'KYB final-failure write failed',
      ) as [string, string, Record<string, unknown>] | undefined;
      expect(finalLog).toBeDefined();
      expect(Object.keys(finalLog?.[2] ?? {}).sort()).toEqual([
        'applicationId',
        'attempt',
        'error',
        'submissionNo',
      ]);
      expect(finalLog?.[2]).toMatchObject({ applicationId: APP_ID, submissionNo: 1, attempt: 5 });
    });

    it('findForWorker rejecting on the last attempt: final-failure attempted, original error rethrown', async () => {
      const h = createHarness();
      const readError = new Error('db read failed');
      h.repo.findForWorker.mockRejectedValue(readError);

      await expect(h.processor.handle(job(4))).rejects.toBe(readError);

      expect(h.repo.kybCheckExists).not.toHaveBeenCalled();
      expect(h.checkSpy).not.toHaveBeenCalled();
      expect(h.transaction).toHaveBeenCalledTimes(1);
      expect(h.repo.failIfCurrent).toHaveBeenCalledWith(APP_ID, 1, MANAGER);
      expect(h.events).toEqual([
        `audit:${AuditAction.KYB_CHECK_ATTEMPT_FAILED}`,
        'fail',
        `audit:${AuditAction.KYB_CHECK_FAILED}`,
      ]);
      expect(auditEntries(h.record)[0]?.meta).toMatchObject({ final: true, attempt: 5 });
    });

    it('recordAttemptIfCurrent rejecting on the last attempt: final-failure attempted, original error rethrown', async () => {
      const h = createHarness();
      const writeError = new Error('db write failed');
      h.repo.recordAttemptIfCurrent.mockRejectedValue(writeError);

      await expect(h.processor.handle(job(4))).rejects.toBe(writeError);

      expect(h.checkSpy).not.toHaveBeenCalled();
      expect(h.transaction).toHaveBeenCalledTimes(1);
      expect(h.txOutcomes).toEqual(['resolved']);
      expect(h.repo.failIfCurrent).toHaveBeenCalledWith(APP_ID, 1, MANAGER);
      expect(auditActions(h.record)).toEqual([
        AuditAction.KYB_CHECK_ATTEMPT_FAILED,
        AuditAction.KYB_CHECK_FAILED,
      ]);
    });

    it('kybCheckExists rejecting on a non-final attempt: ATTEMPT_FAILED only, no failIfCurrent, rethrown', async () => {
      const h = createHarness();
      const readError = new Error('db read failed');
      h.repo.kybCheckExists.mockRejectedValue(readError);

      await expect(h.processor.handle(job(0))).rejects.toBe(readError);

      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.repo.failIfCurrent).not.toHaveBeenCalled();
      expect(auditActions(h.record)).toEqual([AuditAction.KYB_CHECK_ATTEMPT_FAILED]);
    });

    it('final failure but stale: failIfCurrent false → no KYB_CHECK_FAILED, still rejects', async () => {
      const h = createHarness();
      h.fake.alwaysFail();
      h.repo.failIfCurrent.mockResolvedValue(false);

      await expect(h.processor.handle(job(4))).rejects.toBeInstanceOf(KybProviderError);

      expect(auditActions(h.record)).toEqual([AuditAction.KYB_CHECK_ATTEMPT_FAILED]);
    });
  });

  it('invalid job data → invalid, no repository call, nothing from the data logged', async () => {
    const h = createHarness();

    await expect(h.processor.handle(job(0, { applicationId: 'x' }))).resolves.toBe('invalid');

    expect(h.repo.findForWorker).not.toHaveBeenCalled();
    expect(h.repo.recordAttemptIfCurrent).not.toHaveBeenCalled();
    expect(h.checkSpy).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('kyb-worker', 'Invalid KYB job data');
  });

  describe('bootstrap', () => {
    function workerStub(): {
      stub: WorkerStub;
      run: jest.MockedFunction<Worker['run']>;
      running: { value: boolean };
    } {
      const running = { value: false };
      const run: jest.MockedFunction<Worker['run']> = jest.fn(() => {
        running.value = true;
        return Promise.resolve();
      });
      const isRunning: jest.MockedFunction<Worker['isRunning']> = jest.fn(() => running.value);
      const close: jest.MockedFunction<Worker['close']> = jest.fn(() => Promise.resolve());
      return { stub: { isRunning, run, close }, run, running };
    }

    it('KYB_WORKER_ENABLED false → the worker is not started', () => {
      const h = createHarness({ workerEnabled: false });
      const { stub, run } = workerStub();
      stubWorker(h.processor, stub);

      h.processor.onApplicationBootstrap();

      expect(run).not.toHaveBeenCalled();
    });

    it('KYB_WORKER_ENABLED true → the worker is started once', () => {
      const h = createHarness({ workerEnabled: true });
      const { stub, run } = workerStub();
      stubWorker(h.processor, stub);

      h.processor.onApplicationBootstrap();

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('startWorker() twice while running starts it only once', () => {
      const h = createHarness();
      const { stub, run } = workerStub();
      stubWorker(h.processor, stub);

      h.processor.startWorker();
      h.processor.startWorker();

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('a worker run that rejects is logged, not left unhandled', async () => {
      const h = createHarness();
      const { stub, run } = workerStub();
      run.mockRejectedValue(new Error('redis gone'));
      stubWorker(h.processor, stub);

      h.processor.startWorker();
      await Promise.resolve();
      await Promise.resolve();

      expect(logError).toHaveBeenCalledWith('kyb-worker', 'KYB worker stopped with an error', {
        error: expect.objectContaining({ message: 'redis gone' }) as unknown,
      });
    });
  });
});
