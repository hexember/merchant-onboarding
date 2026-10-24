import { BullRootModuleOptions, BullModule } from '@nestjs/bullmq';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ApplicationsModule } from './applications/applications.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AppEnv, validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { kybQueueConnection } from './kyb/kyb-check.queue';
import { UsersModule } from './users/users.module';

// Root module. Feature modules are added here by later tasks. The global pipe (here) and the
// global guards (in AuthModule) are module providers, not main.ts calls, so every app built from
// AppModule, including the e2e apps, gets the same validation and auth.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // The one Redis connection policy for the KYB queue and its worker (kybQueueConnection:
    // maxRetriesPerRequest null, offline queue left on). A hanging enqueue while Redis is down is
    // bounded by KYB_ENQUEUE_TIMEOUT_MS. @nestjs/bullmq closes queues and workers on app.close().
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): BullRootModuleOptions => ({
        connection: kybQueueConnection({
          REDIS_HOST: config.get('REDIS_HOST', { infer: true }),
          REDIS_PORT: config.get('REDIS_PORT', { infer: true }),
        }),
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
      }),
    }),
    DatabaseModule,
    UsersModule,
    AuditModule,
    AuthModule,
    ApplicationsModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      // Unknown body fields are rejected with 400 (docs/adrs/auth.md, DTO whitelist).
      useFactory: (): ValidationPipe =>
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
