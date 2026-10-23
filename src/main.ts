import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // Env values are strings, so convert explicitly instead of trusting a generic type.
  const port = Number(app.get(ConfigService).get<string>('PORT', '3000'));
  await app.listen(port);
}

void bootstrap();
