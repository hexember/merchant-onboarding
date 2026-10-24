import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { Queue } from 'bullmq';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, UpdateQueryBuilder } from 'typeorm';
import { AppModule } from '../src/app.module';
import {
  APPLICATION_NOT_FOUND_MESSAGE,
  CONCURRENT_MODIFICATION_CODE,
  CONCURRENT_MODIFICATION_MESSAGE,
  INVALID_STATE_TRANSITION_CODE,
  NOT_ASSIGNABLE_MESSAGE,
  NOT_EDITABLE_MESSAGE,
  NOT_SUBMITTABLE_MESSAGE,
  NOT_TRANSFERABLE_MESSAGE,
  REVIEWER_NOT_REVIEWER_MESSAGE,
  SALES_OWNER_NOT_SALES_MESSAGE,
  SALES_OWNER_REQUIRED_MESSAGE,
} from '../src/applications/applications.service';
import { ApplicationsRepository } from '../src/applications/applications.repository';
import { AuditLogService } from '../src/audit/audit-log.service';
import { UserRole } from '../src/common/common.enums';
import { BCRYPT_COST } from '../src/common/password';
import { setupSwagger } from '../src/common/swagger';
import { KYB_CHECK_QUEUE, kybCheckJobId } from '../src/kyb/kyb-job';
import { configureLogger } from '../src/logging/logger';
import { UsersRepository } from '../src/users/users.repository';
import { resetApplicationData, resetTables } from './utils/test-db';

// Fake users only (@example.com, made-up names). Passwords come from the SEED_* env variables.
const SALES_A_EMAIL = 'sales-a@example.com';
const SALES_B_EMAIL = 'sales-b@example.com';
const REVIEWER_EMAIL = 'reviewer@example.com';
const REVIEWER_2_EMAIL = 'reviewer-2@example.com';
const ADMIN_EMAIL = 'admin@example.com';

// Fake application data. The sensitive values are asserted never to leave the database raw.
const RAW_TAX_ID = 'PAN-FAKE-00001234';
const RAW_NATIONAL_ID = 'NID-FAKE-5678';
const RAW_OWNER_EMAIL = 'owner@example.com';
const RAW_OWNER_PHONE = '+977-0000000123';

const PAYLOAD = {
  businessName: 'Example Grocers',
  legalBusinessName: 'Example Grocers Pvt. Ltd.',
  businessType: 'PRIVATE_LIMITED',
  registrationNumber: 'REG-FAKE-0001',
  taxId: RAW_TAX_ID,
  ownerFullName: 'Jane Example',
  ownerEmail: RAW_OWNER_EMAIL,
  ownerPhone: RAW_OWNER_PHONE,
  ownerNationalId: RAW_NATIONAL_ID,
  merchantCategoryCode: '5411',
  websiteUrl: 'https://shop.example.com',
  expectedMonthlyVolumeMinor: 2500000,
  averageTicketSizeMinor: 150000,
};

// A made-up UUID that never belongs to a row (the database generates v4 UUIDs).
const FAKE_UUID = '00000000-0000-4000-8000-000000000001';

const MASKED = {
  taxId: '••••••1234',
  ownerNationalId: '••••••5678',
  ownerEmail: 'o•••@example.com',
  ownerPhone: '••••••123',
};

// Every key of the response, in order. No meta, version, KYB fields or relations.
const RESPONSE_KEYS = [
  'id',
  'createdById',
  'salesOwnerId',
  'assignedReviewerId',
  'businessName',
  'legalBusinessName',
  'businessType',
  'registrationNumber',
  'taxId',
  'ownerFullName',
  'ownerEmail',
  'ownerPhone',
  'ownerNationalId',
  'merchantCategoryCode',
  'websiteUrl',
  'expectedMonthlyVolumeMinor',
  'averageTicketSizeMinor',
  'currency',
  'status',
  'decisionNote',
  'submittedAt',
  'decidedAt',
  'createdAt',
  'updatedAt',
];

// GET /applications/:id adds the kybCheck block (docs/adrs/workflow.md §1.4); no other response does.
const DETAIL_RESPONSE_KEYS = [...RESPONSE_KEYS, 'kybCheck'];

const ENQUEUE_FAILED_MESSAGE = 'KYB check could not be enqueued; application stays in RISK_REVIEW';

// The SET clause (SQL text before WHERE) of the single SUBMIT UPDATE TypeORM builds: one version
// and one updated_at assignment, no auto-added ones.
const SUBMIT_SET_CLAUSE =
  'UPDATE "merchant_applications" SET "status" = $1, "kyb_status" = $2, "kyb_level" = $3, ' +
  '"kyb_score" = $4, "kyb_attempts" = $5, "kyb_last_attempt_at" = $6, ' +
  '"submission_count" = "submission_count" + 1, "submitted_at" = now(), ' +
  '"version" = "version" + 1, "updated_at" = now()';

const UNAUTHORIZED_BODY = { statusCode: 401, message: 'Unauthorized' };
const FORBIDDEN_BODY = { statusCode: 403, message: 'Forbidden' };
const INTERNAL_ERROR_BODY = { statusCode: 500, message: 'Internal server error' };
const NOT_FOUND_BODY = {
  statusCode: 404,
  error: 'Not Found',
  message: APPLICATION_NOT_FOUND_MESSAGE,
};
const NOT_EDITABLE_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: NOT_EDITABLE_MESSAGE,
  code: INVALID_STATE_TRANSITION_CODE,
};
const NOT_SUBMITTABLE_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: NOT_SUBMITTABLE_MESSAGE,
  code: INVALID_STATE_TRANSITION_CODE,
};
const NOT_ASSIGNABLE_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: NOT_ASSIGNABLE_MESSAGE,
  code: INVALID_STATE_TRANSITION_CODE,
};
const NOT_TRANSFERABLE_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: NOT_TRANSFERABLE_MESSAGE,
  code: INVALID_STATE_TRANSITION_CODE,
};
const CONCURRENT_MODIFICATION_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: CONCURRENT_MODIFICATION_MESSAGE,
  code: CONCURRENT_MODIFICATION_CODE,
};
const REVIEWER_NOT_REVIEWER_BODY = {
  statusCode: 400,
  error: 'Bad Request',
  message: REVIEWER_NOT_REVIEWER_MESSAGE,
};
const SALES_OWNER_NOT_SALES_BODY = {
  statusCode: 400,
  error: 'Bad Request',
  message: SALES_OWNER_NOT_SALES_MESSAGE,
};

interface ApplicationBody {
  id: string;
  createdById: string;
  salesOwnerId: string;
  assignedReviewerId: string | null;
  businessName: string;
  websiteUrl: string | null;
  status: string;
  submittedAt: string | null;
  taxId: string;
  ownerNationalId: string;
  ownerEmail: string;
  ownerPhone: string;
  expectedMonthlyVolumeMinor: number;
  averageTicketSizeMinor: number;
  currency: string;
}

interface KybCheckBody {
  status: string;
  level: string | null;
  label: string | null;
  score: number | null;
  attempts: number;
  lastAttemptAt: string | null;
}

interface DetailBody extends ApplicationBody {
  kybCheck: KybCheckBody;
}

interface ListBody {
  items: ApplicationBody[];
  page: number;
  limit: number;
  total: number;
}

interface ApplicationRow {
  business_name: string;
  website_url: string | null;
  status: string;
  version: number;
  tax_id: string;
  sales_owner_id: string;
  assigned_reviewer_id: string | null;
  kyb_status: string;
  kyb_level: string | null;
  kyb_score: number | null;
  kyb_attempts: number;
  kyb_last_attempt_at: Date | null;
  submission_count: number;
  submitted_at: Date | null;
}

// Optional columns `forceState` can set. Each maps to its own parameterised test-only UPDATE.
interface ForcedState {
  status?: string;
  assignedReviewerId?: string | null;
  kybStatus?: string;
  kybLevel?: string | null;
  kybScore?: number | null;
  kybAttempts?: number;
  kybLastAttemptAt?: Date | null;
  submissionCount?: number;
}

// Fixed column names only: the values always go in as parameters.
const FORCED_COLUMNS: ReadonlyArray<[keyof ForcedState, string]> = [
  ['status', 'status'],
  ['assignedReviewerId', 'assigned_reviewer_id'],
  ['kybStatus', 'kyb_status'],
  ['kybLevel', 'kyb_level'],
  ['kybScore', 'kyb_score'],
  ['kybAttempts', 'kyb_attempts'],
  ['kybLastAttemptAt', 'kyb_last_attempt_at'],
  ['submissionCount', 'submission_count'],
];

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
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

describe('Applications (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let salesAId: string;
  let salesBId: string;
  let reviewerId: string;
  let reviewer2Id: string;
  let adminId: string;
  let salesAToken: string;
  let salesBToken: string;
  let reviewerToken: string;
  let reviewer2Token: string;
  let adminToken: string;
  let queue: Queue;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  // The logger prints through console.log / console.error, which Jest buffers per file, so the
  // stream spies alone would miss those lines.
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  // Every response body of the current test, for the leak checks.
  let responseTexts: string[];

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Logger on, after every spy is installed, so the log checks below see real output.
    configureLogger({ production: false });
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<INestApplication<App>>();
    setupSwagger(app, true);
    await app.init();
    dataSource = app.get(DataSource);
    queue = app.get<Queue>(getQueueToken(KYB_CHECK_QUEUE));
    // Connected before the first submit, so it never races the connect into the enqueue timeout.
    await queue.waitUntilReady();

    // A missing variable fails here and names it. Each password is hashed once.
    const config = app.get(ConfigService);
    const salesPassword = config.getOrThrow<string>('SEED_SALES_PASSWORD');
    const reviewerPassword = config.getOrThrow<string>('SEED_REVIEWER_PASSWORD');
    const adminPassword = config.getOrThrow<string>('SEED_ADMIN_PASSWORD');
    const salesHash = await bcrypt.hash(salesPassword, BCRYPT_COST);
    const reviewerHash = await bcrypt.hash(reviewerPassword, BCRYPT_COST);
    const adminHash = await bcrypt.hash(adminPassword, BCRYPT_COST);

    await resetTables(dataSource);
    const users = app.get(UsersRepository);
    const fixtures: Array<[string, string, UserRole, string]> = [
      [SALES_A_EMAIL, 'Sam Sales', UserRole.SALES, salesHash],
      [SALES_B_EMAIL, 'Sky Sales', UserRole.SALES, salesHash],
      [REVIEWER_EMAIL, 'Robin Reviewer', UserRole.REVIEWER, reviewerHash],
      [REVIEWER_2_EMAIL, 'Riley Reviewer', UserRole.REVIEWER, reviewerHash],
      [ADMIN_EMAIL, 'Alex Admin', UserRole.ADMIN, adminHash],
    ];
    for (const [email, fullName, role, passwordHash] of fixtures) {
      await users.insertIfAbsent({ email, fullName, role, passwordHash });
    }
    salesAId = await userId(SALES_A_EMAIL);
    salesBId = await userId(SALES_B_EMAIL);
    reviewerId = await userId(REVIEWER_EMAIL);
    reviewer2Id = await userId(REVIEWER_2_EMAIL);
    adminId = await userId(ADMIN_EMAIL);

    salesAToken = await loginToken(SALES_A_EMAIL, salesPassword);
    salesBToken = await loginToken(SALES_B_EMAIL, salesPassword);
    reviewerToken = await loginToken(REVIEWER_EMAIL, reviewerPassword);
    reviewer2Token = await loginToken(REVIEWER_2_EMAIL, reviewerPassword);
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
    // Keeps the users (and so the tokens); empties applications and audit rows.
    await resetApplicationData(dataSource);
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

  async function post(token: string | undefined, body: object): Promise<request.Response> {
    const req = request(server()).post('/applications');
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return track(await req.send(body));
  }

  async function get(token: string | undefined, path: string): Promise<request.Response> {
    const req = request(server()).get(path);
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return track(await req);
  }

  async function patch(token: string, id: string, body: object): Promise<request.Response> {
    return track(
      await request(server())
        .patch(`/applications/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    );
  }

  async function submit(token: string | undefined, id: string): Promise<request.Response> {
    const req = request(server()).post(`/applications/${id}/submit`);
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return track(await req);
  }

  async function assign(
    token: string | undefined,
    id: string,
    body: object,
  ): Promise<request.Response> {
    const req = request(server()).post(`/applications/${id}/assign`);
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return track(await req.send(body));
  }

  async function transferOwner(
    token: string | undefined,
    id: string,
    body: object,
  ): Promise<request.Response> {
    const req = request(server()).post(`/applications/${id}/transfer-owner`);
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return track(await req.send(body));
  }

  async function createAs(token: string, extra: object = {}): Promise<ApplicationBody> {
    const res = await post(token, { ...PAYLOAD, ...extra });
    expect(res.status).toBe(201);
    return res.body as ApplicationBody;
  }

  // Test-only SQL: puts a row into a state the API cannot reach in this spec. The assign endpoint
  // exists, but UNDER_REVIEW and the terminal statuses need the KYB worker (off here) or the
  // decision endpoint (not built yet), e.g. a finished KYB result before a resubmit.
  async function forceState(id: string, state: ForcedState): Promise<void> {
    for (const [key, column] of FORCED_COLUMNS) {
      const value = state[key];
      if (value !== undefined) {
        await dataSource.query(`UPDATE merchant_applications SET ${column} = $1 WHERE id = $2`, [
          value,
          id,
        ]);
      }
    }
  }

  async function applicationRow(id: string): Promise<ApplicationRow | undefined> {
    const rows: ApplicationRow[] = await dataSource.query(
      `SELECT business_name, website_url, status, version, tax_id, sales_owner_id,
              assigned_reviewer_id, kyb_status, kyb_level, kyb_score, kyb_attempts,
              kyb_last_attempt_at, submission_count, submitted_at
         FROM merchant_applications WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function submittedAuditCount(): Promise<number> {
    return (await auditRows()).filter((row) => row.action === 'APPLICATION_SUBMITTED').length;
  }

  // Captures the SQL text of every UPDATE on merchant_applications built while `run` executes.
  async function capturingUpdates<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; updates: string[] }> {
    const sqlSpy = jest.spyOn(UpdateQueryBuilder.prototype, 'getQueryAndParameters');
    try {
      const result = await run();
      // Read before mockRestore, which also clears the recorded results.
      const updates = sqlSpy.mock.results
        .map((entry) => (entry.value as [string, unknown[]])[0])
        .filter((sql) => sql.includes('"merchant_applications"'));
      return { result, updates };
    } finally {
      sqlSpy.mockRestore();
    }
  }

  async function applicationCount(): Promise<number> {
    const rows: Array<{ count: number }> = await dataSource.query(
      'SELECT count(*)::int AS count FROM merchant_applications',
    );
    return rows[0]?.count ?? -1;
  }

  async function auditRows(): Promise<AuditRow[]> {
    return dataSource.query(
      'SELECT actor_type, actor_id, actor_role, action, entity_type, entity_id, meta FROM audit_logs ORDER BY created_at',
    );
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

  function expectMasked(body: ApplicationBody, keys: string[] = RESPONSE_KEYS): void {
    expect(body).toMatchObject(MASKED);
    expect(Object.keys(body)).toEqual(keys);
  }

  // The KYB job for one submission, or undefined when none was enqueued.
  async function kybJob(id: string, submissionNo: number): Promise<unknown> {
    return queue.getJob(kybCheckJobId(id, submissionNo));
  }

  async function expectNoKybJob(id: string): Promise<void> {
    for (const n of [1, 2]) {
      await expect(kybJob(id, n)).resolves.toBeUndefined();
    }
  }

  describe('POST /applications', () => {
    it('SALES creates a DRAFT they own: masked body, raw row, one audit row', async () => {
      const body = await createAs(salesAToken);

      expectMasked(body);
      expect(body).toMatchObject({
        createdById: salesAId,
        salesOwnerId: salesAId,
        assignedReviewerId: null,
        status: 'DRAFT',
        currency: 'NPR',
        expectedMonthlyVolumeMinor: 2500000,
        averageTicketSizeMinor: 150000,
      });
      expect(body).not.toHaveProperty('meta');
      expect(body).not.toHaveProperty('version');
      await expect(applicationRow(body.id)).resolves.toMatchObject({
        tax_id: RAW_TAX_ID,
        version: 1,
        status: 'DRAFT',
      });
      const audits = await auditRows();
      expect(audits).toEqual([
        {
          actor_type: 'USER',
          actor_id: salesAId,
          actor_role: 'SALES',
          action: 'APPLICATION_CREATED',
          entity_type: 'merchant_application',
          entity_id: body.id,
          meta: { status: 'DRAFT', salesOwnerId: salesAId },
        },
      ]);
    });

    it('ADMIN creates for SALES B: B can read it, A gets 404', async () => {
      const body = await createAs(adminToken, { salesOwnerId: salesBId });

      expect(body).toMatchObject({ createdById: adminId, salesOwnerId: salesBId });
      await expect(applicationRow(body.id)).resolves.toMatchObject({ sales_owner_id: salesBId });
      expect((await get(salesBToken, `/applications/${body.id}`)).status).toBe(200);
      const denied = await get(salesAToken, `/applications/${body.id}`);
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(NOT_FOUND_BODY);
      expect((await auditRows()).map((row) => [row.action, row.actor_role])).toEqual([
        ['APPLICATION_CREATED', 'ADMIN'],
      ]);
    });

    it.each<[string, (ids: { own: string; other: string }) => unknown]>([
      ['its own id', (ids) => ids.own],
      ["another SALES user's id", (ids) => ids.other],
      ['null', () => null],
      ["'not-a-uuid'", () => 'not-a-uuid'],
    ])('denied: SALES sending salesOwnerId as %s gets 403, no row, no audit', async (_l, value) => {
      const res = await post(salesAToken, {
        ...PAYLOAD,
        salesOwnerId: value({ own: salesAId, other: salesBId }),
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      await expect(applicationCount()).resolves.toBe(0);
      await expect(auditRows()).resolves.toEqual([]);
    });

    it('denied: REVIEWER gets 403', async () => {
      const res = await post(reviewerToken, PAYLOAD);

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      await expect(applicationCount()).resolves.toBe(0);
    });

    it.each<[string, (ids: { reviewer: string }) => Record<string, unknown>, string]>([
      ['no salesOwnerId', () => ({}), SALES_OWNER_REQUIRED_MESSAGE],
      ['salesOwnerId null', () => ({ salesOwnerId: null }), SALES_OWNER_REQUIRED_MESSAGE],
      [
        "salesOwnerId 'not-a-uuid'",
        () => ({ salesOwnerId: 'not-a-uuid' }),
        SALES_OWNER_NOT_SALES_MESSAGE,
      ],
      [
        "the reviewer's id",
        (ids) => ({ salesOwnerId: ids.reviewer }),
        SALES_OWNER_NOT_SALES_MESSAGE,
      ],
      ['an unknown UUID', () => ({ salesOwnerId: FAKE_UUID }), SALES_OWNER_NOT_SALES_MESSAGE],
    ])('denied: ADMIN with %s gets 400, no row, no audit', async (_l, extra, message) => {
      const res = await post(adminToken, { ...PAYLOAD, ...extra({ reviewer: reviewerId }) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ statusCode: 400, error: 'Bad Request', message });
      await expect(applicationCount()).resolves.toBe(0);
      await expect(auditRows()).resolves.toEqual([]);
    });

    it.each<[string, unknown]>([
      ['createdById', FAKE_UUID],
      ['status', 'APPROVED'],
      ['kybStatus', 'COMPLETED'],
      ['kybLevel', 'LOW'],
      ['kybScore', 10],
      ['assignedReviewerId', FAKE_UUID],
      ['version', 5],
      ['meta', { source: 'test' }],
    ])('denied: mass-assignment of %s gets 400 and no row', async (key, value) => {
      const res = await post(salesAToken, { ...PAYLOAD, [key]: value });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(JSON.stringify(res.body)).toContain(`property ${key} should not exist`);
      await expect(applicationCount()).resolves.toBe(0);
      await expect(auditRows()).resolves.toEqual([]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['an invalid MCC', { merchantCategoryCode: '54a1' }],
      ['a negative amount', { expectedMonthlyVolumeMinor: -1 }],
    ])('denied: %s gets 400 and no row', async (_l, extra) => {
      const res = await post(salesAToken, { ...PAYLOAD, ...extra });

      expect(res.status).toBe(400);
      await expect(applicationCount()).resolves.toBe(0);
    });

    it('denied: no token gets 401', async () => {
      const res = await post(undefined, PAYLOAD);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationCount()).resolves.toBe(0);
    });

    it('denied: a tampered token (role re-encoded as ADMIN) gets 401', async () => {
      const [header, payload, signature] = salesAToken.split('.');
      const tampered = [
        header,
        base64UrlJson({ ...decodeSegment(payload), role: 'ADMIN' }),
        signature,
      ].join('.');

      const res = await post(tampered, { ...PAYLOAD, salesOwnerId: salesBId });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationCount()).resolves.toBe(0);
    });
  });

  describe('GET /applications', () => {
    it('SALES sees only their own rows; total counts only theirs; items are masked', async () => {
      const a1 = await createAs(salesAToken);
      const a2 = await createAs(salesAToken);
      await createAs(salesBToken);

      const res = await get(salesAToken, '/applications');

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body).toMatchObject({ page: 1, limit: 20, total: 2 });
      expect(body.items.map((item) => item.id)).toEqual([a2.id, a1.id]);
      body.items.forEach((item) => expectMasked(item));
    });

    it('REVIEWER sees only rows assigned to them; another reviewer sees none', async () => {
      const assigned = await createAs(salesAToken);
      await createAs(salesBToken);
      await forceState(assigned.id, { status: 'UNDER_REVIEW', assignedReviewerId: reviewerId });

      const mine = (await get(reviewerToken, '/applications')).body as ListBody;
      const other = (await get(reviewer2Token, '/applications')).body as ListBody;

      expect(mine.total).toBe(1);
      expect(mine.items.map((item) => item.id)).toEqual([assigned.id]);
      expect(other).toEqual({ items: [], page: 1, limit: 20, total: 0 });
    });

    it('ADMIN sees all rows, can filter by status and page', async () => {
      const a1 = await createAs(salesAToken);
      const b1 = await createAs(salesBToken);
      const a2 = await createAs(salesAToken);
      await forceState(b1.id, { status: 'INFO_REQUESTED' });

      const all = (await get(adminToken, '/applications')).body as ListBody;
      expect(all.total).toBe(3);
      expect(all.items.map((item) => item.id)).toEqual([a2.id, b1.id, a1.id]);

      const filtered = (await get(adminToken, '/applications?status=INFO_REQUESTED'))
        .body as ListBody;
      expect(filtered.total).toBe(1);
      expect(filtered.items.map((item) => item.id)).toEqual([b1.id]);

      const page2 = (await get(adminToken, '/applications?page=2&limit=1')).body as ListBody;
      expect(page2).toMatchObject({ page: 2, limit: 1, total: 3 });
      expect(page2.items.map((item) => item.id)).toEqual([b1.id]);
    });

    it.each(['status=BOGUS', 'limit=0', 'limit=101', 'page=0', 'page=1e20', 'foo=1'])(
      'denied: ?%s gets 400',
      async (query) => {
        const res = await get(adminToken, `/applications?${query}`);

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      },
    );

    it('denied: no token gets 401', async () => {
      const res = await get(undefined, '/applications');

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    });
  });

  describe('GET /applications/:id', () => {
    it("denied: SALES A reading SALES B's application gets the same 404 as an unknown or malformed id", async () => {
      const b = await createAs(salesBToken);

      const outOfScope = await get(salesAToken, `/applications/${b.id}`);
      const unknown = await get(salesAToken, `/applications/${FAKE_UUID}`);
      const malformed = await get(salesAToken, '/applications/not-a-uuid');

      for (const res of [outOfScope, unknown, malformed]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND_BODY);
      }
    });

    it('the assigned REVIEWER gets 200; a non-assigned REVIEWER gets 404', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW', assignedReviewerId: reviewerId });

      const assigned = await get(reviewerToken, `/applications/${a.id}`);
      expect(assigned.status).toBe(200);
      expectMasked(assigned.body as ApplicationBody, DETAIL_RESPONSE_KEYS);

      const other = await get(reviewer2Token, `/applications/${a.id}`);
      expect(other.status).toBe(404);
      expect(other.body).toEqual(NOT_FOUND_BODY);
    });

    it('the owner and ADMIN get 200 with a masked body', async () => {
      const a = await createAs(salesAToken);

      for (const token of [salesAToken, adminToken]) {
        const res = await get(token, `/applications/${a.id}`);
        expect(res.status).toBe(200);
        expectMasked(res.body as ApplicationBody, DETAIL_RESPONSE_KEYS);
        expect((res.body as ApplicationBody).id).toBe(a.id);
      }
    });

    it('denied: no token gets 401', async () => {
      const res = await get(undefined, `/applications/${FAKE_UUID}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    });

    it('after a submit, kybCheck is PENDING with no level, label, score or attempts', async () => {
      const a = await createAs(salesAToken);
      expect((await submit(salesAToken, a.id)).status).toBe(200);

      const res = await get(salesAToken, `/applications/${a.id}`);

      expect(res.status).toBe(200);
      const body = res.body as DetailBody;
      expectMasked(body, DETAIL_RESPONSE_KEYS);
      expect(body.kybCheck).toEqual({
        status: 'PENDING',
        level: null,
        label: null,
        score: null,
        attempts: 0,
        lastAttemptAt: null,
      });
    });

    it('a completed KYB result shows its derived label; list items have no kybCheck', async () => {
      const a = await createAs(salesAToken);
      const lastAttemptAt = new Date('2026-01-01T00:00:00.000Z');
      await forceState(a.id, {
        status: 'UNDER_REVIEW',
        kybStatus: 'COMPLETED',
        kybLevel: 'HIGH',
        kybScore: 78,
        kybAttempts: 2,
        kybLastAttemptAt: lastAttemptAt,
        submissionCount: 1,
      });

      const res = await get(salesAToken, `/applications/${a.id}`);

      expect(res.status).toBe(200);
      const body = res.body as DetailBody;
      expectMasked(body, DETAIL_RESPONSE_KEYS);
      expect(body.kybCheck).toEqual({
        status: 'COMPLETED',
        level: 'HIGH',
        label: 'Needs double check',
        score: 78,
        attempts: 2,
        lastAttemptAt: lastAttemptAt.toISOString(),
      });

      const list = (await get(salesAToken, '/applications')).body as ListBody;
      expect(list.items.map((item) => item.id)).toEqual([a.id]);
      for (const item of list.items) {
        expectMasked(item);
        expect(item).not.toHaveProperty('kybCheck');
      }
    });
  });

  describe('PATCH /applications/:id', () => {
    it('the SALES owner edits a DRAFT: 200, masked, version 1 to 2 in one clause, audited', async () => {
      const a = await createAs(salesAToken);
      await expect(applicationRow(a.id)).resolves.toMatchObject({ version: 1 });
      // Watches the UPDATE statement TypeORM builds (SQL text only; parameters are not read).
      const sqlSpy = jest.spyOn(UpdateQueryBuilder.prototype, 'getQueryAndParameters');

      let res: request.Response;
      let updates: string[];
      try {
        res = await patch(salesAToken, a.id, { businessName: 'Example Grocers Two' });
        // Read before mockRestore, which also clears the recorded results.
        updates = sqlSpy.mock.results
          .map((result) => (result.value as [string, unknown[]])[0])
          .filter((sql) => sql.includes('"merchant_applications"'));
      } finally {
        sqlSpy.mockRestore();
      }

      expect(res.status).toBe(200);
      const body = res.body as ApplicationBody;
      expectMasked(body);
      expect(body.businessName).toBe('Example Grocers Two');
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        business_name: 'Example Grocers Two',
        version: 2,
      });
      expect(updates).toHaveLength(1);
      // Exactly one version assignment (TypeORM quotes the column inside the raw expression) and
      // no extra auto-generated version or updated_at clause.
      const setClause = updates[0]?.split(' WHERE ')[0] ?? '';
      expect(setClause).toBe(
        'UPDATE "merchant_applications" SET "business_name" = $1, "version" = "version" + 1, "updated_at" = now()',
      );
      expect(setClause.match(/"version" =/g)).toHaveLength(1);
      expect(updates[0]).toContain('"version" = $');

      const audits = await auditRows();
      expect(audits.map((row) => row.action)).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_UPDATED',
      ]);
      expect(audits[1]).toEqual({
        actor_type: 'USER',
        actor_id: salesAId,
        actor_role: 'SALES',
        action: 'APPLICATION_UPDATED',
        entity_type: 'merchant_application',
        entity_id: a.id,
        meta: { changedFields: ['businessName'], status: 'DRAFT' },
      });
      expect(JSON.stringify(audits[1])).not.toContain('Example Grocers Two');
    });

    it('the SALES owner edits in INFO_REQUESTED: 200', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'INFO_REQUESTED' });

      const res = await patch(salesAToken, a.id, { taxId: 'PAN-FAKE-00009999' });

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).taxId).toBe('••••••9999');
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        status: 'INFO_REQUESTED',
        version: 2,
      });
    });

    it("ADMIN edits SALES B's application, and websiteUrl null clears it", async () => {
      const b = await createAs(salesBToken);

      const res = await patch(adminToken, b.id, { websiteUrl: null });

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).websiteUrl).toBeNull();
      await expect(applicationRow(b.id)).resolves.toMatchObject({ website_url: null, version: 2 });
      expect((await auditRows()).at(-1)).toMatchObject({
        actor_id: adminId,
        actor_role: 'ADMIN',
        action: 'APPLICATION_UPDATED',
        meta: { changedFields: ['websiteUrl'], status: 'DRAFT' },
      });
    });

    it("denied: SALES A patching SALES B's application gets the unknown-id 404; B's row and audit unchanged", async () => {
      const b = await createAs(salesBToken);
      const before = await applicationRow(b.id);
      const auditsBefore = await auditRows();

      const outOfScope = await patch(salesAToken, b.id, { businessName: 'Changed' });
      const unknown = await patch(salesAToken, FAKE_UUID, { businessName: 'Changed' });

      expect(outOfScope.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(outOfScope.body).toEqual(unknown.body);
      expect(outOfScope.body).toEqual(NOT_FOUND_BODY);
      await expect(applicationRow(b.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it('denied: REVIEWER, even the assigned one, gets 403', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { assignedReviewerId: reviewerId });

      const res = await patch(reviewerToken, a.id, { businessName: 'Changed' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      await expect(applicationRow(a.id)).resolves.toMatchObject({ version: 1 });
    });

    it.each(['RISK_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'])(
      'denied: editing in %s gets 409 INVALID_STATE_TRANSITION, row unchanged, no audit',
      async (status) => {
        const a = await createAs(salesAToken);
        await forceState(a.id, { status });
        const before = await applicationRow(a.id);

        const res = await patch(salesAToken, a.id, { businessName: 'Changed' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual(NOT_EDITABLE_BODY);
        await expect(applicationRow(a.id)).resolves.toEqual(before);
        expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
      },
    );

    it.each<[string, 'sales' | 'admin', string, (ids: { other: string }) => unknown]>([
      ['salesOwnerId from SALES', 'sales', 'salesOwnerId', (ids) => ids.other],
      ['salesOwnerId from ADMIN', 'admin', 'salesOwnerId', (ids) => ids.other],
      ['createdById', 'sales', 'createdById', (ids) => ids.other],
      ['status', 'sales', 'status', () => 'APPROVED'],
      ['kybStatus', 'sales', 'kybStatus', () => 'COMPLETED'],
      ['kybLevel', 'sales', 'kybLevel', () => 'LOW'],
      ['assignedReviewerId', 'sales', 'assignedReviewerId', (ids) => ids.other],
    ])('denied: mass-assignment of %s gets 400, row unchanged', async (_l, who, key, value) => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);
      const token = who === 'admin' ? adminToken : salesAToken;

      const res = await patch(token, a.id, { [key]: value({ other: salesBId }) });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(`property ${key} should not exist`);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
    });

    it.each<[string, object]>([
      ['an empty body', {}],
      ['businessName null', { businessName: null }],
    ])('denied: %s gets 400, row unchanged', async (_l, body) => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);

      const res = await patch(salesAToken, a.id, body);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      await expect(applicationRow(a.id)).resolves.toEqual(before);
    });
  });

  describe('POST /applications/:id/submit', () => {
    it('the SALES owner submits a DRAFT: 200, masked, KYB reset, counter 1, one conditional UPDATE, audited', async () => {
      const a = await createAs(salesAToken);

      const { result: res, updates } = await capturingUpdates(() => submit(salesAToken, a.id));

      expect(res.status).toBe(200);
      const body = res.body as ApplicationBody;
      expectMasked(body);
      expect(body).toMatchObject({ id: a.id, status: 'RISK_REVIEW', salesOwnerId: salesAId });
      expect(body.submittedAt).not.toBeNull();
      const row = await applicationRow(a.id);
      expect(row).toMatchObject({
        status: 'RISK_REVIEW',
        kyb_status: 'PENDING',
        kyb_level: null,
        kyb_score: null,
        kyb_attempts: 0,
        kyb_last_attempt_at: null,
        submission_count: 1,
        version: 2,
      });
      expect(row?.submitted_at).not.toBeNull();

      // One UPDATE: exactly one version and one updated_at assignment, none auto-added.
      expect(updates).toHaveLength(1);
      const setClause = updates[0]?.split(' WHERE ')[0] ?? '';
      expect(setClause).toBe(SUBMIT_SET_CLAUSE);
      expect(setClause.match(/"version" =/g)).toHaveLength(1);
      expect(setClause.match(/"updated_at" =/g)).toHaveLength(1);
      expect(updates[0]).toContain('"version" = $');

      const audits = await auditRows();
      expect(audits.map((entry) => entry.action)).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_SUBMITTED',
      ]);
      expect(audits[1]).toEqual({
        actor_type: 'USER',
        actor_id: salesAId,
        actor_role: 'SALES',
        action: 'APPLICATION_SUBMITTED',
        entity_type: 'merchant_application',
        entity_id: a.id,
        meta: { from: 'DRAFT', to: 'RISK_REVIEW', submissionNo: 1 },
      });

      // One KYB job for this submission, with the shipped options (docs/adrs/kyb-check.md).
      const job = await queue.getJob(kybCheckJobId(a.id, 1));
      expect(job).toBeDefined();
      expect(job?.data).toEqual({ applicationId: a.id, submissionNo: 1 });
      expect(job?.opts.attempts).toBe(5);
      expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
      expect(job?.opts.removeOnComplete).toEqual({ age: 7 * 24 * 3600 });
      expect(job?.opts.removeOnFail).toEqual({ age: 30 * 24 * 3600 });
    });

    it('ADMIN resubmits from INFO_REQUESTED: previous KYB result cleared, counter 2, reviewer kept', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, {
        status: 'INFO_REQUESTED',
        kybStatus: 'COMPLETED',
        kybLevel: 'HIGH',
        kybScore: 78,
        kybAttempts: 2,
        kybLastAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
        submissionCount: 1,
        assignedReviewerId: reviewerId,
      });

      const res = await submit(adminToken, a.id);

      expect(res.status).toBe(200);
      expect(res.body as ApplicationBody).toMatchObject({
        status: 'RISK_REVIEW',
        assignedReviewerId: reviewerId,
      });
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        kyb_status: 'PENDING',
        kyb_level: null,
        kyb_score: null,
        kyb_attempts: 0,
        kyb_last_attempt_at: null,
        submission_count: 2,
        assigned_reviewer_id: reviewerId,
      });
      expect((await auditRows()).at(-1)).toEqual({
        actor_type: 'USER',
        actor_id: adminId,
        actor_role: 'ADMIN',
        action: 'APPLICATION_SUBMITTED',
        entity_type: 'merchant_application',
        entity_id: a.id,
        meta: { from: 'INFO_REQUESTED', to: 'RISK_REVIEW', submissionNo: 2 },
      });
      const job = await queue.getJob(kybCheckJobId(a.id, 2));
      expect(job?.data).toEqual({ applicationId: a.id, submissionNo: 2 });
      await expect(kybJob(a.id, 1)).resolves.toBeUndefined();
    });

    it("ADMIN submits SALES B's DRAFT: 200", async () => {
      const b = await createAs(salesBToken);

      const res = await submit(adminToken, b.id);

      expect(res.status).toBe(200);
      await expect(applicationRow(b.id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        submission_count: 1,
      });
    });

    it("denied: SALES A submitting SALES B's application gets the same 404 as an unknown or malformed id; nothing changes", async () => {
      const b = await createAs(salesBToken);
      const before = await applicationRow(b.id);
      const auditsBefore = await auditRows();

      const outOfScope = await submit(salesAToken, b.id);
      const unknown = await submit(salesAToken, FAKE_UUID);
      const malformed = await submit(salesAToken, 'not-a-uuid');

      for (const res of [outOfScope, unknown, malformed]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND_BODY);
      }
      await expect(applicationRow(b.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
      await expectNoKybJob(b.id);
    });

    it('denied: REVIEWER, even the assigned one, gets 403; on an unknown id too', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { assignedReviewerId: reviewerId });
      const before = await applicationRow(a.id);

      const assigned = await submit(reviewerToken, a.id);
      const unknown = await submit(reviewerToken, FAKE_UUID);

      for (const res of [assigned, unknown]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual(FORBIDDEN_BODY);
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect((await auditRows()).map((entry) => entry.action)).toEqual(['APPLICATION_CREATED']);
      await expectNoKybJob(a.id);
    });

    it.each(['RISK_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'])(
      'denied: submitting in %s gets 409 INVALID_STATE_TRANSITION, row unchanged, no audit',
      async (status) => {
        const a = await createAs(salesAToken);
        await forceState(a.id, { status });
        const before = await applicationRow(a.id);

        const res = await submit(salesAToken, a.id);

        expect(res.status).toBe(409);
        expect(res.body).toEqual(NOT_SUBMITTABLE_BODY);
        await expect(applicationRow(a.id)).resolves.toEqual(before);
        expect((await auditRows()).map((entry) => entry.action)).toEqual(['APPLICATION_CREATED']);
        await expectNoKybJob(a.id);
      },
    );

    it('denied: a second submit through the API gets 409 INVALID_STATE_TRANSITION; counter stays 1', async () => {
      const a = await createAs(salesAToken);
      expect((await submit(salesAToken, a.id)).status).toBe(200);

      const again = await submit(salesAToken, a.id);

      expect(again.status).toBe(409);
      expect(again.body).toEqual(NOT_SUBMITTABLE_BODY);
      await expect(applicationRow(a.id)).resolves.toMatchObject({ submission_count: 1 });
      await expect(submittedAuditCount()).resolves.toBe(1);
      // Only the first submit enqueued; the 409 added no job.
      await expect(kybJob(a.id, 1)).resolves.toBeDefined();
      await expect(kybJob(a.id, 2)).resolves.toBeUndefined();
    });

    it('denied: PATCH after a real submit gets 409 NOT_EDITABLE', async () => {
      const a = await createAs(salesAToken);
      expect((await submit(salesAToken, a.id)).status).toBe(200);
      const before = await applicationRow(a.id);

      const res = await patch(salesAToken, a.id, { businessName: 'Changed' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual(NOT_EDITABLE_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
    });

    it('denied: a lost race (version bumped between read and write) gets 409 CONCURRENT_MODIFICATION', async () => {
      const a = await createAs(salesAToken);
      const repo = app.get(ApplicationsRepository);
      // Reference to the real method, taken before spying, so the mock does not call itself.
      const real = repo.findAccessible.bind(repo);
      const spy = jest
        .spyOn(repo, 'findAccessible')
        .mockImplementationOnce(async (id, actor, manager) => {
          const found = await real(id, actor, manager);
          // Separate pool connection; the SELECT above holds no row lock, so this does not block.
          await dataSource.query(
            'UPDATE merchant_applications SET version = version + 1 WHERE id = $1',
            [id],
          );
          return found;
        });
      let res: request.Response;
      try {
        res = await submit(salesAToken, a.id);
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: CONCURRENT_MODIFICATION_MESSAGE,
        code: CONCURRENT_MODIFICATION_CODE,
      });
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        status: 'DRAFT',
        kyb_status: 'NOT_STARTED',
        submission_count: 0,
        version: 2,
      });
      await expect(submittedAuditCount()).resolves.toBe(0);
    });

    it('two concurrent submits of one DRAFT: one 200, one 409; counter 1, one audit row', async () => {
      const a = await createAs(salesAToken);

      const results = await Promise.all([submit(salesAToken, a.id), submit(salesAToken, a.id)]);

      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      const loser = results.find((res) => res.status === 409);
      expect([CONCURRENT_MODIFICATION_CODE, INVALID_STATE_TRANSITION_CODE]).toContain(
        (loser?.body as { code?: string } | undefined)?.code,
      );
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        submission_count: 1,
      });
      await expect(submittedAuditCount()).resolves.toBe(1);
    });

    it('denied: no token gets 401', async () => {
      const a = await createAs(salesAToken);

      const res = await submit(undefined, a.id);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationRow(a.id)).resolves.toMatchObject({ status: 'DRAFT', version: 1 });
    });

    it('denied: a tampered token (role re-encoded as ADMIN) gets 401', async () => {
      const b = await createAs(salesBToken);
      const [header, payload, signature] = salesAToken.split('.');
      const tampered = [
        header,
        base64UrlJson({ ...decodeSegment(payload), role: 'ADMIN' }),
        signature,
      ].join('.');

      const res = await submit(tampered, b.id);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationRow(b.id)).resolves.toMatchObject({ status: 'DRAFT', version: 1 });
      await expect(submittedAuditCount()).resolves.toBe(0);
    });
  });

  describe('POST /applications/:id/assign', () => {
    async function auditsOf(action: string): Promise<AuditRow[]> {
      return (await auditRows()).filter((row) => row.action === action);
    }

    it('ADMIN assigns in RISK_REVIEW (real submit): 200, masked, version +1, status and KYB unchanged, audited', async () => {
      // Relies on the KYB worker being off in this spec (KybCheckProcessor uses autorun: false and
      // test/setup/test-env.ts sets KYB_WORKER_ENABLED=false), so the row stays in RISK_REVIEW.
      const a = await createAs(salesAToken);
      expect((await submit(salesAToken, a.id)).status).toBe(200);
      const before = await applicationRow(a.id);
      expect(before).toMatchObject({ status: 'RISK_REVIEW', assigned_reviewer_id: null });

      const res = await assign(adminToken, a.id, { reviewerId });

      expect(res.status).toBe(200);
      const body = res.body as ApplicationBody;
      expectMasked(body);
      expect(body).toMatchObject({
        id: a.id,
        assignedReviewerId: reviewerId,
        salesOwnerId: salesAId,
        status: 'RISK_REVIEW',
      });
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        assigned_reviewer_id: reviewerId,
        version: (before?.version ?? 0) + 1,
        status: before?.status,
        kyb_status: before?.kyb_status,
        submission_count: before?.submission_count,
      });
      await expect(auditsOf('REVIEWER_ASSIGNED')).resolves.toEqual([
        {
          actor_type: 'USER',
          actor_id: adminId,
          actor_role: 'ADMIN',
          action: 'REVIEWER_ASSIGNED',
          entity_type: 'merchant_application',
          entity_id: a.id,
          meta: { from: null, to: reviewerId },
        },
      ]);
    });

    it.each(['UNDER_REVIEW', 'INFO_REQUESTED'])('ADMIN assigns in %s: 200', async (status) => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status });

      const res = await assign(adminToken, a.id, { reviewerId });

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).assignedReviewerId).toBe(reviewerId);
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        status,
        assigned_reviewer_id: reviewerId,
        version: 2,
      });
    });

    it('after assign, the assigned REVIEWER reads and lists it; reviewer-2 gets 404', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      expect((await assign(adminToken, a.id, { reviewerId })).status).toBe(200);

      const detail = await get(reviewerToken, `/applications/${a.id}`);
      expect(detail.status).toBe(200);
      expectMasked(detail.body as ApplicationBody, DETAIL_RESPONSE_KEYS);
      const list = (await get(reviewerToken, '/applications')).body as ListBody;
      expect(list.items.map((item) => item.id)).toEqual([a.id]);

      const other = await get(reviewer2Token, `/applications/${a.id}`);
      expect(other.status).toBe(404);
      expect(other.body).toEqual(NOT_FOUND_BODY);
    });

    it('reassign to reviewer-2: 200, audited from/to; the previous reviewer loses access at once', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      expect((await assign(adminToken, a.id, { reviewerId })).status).toBe(200);

      const res = await assign(adminToken, a.id, { reviewerId: reviewer2Id });

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).assignedReviewerId).toBe(reviewer2Id);
      expect((await auditsOf('REVIEWER_ASSIGNED')).map((row) => row.meta)).toEqual([
        { from: null, to: reviewerId },
        { from: reviewerId, to: reviewer2Id },
      ]);

      const previous = await get(reviewerToken, `/applications/${a.id}`);
      expect(previous.status).toBe(404);
      expect(previous.body).toEqual(NOT_FOUND_BODY);
      const previousList = (await get(reviewerToken, '/applications')).body as ListBody;
      expect(previousList.items).toEqual([]);
      expect((await get(reviewer2Token, `/applications/${a.id}`)).status).toBe(200);
    });

    it('the same reviewer again: 200, version bump and a second audit row with from === to', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      expect((await assign(adminToken, a.id, { reviewerId })).status).toBe(200);

      const res = await assign(adminToken, a.id, { reviewerId });

      expect(res.status).toBe(200);
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        assigned_reviewer_id: reviewerId,
        version: 3,
      });
      expect((await auditsOf('REVIEWER_ASSIGNED')).map((row) => row.meta)).toEqual([
        { from: null, to: reviewerId },
        { from: reviewerId, to: reviewerId },
      ]);
    });

    it.each<[string, 'sales' | 'reviewer', (ids: { reviewer2: string }) => object]>([
      ['SALES (the owner)', 'sales', (ids) => ({ reviewerId: ids.reviewer2 })],
      ['SALES (the owner) with an invalid body', 'sales', () => ({ status: 'APPROVED' })],
      ['REVIEWER (the assigned one)', 'reviewer', (ids) => ({ reviewerId: ids.reviewer2 })],
    ])('denied: %s cannot assign → 403; row and audit unchanged', async (_l, who, body) => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW', assignedReviewerId: reviewerId });
      const before = await applicationRow(a.id);
      const auditsBefore = await auditRows();
      const token = who === 'sales' ? salesAToken : reviewerToken;

      const res = await assign(token, a.id, body({ reviewer2: reviewer2Id }));

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it('denied: no token gets 401; row and audit unchanged', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      const before = await applicationRow(a.id);
      const auditsBefore = await auditRows();

      const res = await assign(undefined, a.id, { reviewerId });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it.each<[string, (ids: { salesA: string; admin: string }) => string]>([
      ["a SALES user's id", (ids) => ids.salesA],
      ["the ADMIN's id", (ids) => ids.admin],
      ['an unknown UUID', () => FAKE_UUID],
      ["'not-a-uuid'", () => 'not-a-uuid'],
    ])('denied: reviewerId as %s gets 400; row and audit unchanged', async (_l, target) => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      const before = await applicationRow(a.id);
      const auditsBefore = await auditRows();

      const res = await assign(adminToken, a.id, {
        reviewerId: target({ salesA: salesAId, admin: adminId }),
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(REVIEWER_NOT_REVIEWER_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it.each<[string, (ids: { reviewer: string }) => object, string | undefined]>([
      ['a missing reviewerId', () => ({}), undefined],
      [
        'an extra assignedReviewerId',
        (ids) => ({ reviewerId: ids.reviewer, assignedReviewerId: ids.reviewer }),
        'property assignedReviewerId should not exist',
      ],
      [
        'an extra status',
        (ids) => ({ reviewerId: ids.reviewer, status: 'APPROVED' }),
        'property status should not exist',
      ],
      ['a numeric reviewerId', () => ({ reviewerId: 42 }), undefined],
    ])('denied: %s gets 400 from validation; row and audit unchanged', async (_l, body, text) => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      const before = await applicationRow(a.id);
      const auditsBefore = await auditRows();

      const res = await assign(adminToken, a.id, body({ reviewer: reviewerId }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      if (text !== undefined) {
        expect(JSON.stringify(res.body)).toContain(text);
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it('denied: an unknown or malformed application id gets the same 404', async () => {
      const unknown = await assign(adminToken, FAKE_UUID, { reviewerId });
      const malformed = await assign(adminToken, 'not-a-uuid', { reviewerId });

      for (const res of [unknown, malformed]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND_BODY);
      }
      await expect(auditRows()).resolves.toEqual([]);
    });

    it.each(['DRAFT', 'APPROVED', 'REJECTED'])(
      'denied: assigning in %s gets 409 INVALID_STATE_TRANSITION; row and audit unchanged',
      async (status) => {
        const a = await createAs(salesAToken);
        await forceState(a.id, { status });
        const before = await applicationRow(a.id);

        const res = await assign(adminToken, a.id, { reviewerId });

        expect(res.status).toBe(409);
        expect(res.body).toEqual(NOT_ASSIGNABLE_BODY);
        await expect(applicationRow(a.id)).resolves.toEqual(before);
        expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
      },
    );

    it('denied: a lost race (version bumped between read and write) gets 409 CONCURRENT_MODIFICATION', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      const repo = app.get(ApplicationsRepository);
      // Reference to the real method, taken before spying, so the mock does not call itself.
      const real = repo.findAccessible.bind(repo);
      const spy = jest
        .spyOn(repo, 'findAccessible')
        .mockImplementationOnce(async (id, actor, manager) => {
          const found = await real(id, actor, manager);
          // Separate pool connection; the SELECT above holds no row lock, so this does not block.
          await dataSource.query(
            'UPDATE merchant_applications SET version = version + 1 WHERE id = $1',
            [id],
          );
          return found;
        });
      let res: request.Response;
      try {
        res = await assign(adminToken, a.id, { reviewerId });
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(409);
      expect(res.body).toEqual(CONCURRENT_MODIFICATION_BODY);
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        assigned_reviewer_id: null,
        version: 2,
      });
      await expect(auditsOf('REVIEWER_ASSIGNED')).resolves.toEqual([]);
    });
  });

  describe('POST /applications/:id/transfer-owner', () => {
    async function auditsOf(action: string): Promise<AuditRow[]> {
      return (await auditRows()).filter((row) => row.action === action);
    }

    it('ADMIN transfers A → B in DRAFT: 200, audited; A gets 404 everywhere, B has full access', async () => {
      const a = await createAs(salesAToken);

      const res = await transferOwner(adminToken, a.id, { salesOwnerId: salesBId });

      expect(res.status).toBe(200);
      const body = res.body as ApplicationBody;
      expectMasked(body);
      expect(body).toMatchObject({ id: a.id, salesOwnerId: salesBId, createdById: salesAId });
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        sales_owner_id: salesBId,
        status: 'DRAFT',
        version: 2,
      });
      await expect(auditsOf('OWNERSHIP_TRANSFERRED')).resolves.toEqual([
        {
          actor_type: 'USER',
          actor_id: adminId,
          actor_role: 'ADMIN',
          action: 'OWNERSHIP_TRANSFERRED',
          entity_type: 'merchant_application',
          entity_id: a.id,
          meta: { from: salesAId, to: salesBId },
        },
      ]);

      // SALES A (the previous owner) gets the unknown-id 404 on every route and an empty list.
      const deniedGet = await get(salesAToken, `/applications/${a.id}`);
      const deniedPatch = await patch(salesAToken, a.id, { businessName: 'Changed by A' });
      const deniedSubmit = await submit(salesAToken, a.id);
      for (const denied of [deniedGet, deniedPatch, deniedSubmit]) {
        expect(denied.status).toBe(404);
        expect(denied.body).toEqual(NOT_FOUND_BODY);
      }
      const aList = (await get(salesAToken, '/applications')).body as ListBody;
      expect(aList.items.map((item) => item.id)).not.toContain(a.id);

      // SALES B (the new owner) reads, edits, lists and submits it.
      expect((await get(salesBToken, `/applications/${a.id}`)).status).toBe(200);
      expect((await patch(salesBToken, a.id, { businessName: 'Changed by B' })).status).toBe(200);
      const bList = (await get(salesBToken, '/applications')).body as ListBody;
      expect(bList.items.map((item) => item.id)).toContain(a.id);
      expect((await submit(salesBToken, a.id)).status).toBe(200);
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        business_name: 'Changed by B',
        status: 'RISK_REVIEW',
        sales_owner_id: salesBId,
      });
    });

    it.each(['RISK_REVIEW', 'UNDER_REVIEW', 'INFO_REQUESTED'])(
      'ADMIN transfers in %s: 200',
      async (status) => {
        const a = await createAs(salesAToken);
        await forceState(a.id, { status });

        const res = await transferOwner(adminToken, a.id, { salesOwnerId: salesBId });

        expect(res.status).toBe(200);
        await expect(applicationRow(a.id)).resolves.toMatchObject({
          status,
          sales_owner_id: salesBId,
          version: 2,
        });
      },
    );

    it('transfer to the current owner: 200 and an audit row with from === to', async () => {
      const a = await createAs(salesAToken);

      const res = await transferOwner(adminToken, a.id, { salesOwnerId: salesAId });

      expect(res.status).toBe(200);
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        sales_owner_id: salesAId,
        version: 2,
      });
      expect((await auditsOf('OWNERSHIP_TRANSFERRED')).map((row) => row.meta)).toEqual([
        { from: salesAId, to: salesAId },
      ]);
    });

    it.each<[string, 'sales' | 'reviewer', (ids: { a: string; b: string }) => string]>([
      ['SALES (the owner) transferring to another SALES user', 'sales', (ids) => ids.b],
      ['SALES (the owner) transferring to themselves', 'sales', (ids) => ids.a],
      ['REVIEWER (the assigned one)', 'reviewer', (ids) => ids.b],
    ])('denied: %s → 403; row and audit unchanged', async (_l, who, target) => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW', assignedReviewerId: reviewerId });
      const before = await applicationRow(a.id);
      const auditsBefore = await auditRows();
      const token = who === 'sales' ? salesAToken : reviewerToken;

      const res = await transferOwner(token, a.id, {
        salesOwnerId: target({ a: salesAId, b: salesBId }),
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it('denied: no token gets 401; row and audit unchanged', async () => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);

      const res = await transferOwner(undefined, a.id, { salesOwnerId: salesBId });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
    });

    it.each<[string, (ids: { reviewer: string; admin: string }) => string]>([
      ["a REVIEWER's id", (ids) => ids.reviewer],
      ["the ADMIN's own id", (ids) => ids.admin],
      ['an unknown UUID', () => FAKE_UUID],
      ["'not-a-uuid'", () => 'not-a-uuid'],
    ])('denied: ADMIN cannot transfer to %s → 400; row and audit unchanged', async (_l, target) => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);

      const res = await transferOwner(adminToken, a.id, {
        salesOwnerId: target({ reviewer: reviewerId, admin: adminId }),
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(SALES_OWNER_NOT_SALES_BODY);
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
    });

    it.each<[string, (ids: { b: string }) => object, string | undefined]>([
      ['a missing salesOwnerId', () => ({}), undefined],
      [
        'an extra reviewerId',
        (ids) => ({ salesOwnerId: ids.b, reviewerId: ids.b }),
        'property reviewerId should not exist',
      ],
      [
        'an extra createdById',
        (ids) => ({ salesOwnerId: ids.b, createdById: ids.b }),
        'property createdById should not exist',
      ],
    ])('denied: %s gets 400 from validation; row and audit unchanged', async (_l, body, text) => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);

      const res = await transferOwner(adminToken, a.id, body({ b: salesBId }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      if (text !== undefined) {
        expect(JSON.stringify(res.body)).toContain(text);
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
    });

    it('denied: an unknown or malformed application id gets the same 404', async () => {
      const unknown = await transferOwner(adminToken, FAKE_UUID, { salesOwnerId: salesBId });
      const malformed = await transferOwner(adminToken, 'not-a-uuid', { salesOwnerId: salesBId });

      for (const res of [unknown, malformed]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND_BODY);
      }
      await expect(auditRows()).resolves.toEqual([]);
    });

    it.each(['APPROVED', 'REJECTED'])(
      'denied: transferring in %s gets 409 INVALID_STATE_TRANSITION; row and audit unchanged',
      async (status) => {
        const a = await createAs(salesAToken);
        await forceState(a.id, { status });
        const before = await applicationRow(a.id);

        const res = await transferOwner(adminToken, a.id, { salesOwnerId: salesBId });

        expect(res.status).toBe(409);
        expect(res.body).toEqual(NOT_TRANSFERABLE_BODY);
        await expect(applicationRow(a.id)).resolves.toEqual(before);
        expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
      },
    );

    it('denied: a lost race (version bumped between read and write) gets 409 CONCURRENT_MODIFICATION', async () => {
      const a = await createAs(salesAToken);
      const repo = app.get(ApplicationsRepository);
      // Reference to the real method, taken before spying, so the mock does not call itself.
      const real = repo.findAccessible.bind(repo);
      const spy = jest
        .spyOn(repo, 'findAccessible')
        .mockImplementationOnce(async (id, actor, manager) => {
          const found = await real(id, actor, manager);
          // Separate pool connection; the SELECT above holds no row lock, so this does not block.
          await dataSource.query(
            'UPDATE merchant_applications SET version = version + 1 WHERE id = $1',
            [id],
          );
          return found;
        });
      let res: request.Response;
      try {
        res = await transferOwner(adminToken, a.id, { salesOwnerId: salesBId });
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(409);
      expect(res.body).toEqual(CONCURRENT_MODIFICATION_BODY);
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        sales_owner_id: salesAId,
        version: 2,
      });
      await expect(auditsOf('OWNERSHIP_TRANSFERRED')).resolves.toEqual([]);
    });
  });

  describe('same transaction as the audit row', () => {
    it('a failed audit write on POST gives 500 and leaves no application row', async () => {
      const spy = jest
        .spyOn(app.get(AuditLogService), 'record')
        .mockRejectedValueOnce(new Error('audit write failed (test)'));
      try {
        const res = await post(salesAToken, PAYLOAD);

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_ERROR_BODY);
      } finally {
        spy.mockRestore();
      }
      await expect(applicationCount()).resolves.toBe(0);
      await expect(auditRows()).resolves.toEqual([]);
    });

    it('a failed audit write on PATCH gives 500 and leaves the row unchanged', async () => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);
      const spy = jest
        .spyOn(app.get(AuditLogService), 'record')
        .mockRejectedValueOnce(new Error('audit write failed (test)'));
      try {
        const res = await patch(salesAToken, a.id, { businessName: 'Changed' });

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_ERROR_BODY);
      } finally {
        spy.mockRestore();
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
    });

    it('a failed audit write on submit gives 500 and leaves the row unchanged', async () => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);
      const spy = jest
        .spyOn(app.get(AuditLogService), 'record')
        .mockRejectedValueOnce(new Error('audit write failed (test)'));
      try {
        const res = await submit(salesAToken, a.id);

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_ERROR_BODY);
      } finally {
        spy.mockRestore();
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect(before).toMatchObject({
        status: 'DRAFT',
        kyb_status: 'NOT_STARTED',
        submission_count: 0,
        version: 1,
      });
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
      // The transaction rolled back, so nothing was enqueued.
      await expectNoKybJob(a.id);
    });

    it('a failed audit write on assign gives 500 and leaves the row unchanged', async () => {
      const a = await createAs(salesAToken);
      await forceState(a.id, { status: 'UNDER_REVIEW' });
      const before = await applicationRow(a.id);
      const spy = jest
        .spyOn(app.get(AuditLogService), 'record')
        .mockRejectedValueOnce(new Error('audit write failed (test)'));
      try {
        const res = await assign(adminToken, a.id, { reviewerId });

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_ERROR_BODY);
      } finally {
        spy.mockRestore();
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect(before).toMatchObject({ assigned_reviewer_id: null, version: 1 });
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
    });

    it('a failed audit write on transfer gives 500 and leaves the row unchanged', async () => {
      const a = await createAs(salesAToken);
      const before = await applicationRow(a.id);
      const spy = jest
        .spyOn(app.get(AuditLogService), 'record')
        .mockRejectedValueOnce(new Error('audit write failed (test)'));
      try {
        const res = await transferOwner(adminToken, a.id, { salesOwnerId: salesBId });

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_ERROR_BODY);
      } finally {
        spy.mockRestore();
      }
      await expect(applicationRow(a.id)).resolves.toEqual(before);
      expect(before).toMatchObject({ sales_owner_id: salesAId, version: 1 });
      expect((await auditRows()).map((row) => row.action)).toEqual(['APPLICATION_CREATED']);
    });
  });

  describe('KYB enqueue after submit', () => {
    it('enqueues strictly after the commit: the job sees the committed row', async () => {
      const a = await createAs(salesAToken);
      const realAdd = queue.add.bind(queue);
      const seen: Array<{ status: string; submission_count: number }> = [];
      const spy = jest.spyOn(queue, 'add').mockImplementationOnce(async (name, data, opts) => {
        // A separate pooled connection: it only sees committed data.
        const rows: Array<{ status: string; submission_count: number }> = await dataSource.query(
          'SELECT status, submission_count FROM merchant_applications WHERE id = $1',
          [a.id],
        );
        seen.push(...rows);
        return realAdd(name, data, opts);
      });
      let res: request.Response;
      try {
        res = await submit(salesAToken, a.id);
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(200);
      expect(seen).toEqual([{ status: 'RISK_REVIEW', submission_count: 1 }]);
      await expect(kybJob(a.id, 1)).resolves.toBeDefined();
    });

    it('a failed enqueue still returns 200, leaves RISK_REVIEW / PENDING and logs no PII', async () => {
      const a = await createAs(salesAToken);
      const spy = jest
        .spyOn(queue, 'add')
        .mockRejectedValueOnce(new Error('redis unavailable (test)'));
      let res: request.Response;
      try {
        res = await submit(salesAToken, a.id);
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).status).toBe('RISK_REVIEW');
      await expect(applicationRow(a.id)).resolves.toMatchObject({
        status: 'RISK_REVIEW',
        kyb_status: 'PENDING',
        submission_count: 1,
      });
      await expectNoKybJob(a.id);
      // Positive check first, so the no-PII check below cannot pass on silent output.
      const text = capturedText();
      expect(text).toContain(ENQUEUE_FAILED_MESSAGE);
      for (const secret of [RAW_TAX_ID, RAW_NATIONAL_ID, RAW_OWNER_EMAIL, RAW_OWNER_PHONE]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  it('never returns, logs or audits a raw sensitive value or a token', async () => {
    const a = await createAs(salesAToken);
    const b = await createAs(adminToken, { salesOwnerId: salesBId });
    await get(salesAToken, '/applications');
    await get(adminToken, `/applications/${b.id}`);
    await patch(salesAToken, a.id, { ownerEmail: 'owner2@example.com' });
    await post(salesAToken, { ...PAYLOAD, status: 'APPROVED' });
    // Submit: the masked response, the APPLICATION_SUBMITTED audit row and a 409 body.
    expect((await submit(salesAToken, a.id)).status).toBe(200);
    expect((await submit(salesAToken, a.id)).status).toBe(409);
    // Assign and transfer: masked responses, their audit rows and a 400 body.
    expect((await assign(adminToken, a.id, { reviewerId })).status).toBe(200);
    expect((await transferOwner(adminToken, a.id, { salesOwnerId: salesBId })).status).toBe(200);
    expect((await transferOwner(adminToken, a.id, { salesOwnerId: reviewerId })).status).toBe(400);
    const spy = jest
      .spyOn(app.get(AuditLogService), 'record')
      .mockRejectedValueOnce(new Error('audit write failed (test)'));
    try {
      await post(salesAToken, PAYLOAD);
    } finally {
      spy.mockRestore();
    }

    const audits = await auditRows();
    expect(audits.map((row) => row.action)).toContain('APPLICATION_SUBMITTED');
    expect(audits.map((row) => row.action)).toContain('REVIEWER_ASSIGNED');
    expect(audits.map((row) => row.action)).toContain('OWNERSHIP_TRANSFERRED');
    const stored = JSON.stringify(audits);
    const texts = [capturedText(), stored, ...responseTexts];
    const secrets = [
      RAW_TAX_ID,
      RAW_NATIONAL_ID,
      RAW_OWNER_EMAIL,
      'owner2@example.com',
      RAW_OWNER_PHONE,
      salesAToken,
      salesBToken,
      reviewerToken,
      reviewer2Token,
      adminToken,
    ];
    for (const text of texts) {
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('documents the five operations in Swagger with the bearer security requirement', async () => {
    const res = await request(server()).get('/docs-json').expect(200);

    const body = res.body as {
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    const operations = [
      body.paths['/applications']?.post,
      body.paths['/applications']?.get,
      body.paths['/applications/{id}']?.get,
      body.paths['/applications/{id}']?.patch,
      body.paths['/applications/{id}/submit']?.post,
    ];
    for (const operation of operations) {
      expect(operation).toBeDefined();
      expect(operation?.security).toEqual([{ bearer: [] }]);
    }
    // KYB_COMPLETE is system only: no route mentions kyb.
    expect(Object.keys(body.paths).filter((path) => path.toLowerCase().includes('kyb'))).toEqual(
      [],
    );
  });
});
