import { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger';
import { AppLogger } from './logging/app-logger.service';
import { writeLogLine } from './logging/console.transport';
import { serializeError } from './logging/log-sanitizer';

const BOOTSTRAP_CONTEXT = 'Bootstrap';
const STARTUP_FAILED_MESSAGE = 'Startup failed';

// The app's AppLogger, or undefined when it cannot be resolved.
function findLogger(app: INestApplication | undefined): LoggerService | undefined {
  if (!app) {
    return undefined;
  }
  try {
    return app.get(AppLogger);
  } catch {
    return undefined;
  }
}

/**
 * Writes exactly one JSON line for a startup failure. Without an app (env validation or the DB
 * connection failed) there is no config, so the stack is always omitted.
 */
function reportStartupFailure(app: INestApplication | undefined, error: unknown): void {
  const logger = findLogger(app);
  if (logger) {
    logger.error(STARTUP_FAILED_MESSAGE, error, BOOTSTRAP_CONTEXT);
    return;
  }
  writeLogLine({
    timestamp: new Date().toISOString(),
    level: 'error',
    context: BOOTSTRAP_CONTEXT,
    message: STARTUP_FAILED_MESSAGE,
    // For a non-Error this is the fixed UnknownError form, which holds nothing from the value.
    error: serializeError(error, { includeStack: false }),
  });
}

async function bootstrap(): Promise<void> {
  let app: INestApplication | undefined;
  try {
    // abortOnError: false so a startup failure reaches the catch below instead of aborting.
    // bufferLogs holds startup lines until AppLogger is attached, so they come out as JSON.
    // autoFlushLogs: false stops Nest from printing that buffer in plain text when startup fails.
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bufferLogs: true,
      autoFlushLogs: false,
    });
    app.useLogger(app.get(AppLogger));
    app.flushLogs();
    app.enableShutdownHooks();

    // validateEnv has already applied the defaults and checked the values.
    const config = app.get(ConfigService);
    setupSwagger(app, config.getOrThrow<boolean>('SWAGGER_ENABLED'));

    const port = config.getOrThrow<number>('PORT');
    await app.listen(port);
  } catch (error: unknown) {
    reportStartupFailure(app, error);
    process.exitCode = 1;
    try {
      await app?.close();
    } catch {
      // The failure line is already written; nothing more to report.
    }
  }
}

void bootstrap();
