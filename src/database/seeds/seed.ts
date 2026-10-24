// Entry point for `npm run seed`.
import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { redact } from '../../common/redact';
import { SeedModule } from './seed.module';
import { SeedService } from './seed.service';

const logger = new Logger('Seed');

// Only name, SQLSTATE code and message are logged. The error object, its stack and TypeORM's
// query/parameters/detail are never logged: the parameters would contain the bcrypt hash.
function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return redact({ name: 'UnknownError' });
  }
  const code: unknown = (error as { code?: unknown }).code;
  return redact({
    name: error.name,
    code: typeof code === 'string' ? code : undefined,
    message: error.message,
  });
}

async function main(): Promise<void> {
  let app: INestApplicationContext | undefined;
  try {
    // abortOnError: false so a startup failure reaches the catch below instead of aborting.
    app = await NestFactory.createApplicationContext(SeedModule, { abortOnError: false });
    await app.get(SeedService).run();
  } catch (error: unknown) {
    logger.error(JSON.stringify(describeError(error)));
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

void main();
