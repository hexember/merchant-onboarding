import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger';
import { configureLogger } from './logging/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // validateEnv has already applied the defaults and checked the values.
  const config = app.get(ConfigService);
  configureLogger({ production: config.getOrThrow<string>('NODE_ENV') === 'production' });
  setupSwagger(app, config.getOrThrow<boolean>('SWAGGER_ENABLED'));

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
}

void bootstrap();
