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
import { UserRole } from '../src/common/common.enums';
import { BCRYPT_COST } from '../src/common/password';
import { KYB_CHECK_QUEUE } from '../src/kyb/kyb-job';
import { KYB_PROVIDER } from '../src/kyb/kyb-provider';
import { FakeKybProvider } from '../src/kyb/testing/fake-kyb-provider';
import { configureLogger } from '../src/logging/logger';
import { UsersRepository } from '../src/users/users.repository';
import { resetApplicationData, resetTables } from './utils/test-db';

// The whole authorization matrix of docs/adrs/auth.md in one place, table-driven: every id route
// × seven caller types, the collection routes, login, unknown / malformed ids and the bypass cases
// of docs/adrs/testing.md. Real Postgres and Redis; the KYB worker is off (test-env.ts) and the
// deterministic FakeKybProvider replaces the provider. Overlap with the other specs is on purpose.

// Fake users only (@example.com, made-up names). Passwords come from the SEED_* env variables.
const ADMIN_EMAIL = 'authz-admin@example.com';
const REVIEWER_EMAIL = 'authz-reviewer@example.com';
const REVIEWER_2_EMAIL = 'authz-reviewer-2@example.com';
const SALES_EMAIL = 'authz-sales@example.com';
const SALES_2_EMAIL = 'authz-sales-2@example.com';

// Fake application data. The sensitive values are asserted never to leave the database raw.
const RAW_TAX_ID = 'PAN-FAKE-00009753';
const RAW_NATIONAL_ID = 'NID-FAKE-8642';
const RAW_OWNER_EMAIL = 'authz-owner@example.com';
const RAW_OWNER_PHONE = '+977-0000000456';
const CHANGED_OWNER_EMAIL = 'authz-owner2@example.com';

const PAYLOAD = {
  businessName: 'Example Hardware',
  legalBusinessName: 'Example Hardware Pvt. Ltd.',
  businessType: 'PRIVATE_LIMITED',
  registrationNumber: 'REG-FAKE-0009',
  taxId: RAW_TAX_ID,
  ownerFullName: 'Kim Example',
  ownerEmail: RAW_OWNER_EMAIL,
  ownerPhone: RAW_OWNER_PHONE,
  ownerNationalId: RAW_NATIONAL_ID,
  merchantCategoryCode: '5251',
  websiteUrl: 'https://hardware.example.com',
  expectedMonthlyVolumeMinor: 2500000,
  averageTicketSizeMinor: 150000,
};

// A made-up UUID that never belongs to a row (the database generates v4 UUIDs).
const FAKE_UUID = '00000000-0000-4000-8000-000000000009';
const MALFORMED_ID = 'not-a-uuid';

const UNAUTHORIZED_BODY = { statusCode: 401, message: 'Unauthorized' };
const FORBIDDEN_BODY = { statusCode: 403, message: 'Forbidden' };
const NOT_FOUND_BODY = {
  statusCode: 404,
  error: 'Not Found',
  message: APPLICATION_NOT_FOUND_MESSAGE,
};

// The seven caller types. TAMPERED is SALES_OWNER's token with the role re-encoded as ADMIN and
// the original signature kept.
type Actor =
  'ADMIN' | 'REVIEWER' | 'REVIEWER_OTHER' | 'SALES_OWNER' | 'SALES_OTHER' | 'NO_TOKEN' | 'TAMPERED';

const ACTORS: readonly Actor[] = [
  'ADMIN',
  'REVIEWER',
  'REVIEWER_OTHER',
  'SALES_OWNER',
  'SALES_OTHER',
  'NO_TOKEN',
  'TAMPERED',
];

interface RouteCase {
  name: string;
  // The fixture status in which the allowed cells succeed.
  status: string;
  call(token: string | undefined, id: string): Promise<request.Response>;
  expected: Record<Actor, number>;
  // For a route that writes: the columns an allowed (200) call must have changed.
  changed?: () => Partial<ApplicationRow>;
}

interface ApplicationBody {
  id: string;
}

interface ListBody {
  items: ApplicationBody[];
  total: number;
}

// The columns the spec reads by name. applicationRow() returns every column (SELECT *), so the
// snapshot comparisons cover the whole row.
interface ApplicationRow {
  status: string;
  version: number;
  sales_owner_id: string;
  assigned_reviewer_id: string | null;
  decision_note: string | null;
  decided_at: Date | null;
  business_name: string;
  kyb_status: string;
  submission_count: number;
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
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

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function bodyFor(status: number): object {
  if (status === 401) {
    return UNAUTHORIZED_BODY;
  }
  if (status === 403) {
    return FORBIDDEN_BODY;
  }
  return NOT_FOUND_BODY;
}

// bcrypt cost 12: hashing the users and the logins take a noticeable time.
jest.setTimeout(60_000);

describe('Authorization matrix (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  const ids: Partial<Record<Actor, string>> = {};
  const tokens: Partial<Record<Actor, string>> = {};
  const passwords: Partial<Record<UserRole, string>> = {};
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  // The logger prints through console.log / console.error, which Jest buffers per file, so the
  // stream spies alone would miss those lines.
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  // Every application response body of the current test (never a login body), for the leak check.
  let responseTexts: string[];

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Logger on, after every spy is installed, so the leak check sees real output.
    configureLogger({ production: false });

    const module: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KYB_PROVIDER)
      .useValue(new FakeKybProvider())
      .compile();
    app = module.createNestApplication<INestApplication<App>>();
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
    passwords[UserRole.SALES] = salesPassword;
    passwords[UserRole.REVIEWER] = reviewerPassword;
    passwords[UserRole.ADMIN] = adminPassword;
    const salesHash = await bcrypt.hash(salesPassword, BCRYPT_COST);
    const reviewerHash = await bcrypt.hash(reviewerPassword, BCRYPT_COST);
    const adminHash = await bcrypt.hash(adminPassword, BCRYPT_COST);

    await resetTables(dataSource);
    const users = app.get(UsersRepository);
    const fixtures: Array<[Actor, string, string, UserRole, string, string]> = [
      ['ADMIN', ADMIN_EMAIL, 'Avery Admin', UserRole.ADMIN, adminHash, adminPassword],
      [
        'REVIEWER',
        REVIEWER_EMAIL,
        'Robin Reviewer',
        UserRole.REVIEWER,
        reviewerHash,
        reviewerPassword,
      ],
      [
        'REVIEWER_OTHER',
        REVIEWER_2_EMAIL,
        'Reese Reviewer',
        UserRole.REVIEWER,
        reviewerHash,
        reviewerPassword,
      ],
      ['SALES_OWNER', SALES_EMAIL, 'Sam Sales', UserRole.SALES, salesHash, salesPassword],
      ['SALES_OTHER', SALES_2_EMAIL, 'Sky Sales', UserRole.SALES, salesHash, salesPassword],
    ];
    for (const [actor, email, fullName, role, passwordHash, password] of fixtures) {
      await users.insertIfAbsent({ email, fullName, role, passwordHash });
      ids[actor] = await userId(email);
      const res = await login(email, password);
      expect(res.status).toBe(200);
      tokens[actor] = (res.body as { accessToken: string }).accessToken;
    }

    const [header, payload, signature] = tokenOf('SALES_OWNER').split('.');
    tokens.TAMPERED = [
      header,
      base64UrlJson({ ...decodeSegment(payload), role: 'ADMIN' }),
      signature,
    ].join('.');
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
    responseTexts = [];
    stdout.mockClear();
    stderr.mockClear();
    consoleLog.mockClear();
    consoleError.mockClear();
  });

  function server(): App {
    return app.getHttpServer();
  }

  function idOf(actor: Actor): string {
    const id = ids[actor];
    if (id === undefined) {
      throw new Error(`no user id for ${actor}`);
    }
    return id;
  }

  function tokenOf(actor: Actor): string {
    const token = tokens[actor];
    if (token === undefined) {
      throw new Error(`no token for ${actor}`);
    }
    return token;
  }

  // undefined for NO_TOKEN; every other actor has a token from beforeAll.
  function tokenFor(actor: Actor): string | undefined {
    return actor === 'NO_TOKEN' ? undefined : tokenOf(actor);
  }

  function passwordOf(role: UserRole): string {
    const password = passwords[role];
    if (password === undefined) {
      throw new Error(`no password for ${role}`);
    }
    return password;
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

  // Never tracked: a login body holds an access token.
  async function login(
    email: string,
    password: string,
    bearer?: string,
  ): Promise<request.Response> {
    return withToken(request(server()).post('/auth/login'), bearer).send({ email, password });
  }

  function track(res: request.Response): request.Response {
    responseTexts.push(JSON.stringify(res.body));
    return res;
  }

  function withToken(req: request.Test, token: string | undefined): request.Test {
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  }

  async function create(token: string | undefined, body: object): Promise<request.Response> {
    return track(await withToken(request(server()).post('/applications'), token).send(body));
  }

  async function list(token: string | undefined): Promise<request.Response> {
    return track(await withToken(request(server()).get('/applications'), token));
  }

  async function getOne(token: string | undefined, id: string): Promise<request.Response> {
    return track(await withToken(request(server()).get(`/applications/${id}`), token));
  }

  async function patch(
    token: string | undefined,
    id: string,
    body: object,
  ): Promise<request.Response> {
    return track(await withToken(request(server()).patch(`/applications/${id}`), token).send(body));
  }

  async function submit(token: string | undefined, id: string): Promise<request.Response> {
    return track(await withToken(request(server()).post(`/applications/${id}/submit`), token));
  }

  async function assign(
    token: string | undefined,
    id: string,
    reviewerId: string,
  ): Promise<request.Response> {
    return track(
      await withToken(request(server()).post(`/applications/${id}/assign`), token).send({
        reviewerId,
      }),
    );
  }

  async function transferOwner(
    token: string | undefined,
    id: string,
    salesOwnerId: string,
  ): Promise<request.Response> {
    return track(
      await withToken(request(server()).post(`/applications/${id}/transfer-owner`), token).send({
        salesOwnerId,
      }),
    );
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

  async function auditLogs(token: string | undefined, id: string): Promise<request.Response> {
    return track(await withToken(request(server()).get(`/applications/${id}/audit-logs`), token));
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

  // A SALES_OWNER application in `status`, assigned to REVIEWER, with a completed KYB check.
  async function fixture(status: string): Promise<string> {
    const res = await create(tokenOf('SALES_OWNER'), PAYLOAD);
    expect(res.status).toBe(201);
    const id = (res.body as ApplicationBody).id;
    await forceState(id, { status, assignedReviewerId: idOf('REVIEWER'), kybStatus: 'COMPLETED' });
    return id;
  }

  async function applicationRow(id: string): Promise<ApplicationRow | undefined> {
    const rows: ApplicationRow[] = await dataSource.query(
      'SELECT * FROM merchant_applications WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async function applicationCount(): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource.query(
      'SELECT count(*) AS count FROM merchant_applications',
    );
    return Number(rows[0]?.count);
  }

  async function auditRows(): Promise<AuditRow[]> {
    return dataSource.query('SELECT * FROM audit_logs ORDER BY created_at, id');
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

  // docs/adrs/auth.md matrix, one row per id route. Bodies are always valid, so the status is
  // decided by the authorization rules only.
  const ROUTES: RouteCase[] = [
    {
      name: 'GET /applications/:id',
      status: 'UNDER_REVIEW',
      call: (token, id) => getOne(token, id),
      expected: {
        ADMIN: 200,
        REVIEWER: 200,
        REVIEWER_OTHER: 404,
        SALES_OWNER: 200,
        SALES_OTHER: 404,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
    {
      name: 'PATCH /applications/:id',
      status: 'INFO_REQUESTED',
      // Non-empty on purpose: an empty body gets 400 "No fields to update" before the lookup.
      call: (token, id) => patch(token, id, { businessName: 'Example Changed' }),
      changed: () => ({ business_name: 'Example Changed' }),
      expected: {
        ADMIN: 200,
        REVIEWER: 403,
        REVIEWER_OTHER: 403,
        SALES_OWNER: 200,
        SALES_OTHER: 404,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
    {
      name: 'POST /applications/:id/submit',
      status: 'INFO_REQUESTED',
      call: (token, id) => submit(token, id),
      expected: {
        ADMIN: 200,
        REVIEWER: 403,
        REVIEWER_OTHER: 403,
        SALES_OWNER: 200,
        SALES_OTHER: 404,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
    {
      name: 'POST /applications/:id/assign',
      status: 'UNDER_REVIEW',
      // A valid REVIEWER target, so the 400 target check never hides the lookup.
      call: (token, id) => assign(token, id, idOf('REVIEWER_OTHER')),
      changed: () => ({ assigned_reviewer_id: idOf('REVIEWER_OTHER') }),
      expected: {
        ADMIN: 200,
        REVIEWER: 403,
        REVIEWER_OTHER: 403,
        SALES_OWNER: 403,
        SALES_OTHER: 403,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
    {
      name: 'POST /applications/:id/transfer-owner',
      status: 'UNDER_REVIEW',
      // A valid SALES target, so the 400 target check never hides the lookup.
      call: (token, id) => transferOwner(token, id, idOf('SALES_OTHER')),
      changed: () => ({ sales_owner_id: idOf('SALES_OTHER') }),
      expected: {
        ADMIN: 200,
        REVIEWER: 403,
        REVIEWER_OTHER: 403,
        SALES_OWNER: 403,
        SALES_OTHER: 403,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
    {
      name: 'POST /applications/:id/decision',
      status: 'UNDER_REVIEW',
      call: (token, id) => decide(token, id, { decision: 'REJECT' }),
      changed: () => ({ status: 'REJECTED', decided_at: expect.any(Date) as Date }),
      expected: {
        ADMIN: 403,
        REVIEWER: 200,
        REVIEWER_OTHER: 404,
        SALES_OWNER: 403,
        SALES_OTHER: 403,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
    {
      name: 'GET /applications/:id/audit-logs',
      status: 'UNDER_REVIEW',
      call: (token, id) => auditLogs(token, id),
      expected: {
        ADMIN: 200,
        REVIEWER: 403,
        REVIEWER_OTHER: 403,
        SALES_OWNER: 403,
        SALES_OTHER: 403,
        NO_TOKEN: 401,
        TAMPERED: 401,
      },
    },
  ];

  const MATRIX: Array<[string, Actor, number, RouteCase]> = ROUTES.flatMap((route) =>
    ACTORS.map((actor): [string, Actor, number, RouteCase] => [
      route.name,
      actor,
      route.expected[actor],
      route,
    ]),
  );

  describe('id routes', () => {
    it.each(MATRIX)('matrix: %s as %s → %d', async (_name, actor, expected, route) => {
      const id = await fixture(route.status);
      const before = await applicationRow(id);
      const auditsBefore = await auditRows();

      const res = await route.call(tokenFor(actor), id);

      expect(res.status).toBe(expected);
      if (expected !== 200) {
        expect(res.body).toEqual(bodyFor(expected));
        await expect(applicationRow(id)).resolves.toEqual(before);
        await expect(auditRows()).resolves.toEqual(auditsBefore);
      } else if (route.changed !== undefined) {
        await expect(applicationRow(id)).resolves.toMatchObject(route.changed());
      }
    });
  });

  describe('POST /applications', () => {
    const CASES: Array<[Actor, number, () => object]> = [
      ['ADMIN', 201, () => ({ ...PAYLOAD, salesOwnerId: idOf('SALES_OWNER') })],
      ['SALES_OWNER', 201, () => PAYLOAD],
      ['REVIEWER', 403, () => PAYLOAD],
      ['NO_TOKEN', 401, () => PAYLOAD],
      ['TAMPERED', 401, () => ({ ...PAYLOAD, salesOwnerId: idOf('SALES_OTHER') })],
    ];

    it.each(CASES)('POST /applications as %s → %d', async (actor, expected, body) => {
      const res = await create(tokenFor(actor), body());

      expect(res.status).toBe(expected);
      if (expected === 201) {
        expect(res.body).toMatchObject({ status: 'DRAFT', salesOwnerId: idOf('SALES_OWNER') });
      } else {
        expect(res.body).toEqual(bodyFor(expected));
        await expect(applicationCount()).resolves.toBe(0);
        await expect(auditRows()).resolves.toEqual([]);
      }
    });
  });

  describe('GET /applications', () => {
    // [actor, status, sees the fixture]
    const CASES: Array<[Actor, number, boolean]> = [
      ['ADMIN', 200, true],
      ['REVIEWER', 200, true],
      ['REVIEWER_OTHER', 200, false],
      ['SALES_OWNER', 200, true],
      ['SALES_OTHER', 200, false],
      ['NO_TOKEN', 401, false],
      ['TAMPERED', 401, false],
    ];

    it.each(CASES)(
      'GET /applications as %s → %d, scoped (sees the fixture: %s)',
      async (actor, expected, sees) => {
        const id = await fixture('UNDER_REVIEW');

        const res = await list(tokenFor(actor));

        expect(res.status).toBe(expected);
        if (expected === 200) {
          const body = res.body as ListBody;
          expect(body.total).toBe(sees ? 1 : 0);
          expect(body.items.map((item) => item.id)).toEqual(sees ? [id] : []);
        } else {
          expect(res.body).toEqual(UNAUTHORIZED_BODY);
        }
      },
    );
  });

  describe('POST /auth/login (public)', () => {
    const CASES: Array<[UserRole, string]> = [
      [UserRole.ADMIN, ADMIN_EMAIL],
      [UserRole.REVIEWER, REVIEWER_EMAIL],
      [UserRole.SALES, SALES_EMAIL],
    ];

    it.each(CASES)('POST /auth/login as %s → 200', async (role, email) => {
      const res = await login(email, passwordOf(role));

      expect(res.status).toBe(200);
      expect(typeof (res.body as { accessToken?: unknown }).accessToken).toBe('string');
    });

    it('wrong password → 401', async () => {
      const res = await login(SALES_EMAIL, `${passwordOf(UserRole.SALES)}-wrong`);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
      expect((res.body as { accessToken?: unknown }).accessToken).toBeUndefined();
    });

    it('public route ignores a tampered bearer → 200', async () => {
      const res = await login(SALES_EMAIL, passwordOf(UserRole.SALES), tokenOf('TAMPERED'));

      expect(res.status).toBe(200);
      expect(typeof (res.body as { accessToken?: unknown }).accessToken).toBe('string');
    });
  });

  describe('unknown or malformed id', () => {
    const ID_ACTORS: readonly Actor[] = ['ADMIN', 'REVIEWER', 'SALES_OWNER', 'NO_TOKEN'];

    // NO_TOKEN → 401; a role the route's @Roles denies → 403 (the role check runs before the
    // lookup); otherwise the same 404 as an out-of-scope id.
    function unknownIdStatus(route: RouteCase, actor: Actor): number {
      const cell = route.expected[actor];
      return cell === 401 || cell === 403 ? cell : 404;
    }

    const CASES: Array<[string, string, Actor, number, RouteCase]> = ROUTES.flatMap((route) =>
      [FAKE_UUID, MALFORMED_ID].flatMap((id) =>
        ID_ACTORS.map((actor): [string, string, Actor, number, RouteCase] => [
          id,
          route.name,
          actor,
          unknownIdStatus(route, actor),
          route,
        ]),
      ),
    );

    it.each(CASES)('unknown id %s on %s as %s → %d', async (id, _name, actor, expected, route) => {
      const res = await route.call(tokenFor(actor), id);

      expect(res.status).toBe(expected);
      expect(res.body).toEqual(bodyFor(expected));
      await expect(applicationCount()).resolves.toBe(0);
      await expect(auditRows()).resolves.toEqual([]);
    });
  });

  describe('bypass cases', () => {
    it.each<[string, object]>([
      ['kybScore', { kybScore: 10 }],
      ['version', { version: 99 }],
      ['meta', { meta: { source: 'test' } }],
    ])('denied: PATCH mass-assignment of %s → 400', async (key, body) => {
      const id = await fixture('INFO_REQUESTED');
      const before = await applicationRow(id);
      const auditsBefore = await auditRows();

      const res = await patch(tokenOf('SALES_OWNER'), id, body);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(JSON.stringify(res.body)).toContain(`property ${key} should not exist`);
      await expect(applicationRow(id)).resolves.toEqual(before);
      await expect(auditRows()).resolves.toEqual(auditsBefore);
    });

    it('only the assigned REVIEWER may decide: other reviewer 404, assigned reviewer 200, one audit row', async () => {
      const id = await fixture('UNDER_REVIEW');
      const before = await applicationRow(id);

      const other = await decide(tokenOf('REVIEWER_OTHER'), id, { decision: 'REJECT' });
      expect(other.status).toBe(404);
      expect(other.body).toEqual(NOT_FOUND_BODY);
      await expect(applicationRow(id)).resolves.toEqual(before);

      const assigned = await decide(tokenOf('REVIEWER'), id, { decision: 'REJECT' });
      expect(assigned.status).toBe(200);
      expect(assigned.body).toMatchObject({ id, status: 'REJECTED' });

      const decisions = (await auditRows()).filter((row) => row.action === 'DECISION_RECORDED');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        actor_id: idOf('REVIEWER'),
        actor_role: 'REVIEWER',
        entity_id: id,
      });
    });
  });

  // What this proves: the application responses and the audit rows never hold a raw sensitive
  // value, a password, a password hash or a token. No request path logs today (only the KYB queue
  // and worker call logInfo/logError, and the worker is off), so the captured log text is most
  // likely empty; the not-contain checks on it stay as a guard for when a request path starts
  // logging.
  it('never returns or audits a raw sensitive value, a password, a hash or a token', async () => {
    // 1. Fixture: the create (201) response is tracked too.
    const id = await fixture('INFO_REQUESTED');

    // 2. One allowed call per route, in an order that keeps each one valid, plus a 409 and a 400.
    expect((await list(tokenOf('SALES_OWNER'))).status).toBe(200);
    const shown = await getOne(tokenOf('ADMIN'), id);
    expect(shown.status).toBe(200);
    expect(
      (await patch(tokenOf('SALES_OWNER'), id, { ownerEmail: CHANGED_OWNER_EMAIL })).status,
    ).toBe(200);
    expect((await submit(tokenOf('SALES_OWNER'), id)).status).toBe(200);
    expect((await submit(tokenOf('SALES_OWNER'), id)).status).toBe(409);
    expect((await assign(tokenOf('ADMIN'), id, idOf('REVIEWER'))).status).toBe(200);
    expect((await transferOwner(tokenOf('ADMIN'), id, idOf('SALES_OTHER'))).status).toBe(200);
    expect((await transferOwner(tokenOf('ADMIN'), id, idOf('REVIEWER'))).status).toBe(400);
    // The worker is off, so the KYB result is set by hand.
    await forceState(id, { status: 'UNDER_REVIEW', kybStatus: 'COMPLETED' });
    expect((await decide(tokenOf('REVIEWER'), id, { decision: 'REJECT' })).status).toBe(200);
    expect((await auditLogs(tokenOf('ADMIN'), id)).status).toBe(200);

    // 3. One denied (404) and one TAMPERED (401) call.
    expect((await getOne(tokenOf('REVIEWER_OTHER'), id)).status).toBe(404);
    expect((await getOne(tokenOf('TAMPERED'), id)).status).toBe(401);

    // 4. One successful and one wrong-password login. Never tracked: a login body holds a token.
    expect((await login(SALES_EMAIL, passwordOf(UserRole.SALES))).status).toBe(200);
    expect((await login(SALES_EMAIL, `${passwordOf(UserRole.SALES)}-wrong`)).status).toBe(401);

    // 5. Positive checks first, so the checks below cannot pass on silent failures.
    expect(responseTexts.length).toBeGreaterThan(0);
    // The GET response shows the masked shape with the right last digits.
    expect(shown.body).toMatchObject({
      taxId: expect.stringMatching(/^•+9753$/) as string,
      ownerNationalId: expect.stringMatching(/^•+8642$/) as string,
      ownerEmail: 'a•••@example.com',
      ownerPhone: expect.stringMatching(/^•+456$/) as string,
    });
    const audits = await auditRows();
    const actions = audits.map((row) => row.action);
    for (const action of [
      'APPLICATION_SUBMITTED',
      'REVIEWER_ASSIGNED',
      'OWNERSHIP_TRANSFERRED',
      'DECISION_RECORDED',
      'LOGIN_FAILED',
    ]) {
      expect(actions).toContain(action);
    }
    // The failed login's email is stored masked.
    const failed = audits.find((row) => row.action === 'LOGIN_FAILED');
    expect(failed?.meta).toEqual({ email: 'a•••@example.com' });

    // 6. No raw sensitive value, password, hash or token anywhere. The cores in front of the last
    // digits a mask shows are checked too, so a partial leak is caught as well.
    const texts = [capturedText(), JSON.stringify(audits), ...responseTexts];
    const secrets = [
      RAW_TAX_ID,
      '00009753',
      'FAKE-0000',
      RAW_NATIONAL_ID,
      'FAKE-8642',
      RAW_OWNER_EMAIL,
      CHANGED_OWNER_EMAIL,
      'authz-owner',
      SALES_EMAIL,
      RAW_OWNER_PHONE,
      '0000000456',
      '9770000000',
      passwordOf(UserRole.ADMIN),
      passwordOf(UserRole.REVIEWER),
      passwordOf(UserRole.SALES),
      '$2b$',
      'passwordHash',
      'password_hash',
      ...ACTORS.filter((actor) => actor !== 'NO_TOKEN').map((actor) => tokenOf(actor)),
    ];
    for (const text of texts) {
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
