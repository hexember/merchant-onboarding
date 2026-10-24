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
import { ApplicationsRepository } from '../src/applications/applications.repository';
import {
  APPLICATION_NOT_FOUND_MESSAGE,
  CONCURRENT_MODIFICATION_CODE,
  CONCURRENT_MODIFICATION_MESSAGE,
  INVALID_STATE_TRANSITION_CODE,
  KYB_NOT_COMPLETED_CODE,
  KYB_NOT_COMPLETED_MESSAGE,
  NOT_DECIDABLE_MESSAGE,
} from '../src/applications/applications.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { UserRole } from '../src/common/common.enums';
import { BCRYPT_COST } from '../src/common/password';
import { KybCheckProcessor, KybJobLike, KybJobOutcome } from '../src/kyb/kyb-check.processor';
import { KYB_CHECK_QUEUE, kybCheckJobId } from '../src/kyb/kyb-job';
import { KYB_PROVIDER } from '../src/kyb/kyb-provider';
import { FakeKybProvider } from '../src/kyb/testing/fake-kyb-provider';
import { configureLogger } from '../src/logging/logger';
import { UsersRepository } from '../src/users/users.repository';
import { resetApplicationData, resetTables } from './utils/test-db';

// POST /applications/:id/decision end to end (docs/adrs/workflow.md §1.2, docs/adrs/auth.md,
// docs/adrs/testing.md) on real Postgres and Redis. The KYB worker is off (test-env.ts); the
// processor's handler is called directly with crafted jobs and the deterministic FakeKybProvider.

// Fake users only (@example.com, made-up names). Passwords come from the SEED_* env variables.
const SALES_EMAIL = 'decision-sales@example.com';
const SALES_B_EMAIL = 'decision-sales-b@example.com';
const REVIEWER_EMAIL = 'decision-reviewer@example.com';
const REVIEWER_2_EMAIL = 'decision-reviewer-2@example.com';
const ADMIN_EMAIL = 'decision-admin@example.com';

// Fake application data. The sensitive values are asserted never to leave the database raw.
const RAW_TAX_ID = 'PAN-FAKE-00002468';
const RAW_NATIONAL_ID = 'NID-FAKE-1357';
const RAW_OWNER_EMAIL = 'decision-owner@example.com';
const RAW_OWNER_PHONE = '+977-0000000789';

const PAYLOAD = {
  businessName: 'Example Bakery',
  legalBusinessName: 'Example Bakery Pvt. Ltd.',
  businessType: 'PRIVATE_LIMITED',
  registrationNumber: 'REG-FAKE-0003',
  taxId: RAW_TAX_ID,
  ownerFullName: 'Jo Example',
  ownerEmail: RAW_OWNER_EMAIL,
  ownerPhone: RAW_OWNER_PHONE,
  ownerNationalId: RAW_NATIONAL_ID,
  merchantCategoryCode: '5462',
  websiteUrl: 'https://bakery.example.com',
  expectedMonthlyVolumeMinor: 2500000,
  averageTicketSizeMinor: 150000,
};

const MASKED = {
  taxId: '••••••2468',
  ownerNationalId: '••••••1357',
  ownerEmail: 'd•••@example.com',
  ownerPhone: '••••••789',
};

// A made-up UUID that never belongs to a row (the database generates v4 UUIDs).
const FAKE_UUID = '00000000-0000-4000-8000-000000000003';

// Free text a reviewer might type. It is returned in responses by design, but must never reach
// the logs or any audit_logs row (docs/adrs/workflow.md §1.2 "Decision details").
const NOTE_MARKER = 'decision-note-marker-4b1e';

// Every key of the base response, in order (the decision returns the base DTO, not the detail).
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

const UNAUTHORIZED_BODY = { statusCode: 401, message: 'Unauthorized' };
const FORBIDDEN_BODY = { statusCode: 403, message: 'Forbidden' };
const INTERNAL_ERROR_BODY = { statusCode: 500, message: 'Internal server error' };
const NOT_FOUND_BODY = {
  statusCode: 404,
  error: 'Not Found',
  message: APPLICATION_NOT_FOUND_MESSAGE,
};
const NOT_DECIDABLE_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: NOT_DECIDABLE_MESSAGE,
  code: INVALID_STATE_TRANSITION_CODE,
};
const KYB_NOT_COMPLETED_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: KYB_NOT_COMPLETED_MESSAGE,
  code: KYB_NOT_COMPLETED_CODE,
};
const CONCURRENT_MODIFICATION_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: CONCURRENT_MODIFICATION_MESSAGE,
  code: CONCURRENT_MODIFICATION_CODE,
};

interface ApplicationBody {
  id: string;
  salesOwnerId: string;
  assignedReviewerId: string | null;
  status: string;
  decisionNote: string | null;
  decidedAt: string | null;
  taxId: string;
}

interface ApplicationRow {
  status: string;
  version: number;
  decision_note: string | null;
  decided_at: Date | null;
  assigned_reviewer_id: string | null;
  kyb_status: string;
  submission_count: number;
  business_name: string;
}

// Optional columns `forceState` can set. Each maps to its own parameterised test-only UPDATE.
interface ForcedState {
  status?: string;
  assignedReviewerId?: string | null;
  kybStatus?: string;
}

// Fixed column names only: the values always go in as parameters.
const FORCED_COLUMNS: ReadonlyArray<[keyof ForcedState, string]> = [
  ['status', 'status'],
  ['assignedReviewerId', 'assigned_reviewer_id'],
  ['kybStatus', 'kyb_status'],
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

describe('Reviewer decision (e2e)', () => {
  const fake = new FakeKybProvider();
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let processor: KybCheckProcessor;
  let salesId: string;
  let reviewerId: string;
  let reviewer2Id: string;
  let salesToken: string;
  let salesBToken: string;
  let reviewerToken: string;
  let reviewer2Token: string;
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
    await app.init();
    dataSource = app.get(DataSource);
    processor = app.get(KybCheckProcessor);
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
      [SALES_EMAIL, 'Dana Sales', UserRole.SALES, salesHash],
      [SALES_B_EMAIL, 'Drew Sales', UserRole.SALES, salesHash],
      [REVIEWER_EMAIL, 'Dale Reviewer', UserRole.REVIEWER, reviewerHash],
      [REVIEWER_2_EMAIL, 'Dee Reviewer', UserRole.REVIEWER, reviewerHash],
      [ADMIN_EMAIL, 'Dev Admin', UserRole.ADMIN, adminHash],
    ];
    for (const [email, fullName, role, passwordHash] of fixtures) {
      await users.insertIfAbsent({ email, fullName, role, passwordHash });
    }
    salesId = await userId(SALES_EMAIL);
    reviewerId = await userId(REVIEWER_EMAIL);
    reviewer2Id = await userId(REVIEWER_2_EMAIL);

    salesToken = await loginToken(SALES_EMAIL, salesPassword);
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

  async function decide(
    token: string | undefined,
    id: string,
    body: object,
  ): Promise<request.Response> {
    return track(
      await withToken(request(server()).post(`/applications/${id}/decision`), token).send(body),
    );
  }

  async function get(token: string, id: string): Promise<request.Response> {
    return track(await withToken(request(server()).get(`/applications/${id}`), token));
  }

  async function patch(token: string, id: string, body: object): Promise<request.Response> {
    return track(await withToken(request(server()).patch(`/applications/${id}`), token).send(body));
  }

  async function submit(token: string, id: string): Promise<request.Response> {
    return track(await withToken(request(server()).post(`/applications/${id}/submit`), token));
  }

  async function assign(token: string, id: string, reviewer: string): Promise<request.Response> {
    return track(
      await withToken(request(server()).post(`/applications/${id}/assign`), token).send({
        reviewerId: reviewer,
      }),
    );
  }

  async function createDraft(): Promise<string> {
    const res = track(
      await withToken(request(server()).post('/applications'), salesToken).send(PAYLOAD),
    );
    expect(res.status).toBe(201);
    return (res.body as ApplicationBody).id;
  }

  // Test-only SQL: puts a row into a state without running the whole workflow. Each column is
  // its own parameterised UPDATE; the version is not bumped.
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

  // An UNDER_REVIEW application assigned to REVIEWER with a completed KYB check, unless overridden.
  async function decidable(state: ForcedState = {}): Promise<string> {
    const id = await createDraft();
    await forceState(id, {
      status: 'UNDER_REVIEW',
      assignedReviewerId: reviewerId,
      kybStatus: 'COMPLETED',
      ...state,
    });
    return id;
  }

  async function applicationRow(id: string): Promise<ApplicationRow | undefined> {
    const rows: ApplicationRow[] = await dataSource.query(
      `SELECT status, version, decision_note, decided_at, assigned_reviewer_id, kyb_status,
              submission_count, business_name
         FROM merchant_applications WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function auditRows(): Promise<AuditRow[]> {
    return dataSource.query(
      'SELECT actor_type, actor_id, actor_role, action, entity_type, entity_id, meta FROM audit_logs ORDER BY created_at',
    );
  }

  async function decisionAudits(): Promise<AuditRow[]> {
    return (await auditRows()).filter((row) => row.action === 'DECISION_RECORDED');
  }

  function craftedJob(data: unknown, attemptsMade: number): KybJobLike {
    return { data, attemptsMade, opts: { attempts: 5 } };
  }

  function handle(id: string, attemptsMade = 0, submissionNo = 1): Promise<KybJobOutcome> {
    return processor.handle(craftedJob({ applicationId: id, submissionNo }, attemptsMade));
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

  // The note marker must not be in the logs or in any audit row (meta included).
  async function expectNoteNotLeaked(): Promise<void> {
    expect(capturedText()).not.toContain(NOTE_MARKER);
    expect(JSON.stringify(await auditRows())).not.toContain(NOTE_MARKER);
  }

  describe('happy paths', () => {
    it.each<[string, string]>([
      ['APPROVE', 'APPROVED'],
      ['REJECT', 'REJECTED'],
      ['REQUEST_INFO', 'INFO_REQUESTED'],
    ])(
      '%s → 200 %s: masked body, row written, one audit row without the note',
      async (decision, to) => {
        const id = await decidable();
        const before = await applicationRow(id);
        const note = `Checked: ${NOTE_MARKER}`;

        const res = await decide(reviewerToken, id, { decision, note });

        expect(res.status).toBe(200);
        const body = res.body as ApplicationBody;
        expect(Object.keys(body)).toEqual(RESPONSE_KEYS);
        expect(body).toMatchObject({
          ...MASKED,
          id,
          status: to,
          decisionNote: note,
          assignedReviewerId: reviewerId,
          salesOwnerId: salesId,
        });
        expect(body.decidedAt).not.toBeNull();
        const row = await applicationRow(id);
        expect(row).toMatchObject({
          status: to,
          decision_note: note,
          version: (before?.version ?? 0) + 1,
          assigned_reviewer_id: reviewerId,
        });
        expect(row?.decided_at).toBeInstanceOf(Date);
        await expect(decisionAudits()).resolves.toEqual([
          {
            actor_type: 'USER',
            actor_id: reviewerId,
            actor_role: 'REVIEWER',
            action: 'DECISION_RECORDED',
            entity_type: 'merchant_application',
            entity_id: id,
            meta: { decision, from: 'UNDER_REVIEW', to },
          },
        ]);
        await expectNoteNotLeaked();
      },
    );

    it('a decision without a note stores decision_note null', async () => {
      const id = await decidable();

      const res = await decide(reviewerToken, id, { decision: 'REJECT' });

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).decisionNote).toBeNull();
      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'REJECTED',
        decision_note: null,
      });
    });

    it.each<[string, string]>([
      ['REJECT', 'REJECTED'],
      ['REQUEST_INFO', 'INFO_REQUESTED'],
    ])('%s with kybStatus FAILED → 200 %s', async (decision, to) => {
      const id = await decidable({ kybStatus: 'FAILED' });

      const res = await decide(reviewerToken, id, { decision });

      expect(res.status).toBe(200);
      expect((res.body as ApplicationBody).status).toBe(to);
      await expect(decisionAudits()).resolves.toHaveLength(1);
    });
  });

  describe('denied (authz)', () => {
    // Nest runs guards before pipes: RolesGuard rejects ADMIN and SALES before ValidationPipe
    // looks at the body, so an invalid body also gets 403 (not 400). The service-level
    // isRoleAllowed 403 is covered by the unit tests.
    it.each<[string, () => string, object]>([
      ['the SALES owner, valid body', () => salesToken, { decision: 'APPROVE' }],
      ['the SALES owner, invalid body', () => salesToken, { decision: 'KYB_COMPLETE', x: 1 }],
      ['ADMIN, valid body', () => adminToken, { decision: 'APPROVE' }],
      ['ADMIN, invalid body', () => adminToken, { decision: 'KYB_COMPLETE', x: 1 }],
    ])('%s gets 403; row and audit rows unchanged', async (_l, token, body) => {
      const id = await decidable();
      const before = await applicationRow(id);
      const auditsBefore = await auditRows();

      const res = await decide(token(), id, body);

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it('a non-assigned REVIEWER gets the same 404 as an unknown or malformed id', async () => {
      const id = await decidable();
      const before = await applicationRow(id);

      const responses = [
        await decide(reviewer2Token, id, { decision: 'APPROVE' }),
        await decide(reviewerToken, FAKE_UUID, { decision: 'APPROVE' }),
        await decide(reviewerToken, 'not-a-uuid', { decision: 'APPROVE' }),
      ];

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND_BODY);
      }
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(decisionAudits()).resolves.toEqual([]);
    });

    it('a REVIEWER on an unassigned UNDER_REVIEW application gets 404', async () => {
      const id = await decidable({ assignedReviewerId: null });

      const res = await decide(reviewerToken, id, { decision: 'REJECT' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
      await expect(applicationRow(id)).resolves.toMatchObject({ status: 'UNDER_REVIEW' });
    });

    it('after ADMIN reassigns to REVIEWER 2, REVIEWER gets 404 and REVIEWER 2 can decide', async () => {
      const id = await decidable();
      expect((await assign(adminToken, id, reviewer2Id)).status).toBe(200);

      const old = await decide(reviewerToken, id, { decision: 'APPROVE' });
      expect(old.status).toBe(404);
      expect(old.body).toEqual(NOT_FOUND_BODY);

      const res = await decide(reviewer2Token, id, { decision: 'APPROVE' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'APPROVED', assignedReviewerId: reviewer2Id });
      const audits = await decisionAudits();
      expect(audits.map((row) => row.actor_id)).toEqual([reviewer2Id]);
    });

    it('no token gets 401', async () => {
      const id = await decidable();

      const res = await decide(undefined, id, { decision: 'APPROVE' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationRow(id)).resolves.toMatchObject({ status: 'UNDER_REVIEW' });
    });

    it("a tampered token (REVIEWER 2 re-encoded with REVIEWER's id) gets 401", async () => {
      const id = await decidable();
      const [header, payload, signature] = reviewer2Token.split('.');
      const tampered = [
        header,
        base64UrlJson({ ...decodeSegment(payload), sub: reviewerId }),
        signature,
      ].join('.');

      const res = await decide(tampered, id, { decision: 'APPROVE' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      await expect(applicationRow(id)).resolves.toMatchObject({ status: 'UNDER_REVIEW' });
      await expect(decisionAudits()).resolves.toEqual([]);
    });
  });

  describe('denied (validation)', () => {
    it.each<[string, object]>([
      ["decision 'KYB_COMPLETE'", { decision: 'KYB_COMPLETE' }],
      ["decision 'SUBMIT'", { decision: 'SUBMIT' }],
      ['a missing decision', { note: 'no decision' }],
      ['a 2001-character note', { decision: 'REJECT', note: 'x'.repeat(2001) }],
      ['an extra status key', { decision: 'APPROVE', status: 'APPROVED' }],
      ['an extra kybStatus key', { decision: 'APPROVE', kybStatus: 'COMPLETED' }],
      ['a note with a NUL character', { decision: 'REJECT', note: 'fake\u0000note' }],
    ])('%s gets 400; row unchanged, no audit row', async (_l, body) => {
      const id = await decidable();
      const before = await applicationRow(id);

      const res = await decide(reviewerToken, id, body);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(decisionAudits()).resolves.toEqual([]);
    });

    it("a note containing the application's own raw tax ID gets 400 without echoing it; row unchanged, no audit row", async () => {
      const id = await decidable();
      const before = await applicationRow(id);
      // Different case and spaces instead of dashes: still the same ID.
      const note = `Verified ${RAW_TAX_ID.toLowerCase().replace(/-/g, ' ')}`;

      const res = await decide(reviewerToken, id, { decision: 'REQUEST_INFO', note });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'note must not contain the tax ID or national ID',
      });
      expect(JSON.stringify(res.body)).not.toContain(RAW_TAX_ID);
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(decisionAudits()).resolves.toEqual([]);
    });
  });

  describe('invalid state', () => {
    it('deciding in RISK_REVIEW (real submit, assigned during RISK_REVIEW) gets 409 INVALID_STATE_TRANSITION', async () => {
      const id = await createDraft();
      expect((await submit(salesToken, id)).status).toBe(200);
      expect((await assign(adminToken, id, reviewerId)).status).toBe(200);
      const before = await applicationRow(id);
      expect(before?.status).toBe('RISK_REVIEW');

      for (const decision of ['APPROVE', 'REJECT', 'REQUEST_INFO']) {
        const res = await decide(reviewerToken, id, { decision });
        expect(res.status).toBe(409);
        expect(res.body).toEqual(NOT_DECIDABLE_BODY);
      }
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(decisionAudits()).resolves.toEqual([]);
    });

    it.each(['DRAFT', 'INFO_REQUESTED', 'APPROVED', 'REJECTED'])(
      'deciding in %s gets 409 INVALID_STATE_TRANSITION',
      async (status) => {
        const id = await decidable({ status });
        const before = await applicationRow(id);

        for (const decision of ['APPROVE', 'REJECT', 'REQUEST_INFO']) {
          const res = await decide(reviewerToken, id, { decision });
          expect(res.status).toBe(409);
          expect(res.body).toEqual(NOT_DECIDABLE_BODY);
        }
        await expect(applicationRow(id)).resolves.toEqual(before);
        await expect(decisionAudits()).resolves.toEqual([]);
      },
    );

    it('a second decision after APPROVE gets 409 INVALID_STATE_TRANSITION', async () => {
      const id = await decidable();
      expect((await decide(reviewerToken, id, { decision: 'APPROVE' })).status).toBe(200);
      const before = await applicationRow(id);

      const res = await decide(reviewerToken, id, { decision: 'REJECT' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual(NOT_DECIDABLE_BODY);
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(decisionAudits()).resolves.toHaveLength(1);
    });

    it.each(['FAILED', 'PENDING'])(
      'APPROVE with kybStatus %s gets 409 KYB_NOT_COMPLETED; row unchanged, no audit row',
      async (kybStatus) => {
        const id = await decidable({ kybStatus });
        const before = await applicationRow(id);

        const res = await decide(reviewerToken, id, { decision: 'APPROVE' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual(KYB_NOT_COMPLETED_BODY);
        await expect(applicationRow(id)).resolves.toEqual(before);
        await expect(decisionAudits()).resolves.toEqual([]);
      },
    );
  });

  describe('concurrency', () => {
    it('two concurrent decisions: one 200, one 409; one audit row; the final status is the winner', async () => {
      const id = await decidable();

      const responses = await Promise.all([
        decide(reviewerToken, id, { decision: 'APPROVE' }),
        decide(reviewerToken, id, { decision: 'REJECT' }),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
      const winner = responses.find((res) => res.status === 200);
      const loser = responses.find((res) => res.status === 409);
      // A loser blocked on the row lock sees the bumped version (CONCURRENT_MODIFICATION); one
      // that reads after the commit sees the new status (INVALID_STATE_TRANSITION).
      expect([CONCURRENT_MODIFICATION_CODE, INVALID_STATE_TRANSITION_CODE]).toContain(
        (loser?.body as { code?: string }).code,
      );
      const winnerStatus = (winner?.body as ApplicationBody).status;
      await expect(applicationRow(id)).resolves.toMatchObject({ status: winnerStatus });
      const audits = await decisionAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.meta).toMatchObject({ to: winnerStatus });
    });

    // Spies the scoped read once and changes the row on a separate pool connection between the
    // read and the conditional UPDATE. The SELECT holds no row lock, so this does not block.
    async function decideWithChangeAfterRead(
      id: string,
      decision: string,
      changeSql: string,
    ): Promise<request.Response> {
      const repo = app.get(ApplicationsRepository);
      // Reference to the real method, taken before spying, so the mock does not call itself.
      const real = repo.findAccessible.bind(repo);
      const spy = jest
        .spyOn(repo, 'findAccessible')
        .mockImplementationOnce(async (appId, actor, manager) => {
          const found = await real(appId, actor, manager);
          await dataSource.query(changeSql, [appId]);
          return found;
        });
      try {
        return await decide(reviewerToken, id, { decision });
      } finally {
        spy.mockRestore();
      }
    }

    it('a lost race (version bumped between read and write) gets 409 CONCURRENT_MODIFICATION', async () => {
      const id = await decidable();
      const before = await applicationRow(id);

      const res = await decideWithChangeAfterRead(
        id,
        'REJECT',
        'UPDATE merchant_applications SET version = version + 1 WHERE id = $1',
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual(CONCURRENT_MODIFICATION_BODY);
      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'UNDER_REVIEW',
        version: (before?.version ?? 0) + 1,
        decision_note: null,
        decided_at: null,
      });
      await expect(decisionAudits()).resolves.toEqual([]);
    });

    it('the APPROVE WHERE guard: kyb_status set to FAILED after the read (same version) gets 409 CONCURRENT_MODIFICATION', async () => {
      const id = await decidable();
      const before = await applicationRow(id);

      const res = await decideWithChangeAfterRead(
        id,
        'APPROVE',
        "UPDATE merchant_applications SET kyb_status = 'FAILED' WHERE id = $1",
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual(CONCURRENT_MODIFICATION_BODY);
      await expect(applicationRow(id)).resolves.toMatchObject({
        status: 'UNDER_REVIEW',
        version: before?.version,
        kyb_status: 'FAILED',
        decided_at: null,
      });
      await expect(decisionAudits()).resolves.toEqual([]);
    });
  });

  describe('same transaction as the audit row', () => {
    it('a failed audit write gives 500 and leaves the row unchanged', async () => {
      const id = await decidable();
      const before = await applicationRow(id);
      const spy = jest
        .spyOn(app.get(AuditLogService), 'record')
        .mockRejectedValueOnce(new Error('audit write failed (test)'));
      try {
        const res = await decide(reviewerToken, id, { decision: 'APPROVE', note: NOTE_MARKER });

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_ERROR_BODY);
      } finally {
        spy.mockRestore();
      }
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(decisionAudits()).resolves.toEqual([]);
    });
  });

  it('full loop: request info → SALES edits → resubmit → new KYB check → UNDER_REVIEW → approve', async () => {
    // 1. Create and submit; the first check completes; ADMIN assigns afterwards.
    const id = await createDraft();
    expect((await submit(salesToken, id)).status).toBe(200);
    await expect(handle(id, 0, 1)).resolves.toBe('completed');
    expect((await assign(adminToken, id, reviewerId)).status).toBe(200);

    // 2. REQUEST_INFO with a note: the reviewer is kept.
    const note = `Please upload the lease. ${NOTE_MARKER}`;
    const requested = await decide(reviewerToken, id, { decision: 'REQUEST_INFO', note });
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ status: 'INFO_REQUESTED', decisionNote: note });
    await expect(applicationRow(id)).resolves.toMatchObject({
      status: 'INFO_REQUESTED',
      decision_note: note,
      assigned_reviewer_id: reviewerId,
    });

    // 3. SALES edits and resubmits: a new KYB check is queued.
    expect((await patch(salesToken, id, { businessName: 'Example Bakery Two' })).status).toBe(200);
    const resubmitted = await submit(salesToken, id);
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body).toMatchObject({ status: 'RISK_REVIEW' });
    await expect(applicationRow(id)).resolves.toMatchObject({
      status: 'RISK_REVIEW',
      submission_count: 2,
      kyb_status: 'PENDING',
      business_name: 'Example Bakery Two',
    });
    const job = await queue.getJob(kybCheckJobId(id, 2));
    expect(job?.id).toBe(`kyb-check:${id}:2`);

    // 4. The request stays readable until the next decision.
    const read = await get(salesToken, id);
    expect(read.status).toBe(200);
    expect((read.body as ApplicationBody).decisionNote).toBe(note);

    // 5. The second check completes: back to the same reviewer.
    await expect(handle(id, 0, 2)).resolves.toBe('completed');
    await expect(applicationRow(id)).resolves.toMatchObject({
      status: 'UNDER_REVIEW',
      kyb_status: 'COMPLETED',
      assigned_reviewer_id: reviewerId,
    });

    // 6. APPROVE.
    const approved = await decide(reviewerToken, id, { decision: 'APPROVE' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ ...MASKED, status: 'APPROVED', decisionNote: null });

    // 7. The audit trail, in order.
    const audits = await auditRows();
    expect(audits.map((row) => row.action)).toEqual([
      'APPLICATION_CREATED',
      'APPLICATION_SUBMITTED',
      'KYB_CHECK_COMPLETED',
      'REVIEWER_ASSIGNED',
      'DECISION_RECORDED',
      'APPLICATION_UPDATED',
      'APPLICATION_SUBMITTED',
      'KYB_CHECK_COMPLETED',
      'DECISION_RECORDED',
    ]);
    expect(
      audits.filter((row) => row.action === 'DECISION_RECORDED').map((row) => row.meta),
    ).toEqual([
      { decision: 'REQUEST_INFO', from: 'UNDER_REVIEW', to: 'INFO_REQUESTED' },
      { decision: 'APPROVE', from: 'UNDER_REVIEW', to: 'APPROVED' },
    ]);
    expect(fake.calls).toHaveLength(2);
    await expectNoteNotLeaked();
  });

  it('leak check: no raw sensitive value or token in application responses, logs or audit rows; the note only in responses', async () => {
    const id = await createDraft();
    expect((await submit(salesToken, id)).status).toBe(200);
    await expect(handle(id, 0, 1)).resolves.toBe('completed');
    expect((await assign(adminToken, id, reviewerId)).status).toBe(200);
    // 403, 404, 400 and 409 bodies, then a successful decision with the note.
    await decide(salesToken, id, { decision: 'APPROVE', note: NOTE_MARKER });
    await decide(salesBToken, id, { decision: 'APPROVE', note: NOTE_MARKER });
    await decide(reviewer2Token, id, { decision: 'APPROVE', note: NOTE_MARKER });
    await decide(reviewerToken, id, { decision: 'SUBMIT', note: NOTE_MARKER });
    const requested = await decide(reviewerToken, id, {
      decision: 'REQUEST_INFO',
      note: NOTE_MARKER,
    });
    expect(requested.status).toBe(200);
    await decide(reviewerToken, id, { decision: 'APPROVE', note: NOTE_MARKER });
    await get(salesToken, id);
    // A 500 from a failed DECISION_RECORDED write (created first, so the spy hits the decision).
    const failingId = await decidable();
    const spy = jest
      .spyOn(app.get(AuditLogService), 'record')
      .mockRejectedValueOnce(new Error('audit write failed (test)'));
    try {
      const failed = await decide(reviewerToken, failingId, {
        decision: 'REJECT',
        note: NOTE_MARKER,
      });
      expect(failed.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    // Positive check: the masked value is what the responses carry.
    expect(requested.body).toMatchObject(MASKED);
    expect((requested.body as ApplicationBody).decisionNote).toBe(NOTE_MARKER);

    const audits = await auditRows();
    expect(audits.map((row) => row.action)).toContain('DECISION_RECORDED');
    const stored = JSON.stringify(audits);
    const logs = capturedText();
    const secrets = [
      RAW_TAX_ID,
      RAW_NATIONAL_ID,
      RAW_OWNER_EMAIL,
      RAW_OWNER_PHONE,
      salesToken,
      salesBToken,
      reviewerToken,
      reviewer2Token,
      adminToken,
    ];
    for (const text of [logs, stored, ...responseTexts]) {
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }
    // The note is returned to viewers by design, so it is checked only in logs and audit rows.
    expect(logs).not.toContain(NOTE_MARKER);
    expect(stored).not.toContain(NOTE_MARKER);
  });
});
