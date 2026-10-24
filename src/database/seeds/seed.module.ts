import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../../config/env.validation';
import { LoggingModule } from '../../logging/logging.module';
import { UsersModule } from '../../users/users.module';
import { DatabaseModule } from '../database.module';
import { SeedService } from './seed.service';

// Standalone context for `npm run seed`; it needs only config, logging, the database and users.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Also registers the global APP_FILTER, which never runs in this standalone (non-HTTP) context.
    LoggingModule,
    DatabaseModule,
    UsersModule,
  ],
  providers: [SeedService],
})
export class SeedModule {}
