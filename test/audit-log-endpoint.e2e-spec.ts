import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { Queue } from 'bullmq';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { APPLICATION_NOT_FOUND_MESSAGE } from '../src/applications/applications.service';
import { AuditAction, AuditActorType } from '../src/audit/audit.enums';
import { AuditLogQueryService } from '../src/audit/audit-log-query.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { UserRole } from '../src/common/common.enums';
import { BCRYPT_COST } from '../src/common/password';
import { setupSwagger } from '../src/common/swagger';
import { KybCheckProcessor, KybJobLike, KybJobOutcome } from '../src/kyb/kyb-check.processor';
import { KYB_CHECK_QUEUE } from '../src/kyb/kyb-job';
import { KYB_PROVIDER } from '../src/kyb/kyb-provider';
import { FakeKybProvider } from '../src/kyb/testing/fake-kyb-provider';
import { configureLogger } from '../src/logging/logger';
import { UsersRepository } from '../src/users/users.repository';
import { resetApplicationData, resetTables } from './utils/test-db';

// GET /applications/:id/audit-logs end to end (docs/adrs/auth.md matrix, docs/adrs/database.md
// §`meta` columns, docs/adrs/sensitive-data.md, docs/adrs/testing.md) on real Postgres and Redis.
// The KYB worker is off (test-env.ts); the processor's handler is called directly with crafted
// jobs and the deterministic FakeKybProvider.
//
// Ordering rule: rows written in one transaction share `created_at`, so their relative order is
// never asserted (today: KYB_CHECK_ATTEMPT_FAILED and KYB_CHECK_FAILED of the final failure).

// Fake users only (@example.com, made-up names). Passwords come from the SEED_* env variables.
const SALES_EMAIL = 'auditlog-sales@example.com';
const REVIEWER_EMAIL = 'auditlog-reviewer@example.com';
const ADMIN_EMAIL = 'auditlog-admin@example.com';

// Fake application data. The sensitive values are asserted never to leave the database raw.
const RAW_TAX_ID = 'PAN-FAKE-00003579';
const RAW_TAX_ID_NEW = 'PAN-FAKE-00008642';
const RAW_NATIONAL_ID = 'NID-FAKE-2468';
const RAW_OWNER_EMAIL = 'auditlog-owner@example.com';
const RAW_OWNER_PHONE = '+977-0000000321';

// An obviously fake constant (not a real credential, not read from env): it is only stored in an
// audit row's meta to prove that a `password` key is redacted.
const FIXTURE_PASSWORD = 'fake-password-fixture';
// A wrong password for the failed-login case; obviously fake, never a real credential.
const WRONG_PASSWORD = 'fake-wrong-password';

const PAYLOAD = {
  businessName: 'Example Florist',
  legalBusinessName: 'Example Florist Pvt. Ltd.',
  businessType: 'PRIVATE_LIMITED',
  registrationNumber: 'REG-FAKE-0007',
  taxId: RAW_TAX_ID,
  ownerFullName: 'Kim Example',
  ownerEmail: RAW_OWNER_EMAIL,
  ownerPhone: RAW_OWNER_PHONE,
  ownerNationalId: RAW_NATIONAL_ID,
  merchantCategoryCode: '5992',
  websiteUrl: 'https://florist.example.com',
  expectedMonthlyVolumeMinor: 1500000,
  averageTicketSizeMinor: 90000,
};

const MASKED_TAX_ID = '••••••3579';
const MASKED_NATIONAL_ID = '••••••2468';
const MASKED_OWNER_EMAIL = 'a•••@example.com';
const MASKED_OWNER_PHONE = '••••••321';
const REDACTED = '[REDACTED]';

// A made-up UUID that never belongs to a row (the database generates v4 UUIDs).
const FAKE_UUID = '00000000-0000-4000-8000-000000000004';

// Every key of one audit-log item, in order.
const ITEM_KEYS = [
  'id',
  'action',
  'actorType',
  'actorId',
  'actorRole',
  'actorLabel',
  'createdAt',
  'meta',
];

const UNAUTHORIZED_BODY = { statusCode: 401, message: 'Unauthorized' };
const FORBIDDEN_BODY = { statusCode: 403, message: 'Forbidden' };
const NOT_FOUND_BODY = {
  statusCode: 404,
  error: 'Not Found',
  message: APPLICATION_NOT_FOUND_MESSAGE,
};

interface AuditItem {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorRole: string | null;
  actorLabel: string | null;
  createdAt: string;
  meta: Record<string, unknown>;
}

interface AuditListBody {
  items: AuditItem[];
  page: number;
  limit: number;
  total: number;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

// bcrypt cost 12: hashing the users and the logins take a noticeable time.
jest.setTimeout(60_000);

describe('ADMIN audit-log endpoint (e2e)', () => {
  const fake = new FakeKybProvider();
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let processor: KybCheckProcessor;
  let auditLogService: AuditLogService;
  let auditLogQueryService: AuditLogQueryService;
  let salesId: string;
  let reviewerId: string;
  let adminId: string;
  let salesPassword: string;
  let salesToken: string;
  let reviewerToken: string;
  let adminToken: string;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  // The logger prints through console.log / console.error, which Jest buffers per file, so the
  // stream spies alone would miss those lines.
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  // Every application response body of the current test (no login bodies), for the leak checks.
  let responseTexts: string[];

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
    // Before init, as in test/swagger.e2e-spec.ts, so /docs-json is served.
    setupSwagger(app, true);
    await app.init();
    dataSource = app.get(DataSource);
    processor = app.get(KybCheckProcessor);
    auditLogService = app.get(AuditLogService);
    auditLogQueryService = app.get(AuditLogQueryService);
    queue = app.get<Queue>(getQueueToken(KYB_CHECK_QUEUE));
    // Connected before the first submit, so it never races the connect into the enqueue timeout.
    await queue.waitUntilReady();

    // A missing variable fails here and names it. Each password is hashed once.
    const config = app.get(ConfigService);
    salesPassword = config.getOrThrow<string>('SEED_SALES_PASSWORD');
    const reviewerPassword = config.getOrThrow<string>('SEED_REVIEWER_PASSWORD');
    const adminPassword = config.getOrThrow<string>('SEED_ADMIN_PASSWORD');
    const salesHash = await bcrypt.hash(salesPassword, BCRYPT_COST);
    const reviewerHash = await bcrypt.hash(reviewerPassword, BCRYPT_COST);
    const adminHash = await bcrypt.hash(adminPassword, BCRYPT_COST);

    await resetTables(dataSource);
    const users = app.get(UsersRepository);
    const fixtures: Array<[string, string, UserRole, string]> = [
      [SALES_EMAIL, 'Kai Sales', UserRole.SALES, salesHash],
      [REVIEWER_EMAIL, 'Kit Reviewer', UserRole.REVIEWER, reviewerHash],
      [ADMIN_EMAIL, 'Kay Admin', UserRole.ADMIN, adminHash],
    ];
    for (const [email, fullName, role, passwordHash] of fixtures) {
      await users.insertIfAbsent({ email, fullName, role, passwordHash });
    }
    salesId = await userId(SALES_EMAIL);
    reviewerId = await userId(REVIEWER_EMAIL);
    adminId = await userId(ADMIN_EMAIL);

    salesToken = await loginToken(SALES_EMAIL, salesPassword);
    reviewerToken = await loginToken(REVIEWER_EMAIL, reviewerPassword);
    adminToken = await loginToken(ADMIN_EMAIL, adminPassword);
  });

  afterAll(async () => {
    // The queue prefix is unique to this run; this removes the jobs this spec enqueued.
    await queue.obliterate({ force: true });
    await app.close();
    configureLogger({ production: true });
    stdout.mockRestore();
    stderr.mockRestore();
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  beforeEach(async () => {
    // Keeps the users (and so the tokens); empties applications, KYB results and audit rows.
    await resetApplicationData(dataSource);
    fake.reset();
    responseTexts = [];
    stdout.mockClear();
    stderr.mockClear();
    consoleLog.mockClear();
    consoleError.mockClear();
  });

  function server(): App {
    return app.getHttpServer();
  }

  async function userId(email: string): Promise<string> {
    const rows: Array<{ id: string }> = await dataSource.query(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('test user was not inserted');
    }
    return id;
  }

  async function loginToken(email: string, password: string): Promise<string> {
    const res = await request(server()).post('/auth/login').send({ email, password }).expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  function track(res: request.Response): request.Response {
    responseTexts.push(JSON.stringify(res.body));
    return res;
  }

  function withToken(req: request.Test, token: string | undefined): request.Test {
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  }

  async function auditLogs(
    token: string | undefined,
    id: string,
    query = '',
  ): Promise<request.Response> {
    return track(
      await withToken(
        request(server()).get(`/applications/${encodeURIComponent(id)}/audit-logs${query}`),
        token,
      ),
    );
  }

  function listBody(res: request.Response): AuditListBody {
    return res.body as AuditListBody;
  }

  async function createDraft(): Promise<string> {
    const res = track(
      await withToken(request(server()).post('/applications'), salesToken).send(PAYLOAD),
    );
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  async function patch(id: string, body: object): Promise<void> {
    const res = track(
      await withToken(request(server()).patch(`/applications/${id}`), salesToken).send(body),
    );
    expect(res.status).toBe(200);
  }

  async function submit(id: string): Promise<void> {
    const res = track(
      await withToken(request(server()).post(`/applications/${id}/submit`), salesToken),
    );
    expect(res.status).toBe(200);
  }

  async function assign(id: string): Promise<void> {
    const res = track(
      await withToken(request(server()).post(`/applications/${id}/assign`), adminToken).send({
        reviewerId,
      }),
    );
    expect(res.status).toBe(200);
  }

  async function decide(id: string): Promise<void> {
    const res = track(
      await withToken(request(server()).post(`/applications/${id}/decision`), reviewerToken).send({
        decision: 'APPROVE',
      }),
    );
    expect(res.status).toBe(200);
  }

  function craftedJob(data: unknown, attemptsMade: number): KybJobLike {
    return { data, attemptsMade, opts: { attempts: 5 } };
  }

  function handle(id: string, attemptsMade = 0, submissionNo = 1): Promise<KybJobOutcome> {
    return processor.handle(craftedJob({ applicationId: id, submissionNo }, attemptsMade));
  }

  // Create, PATCH (with a new taxId), submit, KYB completed, assign, APPROVE.
  async function fullHistory(): Promise<string> {
    const id = await createDraft();
    await patch(id, { taxId: RAW_TAX_ID_NEW, businessName: 'Example Florist Two' });
    await submit(id);
    await expect(handle(id)).resolves.toBe('completed');
    await assign(id);
    await decide(id);
    return id;
  }

  // An application assigned to REVIEWER (UNDER_REVIEW, KYB completed).
  async function assignedApplication(): Promise<string> {
    const id = await createDraft();
    await submit(id);
    await expect(handle(id)).resolves.toBe('completed');
    await assign(id);
    return id;
  }

  async function idsFor(sql: string, params: unknown[]): Promise<string[]> {
    const rows: Array<{ id: string }> = await dataSource.query(sql, params);
    return rows.map((row) => row.id);
  }

  async function countFor(sql: string, params: unknown[]): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource.query(sql, params);
    return Number(rows[0]?.count ?? 0);
  }

  async function applicationAuditCount(id: string): Promise<number> {
    return countFor(
      `SELECT count(*) FROM audit_logs WHERE entity_type = 'merchant_application' AND entity_id = $1`,
      [id],
    );
  }

  async function auditSnapshot(): Promise<Array<{ id: string; meta: string }>> {
    return dataSource.query('SELECT id, meta::text AS meta FROM audit_logs ORDER BY id');
  }

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

  function rawValues(): string[] {
    return [
      RAW_TAX_ID,
      RAW_TAX_ID_NEW,
      RAW_NATIONAL_ID,
      RAW_OWNER_EMAIL,
      RAW_OWNER_PHONE,
      FIXTURE_PASSWORD,
      salesToken,
      reviewerToken,
      adminToken,
    ];
  }

  describe('ADMIN reads the history', () => {
    it('full history in order, 8 allowed keys per item, SYSTEM row with the worker label', async () => {
      const id = await fullHistory();

      const res = await auditLogs(adminToken, id);

      expect(res.status).toBe(200);
      const body = listBody(res);
      expect(body).toMatchObject({ page: 1, limit: 20, total: 6 });
      expect(body.items.map((item) => item.action)).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_UPDATED',
        'APPLICATION_SUBMITTED',
        'KYB_CHECK_COMPLETED',
        'REVIEWER_ASSIGNED',
        'DECISION_RECORDED',
      ]);
      const times = body.items.map((item) => Date.parse(item.createdAt));
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]).toBeGreaterThanOrEqual(times[index - 1] ?? Infinity);
      }
      for (const item of body.items) {
        expect(Object.keys(item)).toEqual(ITEM_KEYS);
      }
      const byAction = new Map(body.items.map((item) => [item.action, item]));
      expect(byAction.get('KYB_CHECK_COMPLETED')).toMatchObject({
        actorType: 'SYSTEM',
        actorLabel: 'kyb-worker',
        actorId: null,
        actorRole: null,
      });
      expect(byAction.get('APPLICATION_CREATED')).toMatchObject({
        actorType: 'USER',
        actorId: salesId,
        actorRole: 'SALES',
        actorLabel: null,
      });
      expect(byAction.get('REVIEWER_ASSIGNED')).toMatchObject({
        actorType: 'USER',
        actorId: adminId,
        actorRole: 'ADMIN',
      });
      expect(byAction.get('DECISION_RECORDED')).toMatchObject({
        actorType: 'USER',
        actorId: reviewerId,
        actorRole: 'REVIEWER',
      });
    });

    it('KYB final failure: both KYB_CHECK_ATTEMPT_FAILED (final) and KYB_CHECK_FAILED come after the earlier rows', async () => {
      const id = await createDraft();
      await submit(id);
      fake.alwaysFail();
      // Crafted jobs up to the last attempt (attemptsMade 4 of 5): the final failure writes
      // KYB_CHECK_ATTEMPT_FAILED and KYB_CHECK_FAILED in one transaction.
      for (let attemptsMade = 0; attemptsMade < 5; attemptsMade += 1) {
        await expect(handle(id, attemptsMade)).rejects.toThrow('Fake provider failure');
      }

      const res = await auditLogs(adminToken, id);

      expect(res.status).toBe(200);
      const items = listBody(res).items;
      expect(listBody(res).total).toBe(8);
      expect(items.slice(0, 2).map((item) => item.action)).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_SUBMITTED',
      ]);
      // Presence only after the earlier rows: the two rows of the final transaction share
      // created_at, so their relative order is not asserted.
      const later = items.slice(2);
      expect(later.map((item) => item.action).sort()).toEqual([
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_ATTEMPT_FAILED',
        'KYB_CHECK_FAILED',
      ]);
      const finalAttempt = later.filter(
        (item) => item.action === 'KYB_CHECK_ATTEMPT_FAILED' && item.meta.final === true,
      );
      expect(finalAttempt).toHaveLength(1);
      for (const item of later) {
        expect(item).toMatchObject({
          actorType: 'SYSTEM',
          actorLabel: 'kyb-worker',
          actorId: null,
          actorRole: null,
        });
      }
    });

    it('masked meta: a record() row and a raw SQL row (bypassing record) both come back masked', async () => {
      const id = await createDraft();
      await auditLogService.record({
        actorType: AuditActorType.USER,
        actorId: adminId,
        actorRole: UserRole.ADMIN,
        action: AuditAction.APPLICATION_UPDATED,
        entityType: 'merchant_application',
        entityId: id,
        meta: { taxId: RAW_TAX_ID, ownerEmail: RAW_OWNER_EMAIL, password: FIXTURE_PASSWORD },
      });
      // Test-only raw insert that skips record(), so the stored meta is raw. resetApplicationData
      // empties audit_logs before the next test.
      const inserted: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO audit_logs (actor_type, actor_label, action, entity_type, entity_id, meta)
         VALUES ('SYSTEM', 'kyb-worker', 'KYB_CHECK_COMPLETED', 'merchant_application', $1, $2::jsonb)
         RETURNING id`,
        [id, JSON.stringify({ taxId: RAW_TAX_ID, ownerNationalId: RAW_NATIONAL_ID })],
      );
      const rawRowId = inserted[0]?.id;
      expect(rawRowId).toBeDefined();

      const res = await auditLogs(adminToken, id);

      expect(res.status).toBe(200);
      const items = listBody(res).items;
      const recorded = items.find((item) => item.action === 'APPLICATION_UPDATED');
      expect(recorded?.meta).toEqual({
        taxId: MASKED_TAX_ID,
        ownerEmail: MASKED_OWNER_EMAIL,
        password: REDACTED,
      });
      const raw = items.find((item) => item.id === rawRowId);
      expect(raw?.meta).toEqual({ taxId: MASKED_TAX_ID, ownerNationalId: MASKED_NATIONAL_ID });
      const text = JSON.stringify(res.body);
      for (const value of [RAW_TAX_ID, RAW_NATIONAL_ID, RAW_OWNER_EMAIL, FIXTURE_PASSWORD]) {
        expect(text).not.toContain(value);
      }
    });

    it('a raw SQL SYSTEM row with an unknown actor_label comes back with actorLabel null', async () => {
      const id = await createDraft();
      const unknownLabel = `manual-fix ${RAW_OWNER_EMAIL}`;
      // Test-only raw insert that skips record(); resetApplicationData empties audit_logs later.
      const inserted: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO audit_logs (actor_type, actor_label, action, entity_type, entity_id, meta)
         VALUES ('SYSTEM', $2, 'KYB_CHECK_COMPLETED', 'merchant_application', $1, '{}'::jsonb)
         RETURNING id`,
        [id, unknownLabel],
      );
      const rawRowId = inserted[0]?.id;
      expect(rawRowId).toBeDefined();

      const res = await auditLogs(adminToken, id);

      expect(res.status).toBe(200);
      const raw = listBody(res).items.find((item) => item.id === rawRowId);
      expect(raw?.actorType).toBe('SYSTEM');
      expect(raw?.actorLabel).toBeNull();
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(unknownLabel);
      expect(text).not.toContain(RAW_OWNER_EMAIL);
    });
  });

  describe('pagination and validation', () => {
    async function applicationWith25Rows(): Promise<string> {
      // One APPLICATION_CREATED row plus 24 rows through record(): 25 in total.
      const id = await createDraft();
      for (let seq = 1; seq <= 24; seq += 1) {
        await auditLogService.record({
          actorType: AuditActorType.USER,
          actorId: salesId,
          actorRole: UserRole.SALES,
          action: AuditAction.APPLICATION_UPDATED,
          entityType: 'merchant_application',
          entityId: id,
          meta: { seq },
        });
      }
      return id;
    }

    it('pages are disjoint and together match ORDER BY created_at, id; out-of-range pages are empty', async () => {
      const id = await applicationWith25Rows();

      const first = await auditLogs(adminToken, id);
      expect(first.status).toBe(200);
      expect(listBody(first)).toMatchObject({ page: 1, limit: 20, total: 25 });
      expect(listBody(first).items).toHaveLength(20);

      const second = await auditLogs(adminToken, id, '?page=2&limit=20');
      expect(second.status).toBe(200);
      expect(listBody(second)).toMatchObject({ page: 2, limit: 20, total: 25 });
      expect(listBody(second).items).toHaveLength(5);

      const firstIds = listBody(first).items.map((item) => item.id);
      const secondIds = listBody(second).items.map((item) => item.id);
      expect(firstIds.filter((itemId) => secondIds.includes(itemId))).toEqual([]);
      const expected = await idsFor(
        `SELECT id FROM audit_logs WHERE entity_type = 'merchant_application' AND entity_id = $1
          ORDER BY created_at, id`,
        [id],
      );
      expect([...firstIds, ...secondIds]).toEqual(expected);

      const all = await auditLogs(adminToken, id, '?limit=100');
      expect(all.status).toBe(200);
      expect(listBody(all).items).toHaveLength(25);

      const beyond = await auditLogs(adminToken, id, '?page=999&limit=20');
      expect(beyond.status).toBe(200);
      expect(listBody(beyond)).toEqual({ items: [], page: 999, limit: 20, total: 25 });
    });

    it.each<string>([
      '?limit=101',
      '?limit=0',
      '?page=0',
      '?page=10001',
      '?limit=abc',
      '?entityType=user',
      '?status=DRAFT',
    ])('%s → 400', async (query) => {
      const id = await createDraft();

      const res = await auditLogs(adminToken, id, query);

      expect(res.status).toBe(400);
    });
  });

  describe('denied', () => {
    it.each<[string, () => string]>([
      ['the assigned REVIEWER', () => reviewerToken],
      ['the SALES owner', () => salesToken],
    ])('%s gets 403 and no audit read is attempted', async (_label, token) => {
      const id = await assignedApplication();
      const spy = jest.spyOn(auditLogQueryService, 'findApplicationHistoryPage');
      try {
        const res = await auditLogs(token(), id);

        expect(res.status).toBe(403);
        expect(res.body).toEqual(FORBIDDEN_BODY);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('no token → 401', async () => {
      const id = await createDraft();

      const res = await auditLogs(undefined, id);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    });

    it('a tampered token (REVIEWER re-encoded as ADMIN) → 401', async () => {
      const id = await createDraft();
      const [header, payload, signature] = reviewerToken.split('.');
      const tampered = [
        header,
        base64UrlJson({ ...decodeSegment(payload), role: 'ADMIN' }),
        signature,
      ].join('.');

      const res = await auditLogs(tampered, id);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    });

    it.each<string>([FAKE_UUID, 'not-a-uuid', "1' OR '1'='1"])(
      'unknown or malformed id %s → 404 with the shared body, no audit read',
      async (id) => {
        await createDraft();
        const spy = jest.spyOn(auditLogQueryService, 'findApplicationHistoryPage');
        try {
          const res = await auditLogs(adminToken, id);

          expect(res.status).toBe(404);
          expect(res.body).toEqual(NOT_FOUND_BODY);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  describe('isolation', () => {
    it("returns only application A's rows; B's rows never appear", async () => {
      const a = await createDraft();
      await patch(a, { businessName: 'Example Florist A' });
      const b = await createDraft();
      await patch(b, { businessName: 'Example Florist B' });
      await submit(b);

      const res = await auditLogs(adminToken, a);

      expect(res.status).toBe(200);
      const returned = listBody(res).items.map((item) => item.id);
      const aIds = await idsFor('SELECT id FROM audit_logs WHERE entity_id = $1', [a]);
      const bIds = await idsFor('SELECT id FROM audit_logs WHERE entity_id = $1', [b]);
      expect(bIds.length).toBeGreaterThan(0);
      for (const itemId of returned) {
        expect(aIds).toContain(itemId);
        expect(bIds).not.toContain(itemId);
      }
      expect(listBody(res).total).toBe(await applicationAuditCount(a));
      expect(listBody(res).total).toBe(2);
    });

    it('user rows (LOGIN_*) are excluded, even one whose entity_id is the application id', async () => {
      const a = await createDraft();
      // Fresh logins inside the test (beforeEach emptied audit_logs).
      await loginToken(SALES_EMAIL, salesPassword);
      await request(server())
        .post('/auth/login')
        .send({ email: SALES_EMAIL, password: WRONG_PASSWORD })
        .expect(401);
      // A `user` row pointing at A's id proves the entity_type filter, not only entity_id.
      await auditLogService.record({
        actorType: AuditActorType.USER,
        actorId: salesId,
        actorRole: UserRole.SALES,
        action: AuditAction.LOGIN_SUCCEEDED,
        entityType: 'user',
        entityId: a,
      });
      const userRows: Array<{ id: string; action: string; entity_id: string | null }> =
        await dataSource.query(
          `SELECT id, action, entity_id FROM audit_logs WHERE entity_type = 'user'`,
        );
      expect(userRows.map((row) => row.action).sort()).toEqual([
        'LOGIN_FAILED',
        'LOGIN_SUCCEEDED',
        'LOGIN_SUCCEEDED',
      ]);
      expect(userRows.some((row) => row.entity_id === a)).toBe(true);

      const res = await auditLogs(adminToken, a);

      expect(res.status).toBe(200);
      const items = listBody(res).items;
      const userRowIds = userRows.map((row) => row.id);
      for (const item of items) {
        expect(userRowIds).not.toContain(item.id);
        expect(['LOGIN_SUCCEEDED', 'LOGIN_FAILED']).not.toContain(item.action);
      }
      const applicationOnly = await applicationAuditCount(a);
      const anyEntityType = await countFor('SELECT count(*) FROM audit_logs WHERE entity_id = $1', [
        a,
      ]);
      expect(listBody(res).total).toBe(applicationOnly);
      expect(applicationOnly).toBeLessThan(anyEntityType);
    });
  });

  it('append-only: the GETs never write (row count and every meta unchanged)', async () => {
    const id = await fullHistory();
    const before = await auditSnapshot();

    await auditLogs(adminToken, id);
    await auditLogs(adminToken, id, '?page=2&limit=2');
    await auditLogs(reviewerToken, id);
    await auditLogs(adminToken, FAKE_UUID);

    await expect(auditSnapshot()).resolves.toEqual(before);
  });

  it('leak check: no raw sensitive value or token in application responses, logs or audit rows; masked meta present', async () => {
    const id = await fullHistory();
    await auditLogService.record({
      actorType: AuditActorType.USER,
      actorId: adminId,
      actorRole: UserRole.ADMIN,
      action: AuditAction.APPLICATION_UPDATED,
      entityType: 'merchant_application',
      entityId: id,
      meta: {
        taxId: RAW_TAX_ID,
        ownerNationalId: RAW_NATIONAL_ID,
        ownerEmail: RAW_OWNER_EMAIL,
        ownerPhone: RAW_OWNER_PHONE,
        password: FIXTURE_PASSWORD,
      },
    });
    // 200, 403, 404 and 400 bodies.
    const ok = await auditLogs(adminToken, id);
    await auditLogs(reviewerToken, id);
    await auditLogs(adminToken, FAKE_UUID);
    await auditLogs(adminToken, id, '?limit=101');

    expect(ok.status).toBe(200);
    const recorded = listBody(ok).items.find(
      (item) => item.actorId === adminId && 'password' in item.meta,
    );
    expect(recorded?.meta).toEqual({
      taxId: MASKED_TAX_ID,
      ownerNationalId: MASKED_NATIONAL_ID,
      ownerEmail: MASKED_OWNER_EMAIL,
      ownerPhone: MASKED_OWNER_PHONE,
      password: REDACTED,
    });

    const responses = responseTexts.join('\n');
    const logs = capturedText();
    const audits = JSON.stringify(await dataSource.query('SELECT * FROM audit_logs'));
    for (const value of rawValues()) {
      expect(responses).not.toContain(value);
      expect(logs).not.toContain(value);
      expect(audits).not.toContain(value);
    }
    expect(responses).not.toContain('passwordHash');
    expect(logs).not.toContain('Bearer ');
  });

  it('Swagger documents 200, 400, 401, 403 and 404 for the route', async () => {
    const res = await request(server()).get('/docs-json').expect(200);

    const body = res.body as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const responses = body.paths['/applications/{id}/audit-logs']?.get?.responses ?? {};
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404']),
    );
  });
});
