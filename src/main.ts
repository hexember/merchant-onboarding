import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // validateEnv has already applied the default and checked the range.
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}

void bootstrap();
