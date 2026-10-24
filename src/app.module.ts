import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { LoggingModule } from './logging/logging.module';
import { UsersModule } from './users/users.module';

// Root module. Feature modules are added here by later tasks. The global pipe (here) and the
// global guards (in AuthModule) are module providers, not main.ts calls, so every app built from
// AppModule, including the e2e apps, gets the same validation and auth.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggingModule,
    DatabaseModule,
    UsersModule,
    AuditModule,
    AuthModule,
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
