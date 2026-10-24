import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Body, Controller, Get, INestApplication, NotFoundException, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AppLogger } from '../src/logging/app-logger.service';

// Fake fixture values only; none of them is a real credential.
const FAKE_PASSWORD_FIXTURE = 'fake-password-for-test';
const FAKE_PARAMETER_FIXTURE = 'fake-parameter-for-test';
const FAKE_BEARER_TOKEN_FIXTURE = 'fake-token';
const FAKE_QUERY_TOKEN_FIXTURE = 'fake-query-token';

const GENERIC_500_BODY = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal server error',
  code: 'INTERNAL_ERROR',
};

// Test-only controller; it exists only inside this spec and reaches no application data.
@Controller('logging-e2e-test')
class ThrowingController {
  @Get('boom')
  boom(): never {
    throw Object.assign(new Error('fixture failure'), {
      password: FAKE_PASSWORD_FIXTURE,
      parameters: [FAKE_PARAMETER_FIXTURE],
    });
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }

  // Never reached in the tests: the malformed body fails before the handler.
  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

interface ParsedLine {
  level?: string;
  context?: string;
  message?: string;
  meta?: Record<string, unknown>;
  error?: unknown;
}

describe('Logging (e2e)', () => {
  let app: INestApplication<App>;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowingController],
    }).compile();
    app = module.createNestApplication<INestApplication<App>>({ bufferLogs: true });
    app.useLogger(app.get(AppLogger));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  function chunks(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  // Every captured line (stdout and stderr), split on newlines.
  function allLines(): string[] {
    return [...chunks(stdout), ...chunks(stderr)]
      .join('')
      .split('\n')
      .filter((line) => line !== '');
  }

  function stderrEntries(): ParsedLine[] {
    return chunks(stderr)
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as ParsedLine);
  }

  function capturedText(): string {
    return allLines().join('\n');
  }

  function expectEveryLineIsJson(): void {
    for (const line of allLines()) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  }

  it('returns the generic 500 body and logs an error line without internals', async () => {
    const res = await request(app.getHttpServer())
      .get('/logging-e2e-test/boom')
      .set('Authorization', `Bearer ${FAKE_BEARER_TOKEN_FIXTURE}`)
      .expect(500);

    expect(res.body).toEqual(GENERIC_500_BODY);
    const line = stderrEntries().find(
      (entry) => entry.level === 'error' && entry.context === 'AllExceptionsFilter',
    );
    expect(line).toBeDefined();
    expect(line?.meta).toMatchObject({ method: 'GET', route: '/logging-e2e-test/boom' });
    const text = capturedText();
    expect(text).not.toContain(FAKE_PASSWORD_FIXTURE);
    expect(text).not.toContain(FAKE_PARAMETER_FIXTURE);
    expect(text).not.toContain('parameters');
    expect(text).not.toContain(FAKE_BEARER_TOKEN_FIXTURE);
    expectEveryLineIsJson();
  });

  it('maps a NotFoundException to the error shape and logs a warn line', async () => {
    const res = await request(app.getHttpServer()).get('/logging-e2e-test/missing').expect(404);

    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Not Found',
      code: 'NOT_FOUND',
    });
    const warn = stderrEntries().find(
      (entry) => entry.level === 'warn' && entry.context === 'AllExceptionsFilter',
    );
    expect(warn).toBeDefined();
    expect(warn?.error).toBeUndefined();
    expectEveryLineIsJson();
  });

  it('maps an unknown route to the same 404 shape', async () => {
    const res = await request(app.getHttpServer()).get('/no-such-route').expect(404);

    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Not Found',
      code: 'NOT_FOUND',
    });
    expectEveryLineIsJson();
  });

  it('denied: an unknown route never echoes or logs its query string', async () => {
    const res = await request(app.getHttpServer())
      .get(`/no-such-route?token=${FAKE_QUERY_TOKEN_FIXTURE}`)
      .expect(404);

    expect(res.body).toMatchObject({ statusCode: 404, message: 'Not Found' });
    expect(JSON.stringify(res.body)).not.toContain(FAKE_QUERY_TOKEN_FIXTURE);
    const text = capturedText();
    expect(text).not.toContain(FAKE_QUERY_TOKEN_FIXTURE);
    expect(text).not.toContain('?token');
    const warn = stderrEntries().find(
      (entry) => entry.level === 'warn' && entry.context === 'AllExceptionsFilter',
    );
    expect(warn?.meta?.route).toBe('[unmatched]');
    expect(text).not.toContain('/no-such-route');
    expectEveryLineIsJson();
  });

  it('denied: a malformed JSON body gets a 400 in the error shape and is never echoed or logged', async () => {
    const res = await request(app.getHttpServer())
      .post('/logging-e2e-test/echo')
      .set('Content-Type', 'application/json')
      .send(`password=${FAKE_PASSWORD_FIXTURE}`)
      .expect(400);

    expect(res.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Malformed JSON body',
      code: 'BAD_REQUEST',
    });
    expect(JSON.stringify(res.body)).not.toContain('password=');
    expect(JSON.stringify(res.body)).not.toContain(FAKE_PASSWORD_FIXTURE);
    expect(capturedText()).not.toContain(FAKE_PASSWORD_FIXTURE);
    expectEveryLineIsJson();
  });
});

// Runs the built entry points in a child process with an invalid env and checks that the
// failure is exactly one JSON line on stderr. The child gets a fixed, fake env (never the
// developer's values) and runs in an empty temporary directory, so no .env file is loaded.
describe('Startup failure output (spawned process)', () => {
  const DIST = join(__dirname, '..', 'dist');
  let cwd: string;

  // Fake values only. DB_PASSWORD is missing on purpose, so env validation fails before any
  // connection is attempted.
  const INVALID_ENV: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    LOG_LEVEL: 'log',
    PORT: '3999',
    DB_HOST: 'localhost',
    DB_PORT: '1',
    DB_USER: 'fake_user',
    DB_NAME: 'fake_db',
  };

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mo-startup-failure-'));
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each<[string, string, string]>([
    ['the seed', 'database/seeds/seed.js', 'Seed failed'],
    ['the app', 'main.js', 'Startup failed'],
  ])(
    'denied: %s with an invalid env writes one JSON line to stderr, no stack, exit code 1',
    (_label, script, message) => {
      const path = join(DIST, script);
      if (!existsSync(path)) {
        throw new Error(`Build first (npm run build): ${script} is missing from dist`);
      }

      const result = spawnSync(process.execPath, [path], {
        cwd,
        env: INVALID_ENV,
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      const lines = result.stderr.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? '') as ParsedLine;
      expect(entry).toMatchObject({ level: 'error', message });
      expect(entry.error).toEqual({
        name: 'Error',
        message: 'Invalid or missing environment variables: DB_PASSWORD',
      });
      expect(result.stderr).not.toContain('    at ');
    },
    60_000,
  );
});
