import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { LoggingModule } from './logging/logging.module';
import { UsersModule } from './users/users.module';

// Root module. Feature modules are added here by later tasks.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggingModule,
    DatabaseModule,
    UsersModule,
    AuditModule,
  ],
})
export class AppModule {}
