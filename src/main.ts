import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { DEFAULT_PORT } from './common/constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const port = Number(app.get(ConfigService).get<string>('PORT')) || DEFAULT_PORT;
  await app.listen(port);
}

void bootstrap();
