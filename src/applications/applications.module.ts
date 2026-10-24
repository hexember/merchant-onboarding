import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { KybModule } from '../kyb/kyb.module';
import { UsersModule } from '../users/users.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsRepository } from './applications.repository';
import { ApplicationsService } from './applications.service';
import { MerchantApplication } from './merchant-application.entity';

// Exports the scoped repository so later features (submit, assign, decide) reuse the same scope.
// KybModule provides KybCheckQueue, which ApplicationsService uses to enqueue after a submit.
@Module({
  imports: [TypeOrmModule.forFeature([MerchantApplication]), UsersModule, AuditModule, KybModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsRepository, ApplicationsService],
  exports: [ApplicationsRepository],
})
export class ApplicationsModule {}
