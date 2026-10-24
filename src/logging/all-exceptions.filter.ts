import { STATUS_CODES } from 'node:http';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { AppLogger } from './app-logger.service';

const LOG_CONTEXT = 'AllExceptionsFilter';

// Logged instead of a route pattern when no route matched (unknown URL, or a failure before
// routing such as a malformed body).
export const UNMATCHED_ROUTE = '[unmatched]';

// Messages that replace a framework 400 message which echoes request input.
export const MALFORMED_JSON_MESSAGE = 'Malformed JSON body';
export const MALFORMED_URL_PARAM_MESSAGE = 'Malformed URL parameter';

const GENERIC_500_BODY: ErrorResponseBody = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  error: 'Internal Server Error',
  message: 'Internal server error',
  code: 'INTERNAL_ERROR',
};

// Local shapes of the request and response fields the filter uses (no express types needed).
// `route` is set by the router only when a route matched.
interface HttpRequestLike {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
}

interface HttpResponseLike {
  status(code: number): { json(body: unknown): unknown };
}

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  code: string;
}

/**
 * Global filter: maps every exception to `{ statusCode, error, message, code }`.
 * Unknown errors and every 5xx get a fixed body, so internals never reach a response. The log
 * line carries only the method, the matched route pattern (`/applications/:id`, never the raw
 * path), the status (and `code` on 4xx), never headers, body or query.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequestLike>();
    const res = http.getResponse<HttpResponseLike>();

    let body: ErrorResponseBody;
    try {
      body = toResponseBody(exception);
    } catch {
      body = { ...GENERIC_500_BODY };
    }

    // The response is always sent, even if logging fails.
    try {
      const meta = { method: req.method, route: routePattern(req), statusCode: body.statusCode };
      if (body.statusCode >= 500) {
        if (exception instanceof Error) {
          this.logger.error('Unhandled exception', exception, meta, LOG_CONTEXT);
        } else {
          this.logger.error('Unhandled non-error exception', meta, LOG_CONTEXT);
        }
      } else {
        this.logger.warn('Request failed', { ...meta, code: body.code }, LOG_CONTEXT);
      }
    } catch {
      // Nothing to do: logging the logging failure could fail the same way.
    }

    res.status(body.statusCode).json(body);
  }
}

// The matched route pattern, so route params and other URL values are never logged.
function routePattern(req: HttpRequestLike): string {
  const path = req.route?.path;
  if (typeof path !== 'string') {
    return UNMATCHED_ROUTE;
  }
  return (req.baseUrl ?? '') + path;
}

function toResponseBody(exception: unknown): ErrorResponseBody {
  if (exception instanceof HttpException) {
    return fromHttpException(exception);
  }
  const clientStatus = exposedClientStatus(exception);
  if (clientStatus !== undefined) {
    const phrase = reasonPhrase(clientStatus);
    return {
      statusCode: clientStatus,
      error: phrase,
      message: phrase,
      code: defaultCode(clientStatus),
    };
  }
  return { ...GENERIC_500_BODY };
}

function fromHttpException(exception: HttpException): ErrorResponseBody {
  const statusCode = exception.getStatus();
  const response = exception.getResponse();
  let message: string | string[] = exception.message;
  let error = reasonPhrase(statusCode);
  let code = defaultCode(statusCode);

  if (typeof response === 'string') {
    message = response;
  } else if (typeof response === 'object' && response !== null) {
    const fields = response as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof fields.message === 'string' || isStringArray(fields.message)) {
      message = fields.message;
    }
    if (typeof fields.error === 'string') {
      error = fields.error;
    }
    if (typeof fields.code === 'string') {
      code = fields.code;
    }
  }

  // A 5xx message is internal (it can name a host, a user or a query): the body is fixed and
  // the full message stays in the log only.
  if (statusCode >= 500) {
    const phrase = STATUS_CODES[statusCode];
    return {
      statusCode,
      error: phrase ?? 'Error',
      message: phrase ?? 'Internal server error',
      code,
    };
  }

  // Nest's route-not-found message echoes the original URL, query string included.
  if (statusCode === 404 && typeof message === 'string' && message.startsWith('Cannot ')) {
    message = 'Not Found';
  }
  // Nest maps body-parser's SyntaxError and the router's URIError to
  // `new BadRequestException(err.message)` with no `cause`, so the origin can only be told by the
  // message. Both messages echo request input (the start of the body, the raw param).
  if (statusCode === 400 && typeof message === 'string') {
    if (/\bJSON\b/.test(message)) {
      message = MALFORMED_JSON_MESSAGE;
    } else if (message.startsWith('Failed to decode param ')) {
      message = MALFORMED_URL_PARAM_MESSAGE;
    }
  }
  return { statusCode, error, message, code };
}

// A client error that is not an HttpException (e.g. body-parser's 400/413): a 4xx `status` or
// `statusCode` with `expose === true`. `status` wins when both are present.
function exposedClientStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }
  const fields = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
  if (fields.expose !== true) {
    return undefined;
  }
  const status =
    typeof fields.status === 'number'
      ? fields.status
      : typeof fields.statusCode === 'number'
        ? fields.statusCode
        : undefined;
  if (status === undefined || status < 400 || status > 499) {
    return undefined;
  }
  return status;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

function defaultCode(status: number): string {
  const key: unknown = (HttpStatus as Record<number, unknown>)[status];
  return typeof key === 'string' ? key : 'HTTP_ERROR';
}
