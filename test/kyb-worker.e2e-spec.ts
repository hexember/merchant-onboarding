import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { Job, Queue, QueueEvents } from 'bullmq';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuditAction } from '../src/audit/audit.enums';
import { AuditLogService } from '../src/audit/audit-log.service';
import { UserRole } from '../src/common/common.enums';
import { BCRYPT_COST } from '../src/common/password';
import { AppEnv } from '../src/config/env.validation';
import { KybCheckProcessor, KybJobLike, KybJobOutcome } from '../src/kyb/kyb-check.processor';
import { KybCheckQueue, kybQueueConnection } from '../src/kyb/kyb-check.queue';
import { KYB_CHECK_QUEUE, kybCheckJobId } from '../src/kyb/kyb-job';
import { KYB_PROVIDER } from '../src/kyb/kyb-provider';
import { FakeKybProvider } from '../src/kyb/testing/fake-kyb-provider';
import { configureLogger } from '../src/logging/logger';
import { UsersRepository } from '../src/users/users.repository';
import { resetApplicationData, resetTables } from './utils/test-db';

// The KYB worker end to end (docs/adrs/kyb-check.md, docs/adrs/testing.md) on real Postgres and
// Redis, with the deterministic FakeKybProvider. The worker is off (test-env.ts) except inside
// describe('through Redis'), which starts it explicitly.

// Fake user only (@example.com, made-up name). The password comes from SEED_SALES_PASSWORD.
const SALES_EMAIL = 'kyb-sales@example.com';

// Fake application data. The sensitive values are asserted never to reach the logs raw.
const RAW_TAX_ID = 'PAN-FAKE-00004321';
const RAW_NATIONAL_ID = 'NID-FAKE-8765';
const RAW_OWNER_EMAIL = 'kyb-owner@example.com';
const RAW_OWNER_PHONE = '+977-0000000456';
const RAW_SECRETS = [RAW_TAX_ID, RAW_NATIONAL_ID, RAW_OWNER_EMAIL, RAW_OWNER_PHONE];

const PAYLOAD = {
  businessName: 'Example Hardware',
  legalBusinessName: 'Example Hardware Pvt. Ltd.',
  businessType: 'PRIVATE_LIMITED',
  registrationNumber: 'REG-FAKE-0002',
  taxId: RAW_TAX_ID,
  ownerFullName: 'John Example',
  ownerEmail: RAW_OWNER_EMAIL,
  ownerPhone: RAW_OWNER_PHONE,
  ownerNationalId: RAW_NATIONAL_ID,
  merchantCategoryCode: '5251',
  websiteUrl: 'https://hardware.example.com',
  expectedMonthlyVolumeMinor: 2500000,
  averageTicketSizeMinor: 150000,
};

// A made-up UUID that never belongs to a row (the database generates v4 UUIDs).
const FAKE_UUID = '00000000-0000-4000-8000-000000000002';

const ATTEMPT_FAILED_MESSAGE = 'KYB provider attempt failed';
const POLL_INTERVAL_MS = 25;

interface ApplicationRow {
  status: string;
  kyb_status: string;
  kyb_level: string | null;
  kyb_score: number | null;
  kyb_attempts: number;
  kyb_last_attempt_at: Date | null;
  submission_count: number;
  version: number;
}

interface KybCheckRow {
  submission_no: number;
  score: number;
  level: string;
  reasons: string[];
  meta: Record<string, unknown>;
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_label: string | null;
  action: string;
  meta: Record<string, unknown>;
}

interface KybCheckBody {
  status: string;
  level: string | null;
  label: string | null;
  score: number | null;
  attempts: number;
  lastAttemptAt: string | null;
}

// bcrypt cost 12: hashing the user and the login take a noticeable time.
jest.setTimeout(60_000);

describe('KYB worker (e2e)', () => {
  const fake = new FakeKybProvider();
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let processor: KybCheckProcessor;
  let salesToken: string;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  // The logger prints through console.log / console.error, which Jest buffers per file, so the
  // stream spies alone would miss those lines.
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  // Captured output of every finished test, for the spec-wide no-PII check at the end.
  const allCaptured: string[] = [];

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Logger on, after every spy is installed, so the log checks below see real output.
    configureLogger({ production: false });

    const module: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KYB_PROVIDER)
      .useValue(fake)
      .compile();
    app = module.createNestApplication<INestApplication<App>>();
    await app.init();
    dataSource = app.get(DataSource);
    processor = app.get(KybCheckProcessor);
    queue = app.get<Queue>(getQueueToken(KYB_CHECK_QUEUE));
    await queue.waitUntilReady();

    const config = app.get(ConfigService);
    const salesPassword = config.getOrThrow<string>('SEED_SALES_PASSWORD');
    const passwordHash = await bcrypt.hash(salesPassword, BCRYPT_COST);
    await resetTables(dataSource);
    await app.get(UsersRepository).insertIfAbsent({
      email: SALES_EMAIL,
      fullName: 'Kim Sales',
      role: UserRole.SALES,
      passwordHash,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: SALES_EMAIL, password: salesPassword })
      .expect(200);
    salesToken = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    // The queue prefix is unique to this run; this removes every job this spec left.
    await queue.obliterate({ force: true });
    await app.close();
    configureLogger({ production: true });
    stdout.mockRestore();
    stderr.mockRestore();
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  beforeEach(async () => {
    await resetApplicationData(dataSource);
    fake.reset();
    stdout.mockClear();
    stderr.mockClear();
    consoleLog.mockClear();
    consoleError.mockClear();
  });

  afterEach(() => {
    allCaptured.push(capturedText());
  });

  function chunks(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  // Everything written to stdout, stderr, console.log and console.error since the last mockClear.
  function capturedText(): string {
    return [
      ...chunks(stdout),
      ...chunks(stderr),
      ...chunks(consoleLog),
      ...chunks(consoleError),
    ].join('\n');
  }

  function expectNoRawSecrets(text: string): void {
    for (const secret of [...RAW_SECRETS, salesToken]) {
      expect(text).not.toContain(secret);
    }
  }

  // Creates and submits an application through HTTP, so it is RISK_REVIEW with submission 1.
  async function submittedApplication(): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/applications')
      .set('Authorization', `Bearer ${salesToken}`)
      .send(PAYLOAD)
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer())
      .post(`/applications/${id}/submit`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    return id;
  }

  async function kybCheckBody(id: string): Promise<KybCheckBody> {
    const res = await request(app.getHttpServer())
      .get(`/applications/${id}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    return (res.body as { kybCheck: KybCheckBody }).kybCheck;
  }

  function craftedJob(data: unknown, attemptsMade: number): KybJobLike {
    return { data, attemptsMade, opts: { attempts: 5 } };
  }

  function handle(id: string, attemptsMade = 0, submissionNo = 1): Promise<KybJobOutcome> {
    return processor.handle(craftedJob({ applicationId: id, submissionNo }, attemptsMade));
  }

  async function applicationRow(id: string): Promise<ApplicationRow | undefined> {
    const rows: ApplicationRow[] = await dataSource.query(
      `SELECT status, kyb_status, kyb_level, kyb_score, kyb_attempts, kyb_last_attempt_at,
              submission_count, version
         FROM merchant_applications WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function kybCheckRows(id: string): Promise<KybCheckRow[]> {
    return dataSource.query(
      'SELECT submission_no, score, level, reasons, meta FROM kyb_checks WHERE application_id = $1',
      [id],
    );
  }

  // Rows written in one transaction share created_at, so KYB_CHECK_FAILED (always written after
  // the final KYB_CHECK_ATTEMPT_FAILED in the same transaction) is sorted last within a tie.
  async function auditRows(id: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT actor_type, actor_id, actor_role, actor_label, action, meta
         FROM audit_logs WHERE entity_id = $1
        ORDER BY created_at, (action = 'KYB_CHECK_FAILED')`,
      [id],
    );
  }

  async function auditActions(id: string): Promise<string[]> {
    return (await auditRows(id)).map((row) => row.action);
  }

  // Makes AuditLogService.record reject once on `action`; every other call goes through.
  function failRecordOnceOn(action: AuditAction): jest.SpyInstance {
    const service = app.get(AuditLogService);
    const real = service.record.bind(service);
    let failed = false;
    return jest.spyOn(service, 'record').mockImplementation(async (entry, manager) => {
      if (!failed && entry.action === action) {
        failed = true;
        throw new Error('audit write failed (test)');
      }
      return real(entry, manager);
    });
  }

  describe('handler (crafted jobs)', () => {
    it('success: UNDER_REVIEW / COMPLETED, one result row, a SYSTEM audit row, kybCheck on GET', async () => {
      const id = await submittedApplication();
      const before = await applicationRow(id);

      await expect(handle(id)).resolves.toBe('completed');

      const row = await applicationRow(id);
      expect(row).toMatchObject({
        status: 'UNDER_REVIEW',
        kyb_status: 'COMPLETED',
        kyb_level: 'HIGH',
        kyb_score: 78,
        kyb_attempts: 1,
      });
      expect(row?.kyb_last_attempt_at).not.toBeNull();
      expect(row?.version).toBeGreaterThan(before?.version ?? Number.MAX_SAFE_INTEGER);

      const checks = await kybCheckRows(id);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        submission_no: 1,
        score: 78,
        level: 'HIGH',
        reasons: ['FAKE_REASON'],
      });
      expect(Object.keys(checks[0]?.meta ?? {}).sort()).toEqual([
        'attempt',
        'latencyMs',
        'providerVersion',
      ]);

      const audits = await auditRows(id);
      expect(audits.map((audit) => audit.action)).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_SUBMITTED',
        'KYB_CHECK_COMPLETED',
      ]);
      expect(audits[2]).toMatchObject({
        actor_type: 'SYSTEM',
        actor_id: null,
        actor_role: null,
        actor_label: 'kyb-worker',
      });

      const kybCheck = await kybCheckBody(id);
      expect(kybCheck).toEqual({
        status: 'COMPLETED',
        level: 'HIGH',
        label: 'Needs double check',
        score: 78,
        attempts: 1,
        lastAttemptAt: expect.any(String) as unknown,
      });
      expect(new Date(kybCheck.lastAttemptAt ?? '').toISOString()).toBe(kybCheck.lastAttemptAt);
    });

    it('duplicate job (sequential): completed, then stale; one row, one audit, one provider call', async () => {
      const id = await submittedApplication();

      await expect(handle(id)).resolves.toBe('completed');
      await expect(handle(id)).resolves.toBe('stale');

      await expect(kybCheckRows(id)).resolves.toHaveLength(1);
      expect(
        (await auditActions(id)).filter((action) => action === 'KYB_CHECK_COMPLETED'),
      ).toHaveLength(1);
      expect(fake.calls).toHaveLength(1);
    });

    it('duplicate job (concurrent): exactly one completed, one row, one audit', async () => {
      const id = await submittedApplication();

      const outcomes = await Promise.all([handle(id), handle(id)]);

      // Both calls may pass the stale and existing-row checks before either commits, so
      // kyb_attempts may be 1 or 2 and the fake may have been called once or twice. Neither is
      // asserted; the unique constraint and the guarded UPDATE keep one stored result.
      expect(outcomes.filter((outcome) => outcome === 'completed')).toHaveLength(1);
      await expect(kybCheckRows(id)).resolves.toHaveLength(1);
      expect(
        (await auditActions(id)).filter((action) => action === 'KYB_CHECK_COMPLETED'),
      ).toHaveLength(1);
    });

    it('an existing result row: already-done, no attempt, no provider call', async () => {
      const id = await submittedApplication();
      // Test-only SQL: a stored result for (id, 1) while the application is still RISK_REVIEW.
      await dataSource.query(
        `INSERT INTO kyb_checks (application_id, submission_no, provider_reference, score, level)
         VALUES ($1, 1, 'fake-ref-existing', 20, 'LOW')`,
        [id],
      );

      await expect(handle(id)).resolves.toBe('already-done');

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        kyb_attempts: 0,
      });
      expect(fake.calls).toHaveLength(0);
    });

    it('stale after a resubmit: no attempt, no row, no audit', async () => {
      const id = await submittedApplication();
      await dataSource.query('UPDATE merchant_applications SET submission_count = 2 WHERE id = $1', [
        id,
      ]);

      await expect(handle(id, 0, 1)).resolves.toBe('stale');

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        kyb_attempts: 0,
      });
      await expect(kybCheckRows(id)).resolves.toEqual([]);
      await expect(auditActions(id)).resolves.toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_SUBMITTED',
      ]);
      expect(fake.calls).toHaveLength(0);
    });

    it('stale: an unknown application', async () => {
      await expect(handle(FAKE_UUID)).resolves.toBe('stale');
      expect(fake.calls).toHaveLength(0);
    });

    it('invalid job data is acked as invalid', async () => {
      await expect(processor.handle(craftedJob({ applicationId: 'x' }, 0))).resolves.toBe(
        'invalid',
      );
      expect(fake.calls).toHaveLength(0);
    });

    it('retry, then success: the failed attempt is counted and audited, the retry completes', async () => {
      const id = await submittedApplication();
      fake.failNext(1);

      await expect(handle(id, 0)).rejects.toThrow('Fake provider failure');

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        kyb_status: 'PENDING',
        kyb_attempts: 1,
      });
      const failed = (await auditRows(id)).filter(
        (audit) => audit.action === 'KYB_CHECK_ATTEMPT_FAILED',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        actor_type: 'SYSTEM',
        actor_label: 'kyb-worker',
        meta: { final: false, attempt: 1 },
      });
      // Positive check first, so the no-PII check cannot pass on silent output.
      const text = capturedText();
      expect(text).toContain(ATTEMPT_FAILED_MESSAGE);
      expectNoRawSecrets(text);

      await expect(handle(id, 1)).resolves.toBe('completed');

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'UNDER_REVIEW',
        kyb_status: 'COMPLETED',
        kyb_attempts: 2,
      });
      expect((await kybCheckBody(id)).attempts).toBe(2);
    });

    it('retries used up: UNDER_REVIEW / FAILED after the fifth attempt, five attempt rows and one KYB_CHECK_FAILED', async () => {
      const id = await submittedApplication();
      fake.alwaysFail();

      for (let attemptsMade = 0; attemptsMade < 5; attemptsMade += 1) {
        await expect(handle(id, attemptsMade)).rejects.toThrow('Fake provider failure');
      }

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'UNDER_REVIEW',
        kyb_status: 'FAILED',
        kyb_level: null,
        kyb_score: null,
        kyb_attempts: 5,
      });
      await expect(kybCheckRows(id)).resolves.toEqual([]);
      const kybAudits = (await auditRows(id)).filter((audit) => audit.action.startsWith('KYB_'));
      expect(kybAudits.map((audit) => audit.action)).toEqual([
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_FAILED',
      ]);
      expect(kybAudits.slice(0, 5).map((audit) => audit.meta.final)).toEqual([
        false,
        false,
        false,
        false,
        true,
      ]);
      await expect(kybCheckBody(id)).resolves.toMatchObject({
        status: 'FAILED',
        level: null,
        label: null,
        score: null,
        attempts: 5,
      });
    });

    it('crash between provider and commit (not final): rolled back, attempt audited, the retry completes once', async () => {
      const id = await submittedApplication();
      const spy = failRecordOnceOn(AuditAction.KYB_CHECK_COMPLETED);
      try {
        await expect(handle(id, 0)).rejects.toThrow('audit write failed (test)');
      } finally {
        spy.mockRestore();
      }

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        kyb_status: 'PENDING',
      });
      await expect(kybCheckRows(id)).resolves.toEqual([]);
      const audits = await auditRows(id);
      expect(audits.map((audit) => audit.action)).not.toContain('KYB_CHECK_COMPLETED');
      const failed = audits.filter((audit) => audit.action === 'KYB_CHECK_ATTEMPT_FAILED');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.meta).toMatchObject({ final: false });

      await expect(handle(id, 1)).resolves.toBe('completed');
      await expect(kybCheckRows(id)).resolves.toHaveLength(1);
    });

    it('final attempt, success transaction fails: UNDER_REVIEW / FAILED, never stuck in RISK_REVIEW', async () => {
      const id = await submittedApplication();
      const spy = failRecordOnceOn(AuditAction.KYB_CHECK_COMPLETED);
      try {
        await expect(handle(id, 4)).rejects.toThrow('audit write failed (test)');
      } finally {
        spy.mockRestore();
      }

      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'UNDER_REVIEW',
        kyb_status: 'FAILED',
        kyb_level: null,
        kyb_score: null,
      });
      await expect(kybCheckRows(id)).resolves.toEqual([]);
      const audits = await auditRows(id);
      const actions = audits.map((audit) => audit.action);
      expect(actions.filter((action) => action === 'KYB_CHECK_FAILED')).toHaveLength(1);
      expect(actions).not.toContain('KYB_CHECK_COMPLETED');
      const failed = audits.filter((audit) => audit.action === 'KYB_CHECK_ATTEMPT_FAILED');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.meta).toMatchObject({ final: true });
    });
  });

  describe('through Redis', () => {
    let queueEvents: QueueEvents;

    // Polls the job state until it equals `state`. Bounded: past `timeoutMs` it throws an error
    // naming the job and the last state seen (docs/adrs/testing.md: poll with a timeout).
    async function waitForState(job: Job, state: 'delayed', timeoutMs = 10000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      let last = await job.getState();
      while (last !== state) {
        if (Date.now() > deadline) {
          throw new Error(
            `job ${job.id ?? '?'} did not reach ${state} within ${timeoutMs} ms (last: ${last})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        last = await job.getState();
      }
    }

    async function requireJob(id: string): Promise<Job> {
      const job = await queue.getJob(kybCheckJobId(id, 1));
      if (job === undefined) {
        throw new Error('the submit did not enqueue a KYB job');
      }
      return job;
    }

    beforeAll(async () => {
      const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
      queueEvents = new QueueEvents(KYB_CHECK_QUEUE, {
        connection: kybQueueConnection({
          REDIS_HOST: config.get('REDIS_HOST', { infer: true }),
          REDIS_PORT: config.get('REDIS_PORT', { infer: true }),
        }),
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
      });
      await queueEvents.waitUntilReady();
      // Removes waiting and delayed jobs left by the handler cases, so the worker never picks
      // them up.
      await queue.drain(true);
      processor.startWorker();
    });

    afterAll(async () => {
      await processor.worker.close();
      await queueEvents.close();
    });

    it(
      'success: the job completes; a second enqueue of the same submission is a no-op',
      async () => {
        const id = await submittedApplication();
        const job = await requireJob(id);

        await expect(job.waitUntilFinished(queueEvents, 15000)).resolves.toBe('completed');

        await expect(applicationRow(id)).resolves.toMatchObject({ status: 'UNDER_REVIEW' });
        await expect(kybCheckBody(id)).resolves.toMatchObject({
          status: 'COMPLETED',
          attempts: 1,
        });

        const countsBefore = await queue.getJobCounts();
        await expect(app.get(KybCheckQueue).enqueue(id, 1)).resolves.toBe(true);
        await expect(queue.getJobCounts()).resolves.toEqual(countsBefore);
        await expect(kybCheckRows(id)).resolves.toHaveLength(1);
      },
      30000,
    );

    it(
      'retry, then success: the failed attempt is delayed by the backoff, the promoted retry completes',
      async () => {
        fake.failNext(1);
        const id = await submittedApplication();
        const job = await requireJob(id);

        await waitForState(job, 'delayed', 5000);
        await job.promote();
        await expect(job.waitUntilFinished(queueEvents, 15000)).resolves.toBe('completed');

        await expect(applicationRow(id)).resolves.toMatchObject({
          status: 'UNDER_REVIEW',
          kyb_status: 'COMPLETED',
          kyb_attempts: 2,
        });
        const kybAudits = (await auditRows(id)).filter((audit) => audit.action.startsWith('KYB_'));
        expect(kybAudits.map((audit) => [audit.action, audit.meta.attempt])).toEqual([
          ['KYB_CHECK_ATTEMPT_FAILED', 1],
          ['KYB_CHECK_COMPLETED', 2],
        ]);
        expect(kybAudits[0]?.meta.final).toBe(false);
      },
      30000,
    );

    it(
      'retries used up: BullMQ fails the job after the fifth attempt; UNDER_REVIEW / FAILED',
      async () => {
        fake.alwaysFail();
        const id = await submittedApplication();
        const job = await requireJob(id);

        for (let retry = 0; retry < 4; retry += 1) {
          await waitForState(job, 'delayed', 5000);
          await job.promote();
        }
        await expect(job.waitUntilFinished(queueEvents, 10000)).rejects.toThrow();
        await expect(job.getState()).resolves.toBe('failed');

        await expect(applicationRow(id)).resolves.toMatchObject({
          status: 'UNDER_REVIEW',
          kyb_status: 'FAILED',
          kyb_level: null,
          kyb_score: null,
          kyb_attempts: 5,
        });
        await expect(kybCheckRows(id)).resolves.toEqual([]);
        const kybAudits = (await auditRows(id)).filter((audit) => audit.action.startsWith('KYB_'));
        expect(kybAudits.map((audit) => [audit.action, audit.meta.attempt, audit.meta.final])).toEqual(
          [
            ['KYB_CHECK_ATTEMPT_FAILED', 1, false],
            ['KYB_CHECK_ATTEMPT_FAILED', 2, false],
            ['KYB_CHECK_ATTEMPT_FAILED', 3, false],
            ['KYB_CHECK_ATTEMPT_FAILED', 4, false],
            ['KYB_CHECK_ATTEMPT_FAILED', 5, true],
            ['KYB_CHECK_FAILED', undefined, undefined],
          ],
        );
        await expect(kybCheckBody(id)).resolves.toMatchObject({ status: 'FAILED', label: null });
      },
      60000,
    );
  });

  it('never logs a raw sensitive value or a token, across the whole spec', () => {
    const text = allCaptured.join('\n');
    // Positive check first, so the no-PII check cannot pass on silent output.
    expect(text).toContain(ATTEMPT_FAILED_MESSAGE);
    expectNoRawSecrets(text);
  });
});
