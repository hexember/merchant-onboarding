import { randomBytes } from 'node:crypto';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthUser } from '../src/auth/auth-user';
import { CurrentUser } from '../src/auth/decorators/current-user.decorator';
import { Roles } from '../src/auth/decorators/roles.decorator';
import { AppLogger } from '../src/logging/app-logger.service';
import { UserRole } from '../src/common/common.enums';
import { BCRYPT_COST } from '../src/common/password';
import { setupSwagger } from '../src/common/swagger';
import { UsersRepository } from '../src/users/users.repository';
import { resetTables } from './utils/test-db';

// Fake users only (@example.com, made-up names). Passwords come from the SEED_* env variables.
const SALES_EMAIL = 'sales@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const UNKNOWN_EMAIL = 'nobody@example.com';

const UNAUTHORIZED_BODY = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Unauthorized',
  code: 'UNAUTHORIZED',
};

const INVALID_CREDENTIALS_BODY = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Invalid credentials',
  code: 'UNAUTHORIZED',
};

const FORBIDDEN_BODY = {
  statusCode: 403,
  error: 'Forbidden',
  message: 'Forbidden',
  code: 'FORBIDDEN',
};

// Test-only controller; it exists only inside this spec and reaches no application data.
@Controller('auth-e2e-test')
class AuthProbeController {
  // No @Roles: any authenticated user.
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Get('admin-only')
  @Roles(UserRole.ADMIN)
  adminOnly(): { ok: true } {
    return { ok: true };
  }
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
}

interface DecodedClaims {
  sub: string;
  role: string;
  iat: number;
  exp: number;
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

// bcrypt cost 12: building the app (dummy hash) and each login take a noticeable time.
jest.setTimeout(60_000);

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let salesPassword: string;
  let adminPassword: string;
  let salesHash: string;
  let adminHash: string;
  let salesId: string;
  let adminId: string;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [AuthProbeController],
    }).compile();
    app = module.createNestApplication<INestApplication<App>>({ bufferLogs: true });
    app.useLogger(app.get(AppLogger));
    setupSwagger(app, true);
    await app.init();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    // A missing variable fails here and names it.
    const config = app.get(ConfigService);
    salesPassword = config.getOrThrow<string>('SEED_SALES_PASSWORD');
    adminPassword = config.getOrThrow<string>('SEED_ADMIN_PASSWORD');
    // Hashed once; each test re-inserts the users after the tables are emptied.
    salesHash = await bcrypt.hash(salesPassword, BCRYPT_COST);
    adminHash = await bcrypt.hash(adminPassword, BCRYPT_COST);
  });

  afterAll(async () => {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  beforeEach(async () => {
    await resetTables(dataSource);
    const users = app.get(UsersRepository);
    await users.insertIfAbsent({
      email: SALES_EMAIL,
      fullName: 'Sam Sales',
      role: UserRole.SALES,
      passwordHash: salesHash,
    });
    await users.insertIfAbsent({
      email: ADMIN_EMAIL,
      fullName: 'Alex Admin',
      role: UserRole.ADMIN,
      passwordHash: adminHash,
    });
    salesId = await userId(SALES_EMAIL);
    adminId = await userId(ADMIN_EMAIL);
    stdout.mockClear();
    stderr.mockClear();
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

  async function auditRows(): Promise<AuditRow[]> {
    return dataSource.query(
      'SELECT actor_type, actor_id, actor_role, action, entity_type, entity_id, meta FROM audit_logs ORDER BY created_at',
    );
  }

  function chunks(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  // Everything written to stdout and stderr since the last mockClear.
  function capturedText(): string {
    return [...chunks(stdout), ...chunks(stderr)].join('');
  }

  async function loginToken(email: string, password: string): Promise<string> {
    const res = await request(server()).post('/auth/login').send({ email, password }).expect(200);
    const body = res.body as { accessToken: string };
    return body.accessToken;
  }

  describe('POST /auth/login', () => {
    it('returns an HS256 token for the SALES user and audits LOGIN_SUCCEEDED', async () => {
      const res = await request(server())
        .post('/auth/login')
        .send({ email: SALES_EMAIL, password: salesPassword })
        .expect(200);

      const body = res.body as { accessToken: string; expiresIn: number };
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresIn']);
      expect(body.expiresIn).toBe(3600);
      const claims = await jwtService.verifyAsync<DecodedClaims>(body.accessToken);
      expect(claims.sub).toBe(salesId);
      expect(claims.role).toBe('SALES');
      expect(claims.exp - claims.iat).toBe(3600);
      expect(decodeSegment(body.accessToken.split('.')[0]).alg).toBe('HS256');
      await expect(auditRows()).resolves.toEqual([
        {
          actor_type: 'USER',
          actor_id: salesId,
          actor_role: 'SALES',
          action: 'LOGIN_SUCCEEDED',
          entity_type: 'user',
          entity_id: salesId,
          meta: { email: 's•••@example.com' },
        },
      ]);
    });

    it('accepts an uppercase email (normalised before lookup)', async () => {
      await request(server())
        .post('/auth/login')
        .send({ email: 'SALES@EXAMPLE.COM', password: salesPassword })
        .expect(200);
    });

    it('denied: a wrong password gets the generic 401 and audits LOGIN_FAILED naming the user', async () => {
      const res = await request(server())
        .post('/auth/login')
        .send({ email: SALES_EMAIL, password: `${salesPassword}-wrong` })
        .expect(401);

      expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
      await expect(auditRows()).resolves.toEqual([
        {
          actor_type: 'USER',
          actor_id: null,
          actor_role: null,
          action: 'LOGIN_FAILED',
          entity_type: 'user',
          entity_id: salesId,
          meta: { email: 's•••@example.com' },
        },
      ]);
    });

    it('denied: an unknown email gets the same 401 body and audits LOGIN_FAILED with no user', async () => {
      const res = await request(server())
        .post('/auth/login')
        .send({ email: UNKNOWN_EMAIL, password: salesPassword })
        .expect(401);

      expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
      await expect(auditRows()).resolves.toEqual([
        {
          actor_type: 'USER',
          actor_id: null,
          actor_role: null,
          action: 'LOGIN_FAILED',
          entity_type: 'user',
          entity_id: null,
          meta: { email: 'n•••@example.com' },
        },
      ]);
    });

    it.each<[string, Record<string, unknown>]>([
      [
        'an extra field (role)',
        { email: SALES_EMAIL, password: 'fixture-password', role: 'ADMIN' },
      ],
      ['a missing password', { email: SALES_EMAIL }],
      ['a malformed email', { email: 'not-an-email', password: 'fixture-password' }],
    ])('denied: %s gets 400 and writes no audit row', async (_label, body) => {
      const res = await request(server()).post('/auth/login').send(body).expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
      await expect(auditRows()).resolves.toEqual([]);
    });

    it('never logs or audits the password, the raw email or the issued token', async () => {
      const token = await loginToken(SALES_EMAIL, salesPassword);
      await request(server())
        .post('/auth/login')
        .send({ email: SALES_EMAIL, password: `${salesPassword}-wrong` })
        .expect(401);
      await request(server())
        .post('/auth/login')
        .send({ email: UNKNOWN_EMAIL, password: salesPassword })
        .expect(401);

      const stored = JSON.stringify(await auditRows());
      for (const text of [capturedText(), stored]) {
        expect(text).not.toContain(salesPassword);
        expect(text).not.toContain(SALES_EMAIL);
        expect(text).not.toContain(UNKNOWN_EMAIL);
        expect(text).not.toContain(token);
      }
    });
  });

  describe('GET /auth-e2e-test/me', () => {
    async function expectUnauthorized(path: string, authorization?: string): Promise<void> {
      const req = request(server()).get(path);
      if (authorization !== undefined) {
        req.set('Authorization', authorization);
      }
      const res = await req.expect(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      if (authorization !== undefined) {
        const token = authorization.split(' ')[1] ?? '';
        if (token !== '') {
          expect(JSON.stringify(res.body)).not.toContain(token);
        }
      }
    }

    it('denied: no token gets 401', async () => {
      await expectUnauthorized('/auth-e2e-test/me');
    });

    it('denied: the Basic scheme gets 401', async () => {
      await expectUnauthorized('/auth-e2e-test/me', 'Basic ZmFrZTpmYWtl');
    });

    it('denied: a tampered token (role re-encoded as ADMIN) gets 401, also on admin-only', async () => {
      const token = await loginToken(SALES_EMAIL, salesPassword);
      const [header, payload, signature] = token.split('.');
      const tampered = [
        header,
        base64UrlJson({ ...decodeSegment(payload), role: 'ADMIN' }),
        signature,
      ].join('.');

      await expectUnauthorized('/auth-e2e-test/me', `Bearer ${tampered}`);
      await expectUnauthorized('/auth-e2e-test/admin-only', `Bearer ${tampered}`);
    });

    it('denied: a token signed with a different secret gets 401', async () => {
      // Random runtime secret for the "wrong key" token. It never decides an assertion: any key
      // other than the app's gives the same 401.
      const token = await jwtService.signAsync(
        { sub: salesId, role: UserRole.SALES },
        { secret: randomBytes(32).toString('hex') },
      );

      await expectUnauthorized('/auth-e2e-test/me', `Bearer ${token}`);
    });

    it('denied: an expired token gets 401', async () => {
      // No exp in the payload: the module's signOptions.expiresIn is merged in, so a negative
      // expiresIn here sets exp = iat - 60.
      const token = await jwtService.signAsync(
        { sub: salesId, role: UserRole.SALES },
        { expiresIn: -60 },
      );

      await expectUnauthorized('/auth-e2e-test/me', `Bearer ${token}`);
    });

    it('denied: an unsigned alg none token gets 401', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = [
        base64UrlJson({ alg: 'none', typ: 'JWT' }),
        base64UrlJson({ sub: adminId, role: UserRole.ADMIN, iat: now, exp: now + 3600 }),
        '',
      ].join('.');

      await expectUnauthorized('/auth-e2e-test/me', `Bearer ${token}`);
      await expectUnauthorized('/auth-e2e-test/admin-only', `Bearer ${token}`);
    });

    it('denied: a valid token for a user deleted after login gets 401', async () => {
      const token = await loginToken(SALES_EMAIL, salesPassword);
      // Test-only cleanup SQL; the app has no delete-user path.
      await dataSource.query('DELETE FROM users WHERE id = $1', [salesId]);

      await expectUnauthorized('/auth-e2e-test/me', `Bearer ${token}`);
    });

    it('returns the caller for a SALES token from login', async () => {
      const token = await loginToken(SALES_EMAIL, salesPassword);

      const res = await request(server())
        .get('/auth-e2e-test/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toEqual({ id: salesId, role: 'SALES' });
    });
  });

  describe('GET /auth-e2e-test/admin-only', () => {
    it('denied: a SALES token gets 403', async () => {
      const token = await loginToken(SALES_EMAIL, salesPassword);

      const res = await request(server())
        .get('/auth-e2e-test/admin-only')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(res.body).toEqual(FORBIDDEN_BODY);
    });

    it('denied: an ADMIN token for a user demoted to SALES after login gets 403', async () => {
      const token = await loginToken(ADMIN_EMAIL, adminPassword);
      // Test-only SQL; the app has no change-role path. The token still says ADMIN.
      await dataSource.query('UPDATE users SET role = $1 WHERE id = $2', [UserRole.SALES, adminId]);

      const res = await request(server())
        .get('/auth-e2e-test/admin-only')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);

      const me = await request(server())
        .get('/auth-e2e-test/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body).toEqual({ id: adminId, role: 'SALES' });
    });

    it('allows an ADMIN token from login', async () => {
      const token = await loginToken(ADMIN_EMAIL, adminPassword);

      const res = await request(server())
        .get('/auth-e2e-test/admin-only')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toEqual({ ok: true });
    });
  });

  it('an unknown route without a token is still 404', async () => {
    await request(server()).get('/no-such-route').expect(404);
  });

  it('documents POST /auth/login in Swagger as a public route with the LoginDto body', async () => {
    const res = await request(server()).get('/docs-json').expect(200);

    const body = res.body as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const login = body.paths['/auth/login']?.post;
    expect(login).toBeDefined();
    expect(login).toMatchObject({
      requestBody: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/LoginDto' } },
        },
      },
      responses: { '200': expect.anything() as unknown },
    });
    expect(login).not.toHaveProperty('security');
  });
});
