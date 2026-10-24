import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../../config/env.validation';
import { UsersModule } from '../../users/users.module';
import { DatabaseModule } from '../database.module';
import { SeedService } from './seed.service';

// Standalone context for `npm run seed`; it needs only config, the database and users.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    UsersModule,
  ],
  providers: [SeedService],
})
export class SeedModule {}
