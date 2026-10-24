// Entry point for `npm run seed`.
import { INestApplicationContext, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppLogger } from '../../logging/app-logger.service';
import { logSeedFailure, writeSeedFailureWithoutContext } from './seed-failure';
import { SeedModule } from './seed.module';
import { SeedService } from './seed.service';

// The context's AppLogger, or undefined when it cannot be resolved.
function findLogger(app: INestApplicationContext | undefined): LoggerService | undefined {
  if (!app) {
    return undefined;
  }
  try {
    return app.get(AppLogger);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  let app: INestApplicationContext | undefined;
  try {
    // abortOnError: false so a startup failure reaches the catch below instead of aborting.
    // bufferLogs holds Nest's startup lines (and TypeORM's connection retries) until AppLogger
    // is attached. autoFlushLogs: false stops Nest from printing that buffer through its default
    // plain-text logger when creating the context fails; the buffer is then simply dropped and
    // the catch below writes the one failure line.
    app = await NestFactory.createApplicationContext(SeedModule, {
      abortOnError: false,
      bufferLogs: true,
      autoFlushLogs: false,
    });
    app.useLogger(app.get(AppLogger));
    app.flushLogs();
    await app.get(SeedService).run();
  } catch (error: unknown) {
    // Exactly one JSON failure line is written: through AppLogger if the context exists,
    // otherwise directly (env validation or DB connection failures land here).
    const logger = findLogger(app);
    if (logger) {
      logSeedFailure(logger, error);
    } else {
      writeSeedFailureWithoutContext(error);
    }
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

void main();
