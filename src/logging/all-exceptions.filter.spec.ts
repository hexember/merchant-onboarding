import { STATUS_CODES } from 'node:http';
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AllExceptionsFilter,
  MALFORMED_JSON_MESSAGE,
  MALFORMED_URL_PARAM_MESSAGE,
  UNMATCHED_ROUTE,
} from './all-exceptions.filter';
import type { AppLogger } from './app-logger.service';

// Fake fixture values only.
const METHOD = 'GET';
const BASE_URL = '/fixture';
const ROUTE_PATH = '/items/:id';
const ROUTE = BASE_URL + ROUTE_PATH;
const RAW_PATH = '/fixture/items/fake-raw-id-123';
const LOG_CONTEXT = 'AllExceptionsFilter';
const GENERIC_500 = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal server error',
  code: 'INTERNAL_ERROR',
};

interface Harness {
  filter: AllExceptionsFilter;
  host: ArgumentsHost;
  errorCalls: unknown[][];
  warnCalls: unknown[][];
  statusCalls: number[];
  jsonBodies: unknown[];
}

interface HarnessOptions {
  type?: string;
  // false: no route matched (req.route is undefined).
  matched?: boolean;
  throwingLogger?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const { type = 'http', matched = true, throwingLogger = false } = options;
  const errorCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  const statusCalls: number[] = [];
  const jsonBodies: unknown[] = [];

  const logger = {
    error: (...args: unknown[]): void => {
      errorCalls.push(args);
      if (throwingLogger) {
        throw new Error('fixture logger failure');
      }
    },
    warn: (...args: unknown[]): void => {
      warnCalls.push(args);
      if (throwingLogger) {
        throw new Error('fixture logger failure');
      }
    },
  } as unknown as AppLogger;

  const request = {
    method: METHOD,
    path: RAW_PATH,
    originalUrl: RAW_PATH,
    baseUrl: BASE_URL,
    route: matched ? { path: ROUTE_PATH } : undefined,
    headers: { authorization: 'Bearer fake' },
    body: { password: 'fake-body-password' },
    query: { q: 'fake-query-value' },
  };
  const response = {
    status: (code: number): { json(body: unknown): unknown } => {
      statusCalls.push(code);
      return {
        json: (body: unknown): unknown => {
          jsonBodies.push(body);
          return body;
        },
      };
    },
  };
  const host = {
    getType: (): string => type,
    switchToHttp: () => ({
      getRequest: (): unknown => request,
      getResponse: (): unknown => response,
    }),
  } as unknown as ArgumentsHost;

  return {
    filter: new AllExceptionsFilter(logger),
    host,
    errorCalls,
    warnCalls,
    statusCalls,
    jsonBodies,
  };
}

function body(h: Harness): unknown {
  expect(h.jsonBodies).toHaveLength(1);
  return h.jsonBodies[0];
}

function allLoggedText(h: Harness): string {
  return JSON.stringify([...h.errorCalls, ...h.warnCalls]);
}

describe('AllExceptionsFilter', () => {
  describe('unknown errors', () => {
    it('returns the generic 500 body and logs the Error with method, path and status only', () => {
      const h = harness();
      const exception = Object.assign(new Error('fixture internal failure'), {
        password: 'fake-error-password',
      });

      h.filter.catch(exception, h.host);

      expect(h.statusCalls).toEqual([500]);
      expect(body(h)).toEqual(GENERIC_500);
      expect(h.errorCalls).toEqual([
        [
          'Unhandled exception',
          exception,
          { method: METHOD, route: ROUTE, statusCode: 500 },
          LOG_CONTEXT,
        ],
      ]);
      expect(h.warnCalls).toHaveLength(0);
    });

    it('denied: a thrown string reaches neither the body nor the logger', () => {
      const h = harness();

      h.filter.catch('fake-secret-string', h.host);

      expect(body(h)).toEqual(GENERIC_500);
      expect(h.errorCalls).toEqual([
        [
          'Unhandled non-error exception',
          { method: METHOD, route: ROUTE, statusCode: 500 },
          LOG_CONTEXT,
        ],
      ]);
      expect(allLoggedText(h)).not.toContain('fake-secret-string');
    });

    it('denied: a thrown object reaches neither the body nor the logger', () => {
      const h = harness();

      h.filter.catch({ password: 'fake', detail: 'fake-detail' }, h.host);

      expect(body(h)).toEqual(GENERIC_500);
      const text = allLoggedText(h);
      expect(text).not.toContain('"fake"');
      expect(text).not.toContain('fake-detail');
      expect(text).not.toContain('detail');
      expect(text).not.toContain('password');
    });
  });

  describe('HttpException', () => {
    it('maps NotFoundException to 404 and logs a warn with code', () => {
      const h = harness();

      h.filter.catch(new NotFoundException(), h.host);

      expect(h.statusCalls).toEqual([404]);
      expect(body(h)).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Not Found',
        code: 'NOT_FOUND',
      });
      expect(h.warnCalls).toEqual([
        [
          'Request failed',
          { method: METHOD, route: ROUTE, statusCode: 404, code: 'NOT_FOUND' },
          LOG_CONTEXT,
        ],
      ]);
      expect(h.errorCalls).toHaveLength(0);
    });

    it('denied: replaces a route-not-found message so the query string is not echoed', () => {
      const h = harness();

      h.filter.catch(new NotFoundException('Cannot GET /x?token=fake-query-token'), h.host);

      expect(body(h)).toMatchObject({ statusCode: 404, message: 'Not Found' });
      expect(JSON.stringify(body(h))).not.toContain('fake-query-token');
      expect(allLoggedText(h)).not.toContain('fake-query-token');
    });

    it('keeps a 404 message that does not start with "Cannot "', () => {
      const h = harness();

      h.filter.catch(new NotFoundException('Application not found'), h.host);

      expect(body(h)).toMatchObject({ message: 'Application not found' });
    });

    it('keeps an array message', () => {
      const h = harness();

      h.filter.catch(new BadRequestException(['a must be a string']), h.host);

      expect(body(h)).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['a must be a string'],
        code: 'BAD_REQUEST',
      });
    });

    it('uses a string code from the response', () => {
      const h = harness();

      h.filter.catch(new HttpException({ message: 'x', code: 'CUSTOM_CODE' }, 409), h.host);

      expect(body(h)).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'x',
        code: 'CUSTOM_CODE',
      });
    });

    it('uses a string response as the message', () => {
      const h = harness();

      h.filter.catch(new HttpException('fixture message', 409), h.host);

      expect(body(h)).toMatchObject({ statusCode: 409, message: 'fixture message' });
    });

    it.each<[string, unknown]>([
      ['a number', 42],
      ['an object', { a: 1 }],
      ['a mixed array', ['a', 1]],
    ])('falls back to exception.message when message is %s', (_label, message) => {
      const h = harness();
      const exception = new HttpException({ message }, 400);

      h.filter.catch(exception, h.host);

      expect(body(h)).toMatchObject({ statusCode: 400, message: exception.message });
    });

    it('does not log the response message on 4xx', () => {
      const h = harness();

      h.filter.catch(new NotFoundException('fixture-response-message'), h.host);

      expect(allLoggedText(h)).not.toContain('fixture-response-message');
    });
  });

  describe('client errors that are not HttpExceptions', () => {
    function clientError(fields: Record<string, unknown>): Error {
      return Object.assign(new Error('fixture parser message'), fields);
    }

    it('maps an exposed 413 to a generic 413 and logs a warn', () => {
      const h = harness();

      h.filter.catch(clientError({ status: 413, expose: true }), h.host);

      expect(h.statusCalls).toEqual([413]);
      expect(body(h)).toEqual({
        statusCode: 413,
        error: STATUS_CODES[413],
        message: STATUS_CODES[413],
        code: 'PAYLOAD_TOO_LARGE',
      });
      expect(h.warnCalls).toHaveLength(1);
      expect(h.errorCalls).toHaveLength(0);
      expect(JSON.stringify(body(h))).not.toContain('fixture parser message');
    });

    it('uses statusCode when status is absent', () => {
      const h = harness();

      h.filter.catch(clientError({ statusCode: 400, expose: true }), h.host);

      expect(body(h)).toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
    });

    it('prefers status over statusCode', () => {
      const h = harness();

      h.filter.catch(clientError({ status: 413, statusCode: 400, expose: true }), h.host);

      expect(h.statusCalls).toEqual([413]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['expose is false', { status: 413, expose: false }],
      ['status is 5xx', { status: 503, expose: true }],
    ])('returns the generic 500 when %s', (_label, fields) => {
      const h = harness();

      h.filter.catch(clientError(fields), h.host);

      expect(body(h)).toEqual(GENERIC_500);
      expect(h.errorCalls).toHaveLength(1);
    });
  });

  describe('logged fields', () => {
    it.each<[string, unknown]>([
      ['a 500', new Error('fixture')],
      ['a 4xx', new NotFoundException()],
    ])('never include headers, body or query for %s', (_label, exception) => {
      const h = harness();

      h.filter.catch(exception, h.host);

      const text = allLoggedText(h);
      expect(text).not.toContain('Bearer fake');
      expect(text).not.toContain('fake-body-password');
      expect(text).not.toContain('fake-query-value');
      const metas = [...h.errorCalls, ...h.warnCalls].map((call) => call[call.length - 2]);
      for (const meta of metas) {
        expect(Object.keys(meta as object).sort()).toEqual(
          h.warnCalls.length > 0
            ? ['code', 'method', 'route', 'statusCode']
            : ['method', 'route', 'statusCode'],
        );
      }
    });
  });

  describe('route in the log line', () => {
    it('denied: logs the matched route pattern, never the raw path', () => {
      const h = harness();

      h.filter.catch(new NotFoundException(), h.host);

      expect(h.warnCalls[0]?.[1]).toMatchObject({ route: ROUTE });
      expect(allLoggedText(h)).not.toContain('fake-raw-id-123');
    });

    it('logs [unmatched] when no route matched', () => {
      const h = harness({ matched: false });

      h.filter.catch(new NotFoundException('Cannot GET /fake-raw-id-123'), h.host);

      expect(h.warnCalls[0]?.[1]).toMatchObject({ route: UNMATCHED_ROUTE });
      expect(allLoggedText(h)).not.toContain('fake-raw-id-123');
    });
  });

  describe('5xx HttpException', () => {
    it('denied: an InternalServerErrorException message never reaches the body', () => {
      const h = harness();
      const exception = new InternalServerErrorException('db password auth failed for x');

      h.filter.catch(exception, h.host);

      expect(h.statusCalls).toEqual([500]);
      expect(body(h)).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
        code: 'INTERNAL_SERVER_ERROR',
      });
      expect(JSON.stringify(body(h))).not.toContain('password');
      // The exception itself still goes to the logger, which serializes it.
      expect(h.errorCalls[0]?.[1]).toBe(exception);
    });

    it('keeps a string code from a 5xx response but not its message or error', () => {
      const h = harness();

      h.filter.catch(
        new HttpException(
          { message: 'fake internal detail', error: 'fake internal error', code: 'UPSTREAM_DOWN' },
          503,
        ),
        h.host,
      );

      expect(body(h)).toEqual({
        statusCode: 503,
        error: STATUS_CODES[503],
        message: STATUS_CODES[503],
        code: 'UPSTREAM_DOWN',
      });
    });

    it('uses the default code for a plain 503', () => {
      const h = harness();

      h.filter.catch(new ServiceUnavailableException('fake internal detail'), h.host);

      expect(body(h)).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(JSON.stringify(body(h))).not.toContain('fake internal detail');
    });
  });

  describe('framework 400s that echo input', () => {
    it('denied: replaces a body-parser JSON message so the body is not echoed', () => {
      const h = harness({ matched: false });

      h.filter.catch(
        new BadRequestException(`Unexpected token 'p', "password=f"... is not valid JSON`),
        h.host,
      );

      expect(body(h)).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: MALFORMED_JSON_MESSAGE,
        code: 'BAD_REQUEST',
      });
      expect(JSON.stringify(body(h))).not.toContain('password=');
    });

    it('denied: replaces the router param-decode message so the raw param is not echoed', () => {
      const h = harness();

      h.filter.catch(new BadRequestException("Failed to decode param '%FFfake'"), h.host);

      expect(body(h)).toMatchObject({ statusCode: 400, message: MALFORMED_URL_PARAM_MESSAGE });
      expect(JSON.stringify(body(h))).not.toContain('%FFfake');
    });
  });

  it.each<[string, unknown]>([
    ['a 500', new Error('fixture')],
    ['a 4xx', new NotFoundException()],
  ])('still sends the response when the logger throws, for %s', (_label, exception) => {
    const h = harness({ throwingLogger: true });

    expect(() => h.filter.catch(exception, h.host)).not.toThrow();
    expect(h.jsonBodies).toHaveLength(1);
  });

  it('rethrows unchanged for a non-HTTP host, with no response and no log', () => {
    const h = harness({ type: 'rpc' });
    const exception = new Error('fixture rpc failure');

    expect(() => h.filter.catch(exception, h.host)).toThrow(exception);
    expect(h.statusCalls).toHaveLength(0);
    expect(h.jsonBodies).toHaveLength(0);
    expect(h.errorCalls).toHaveLength(0);
    expect(h.warnCalls).toHaveLength(0);
  });
});
