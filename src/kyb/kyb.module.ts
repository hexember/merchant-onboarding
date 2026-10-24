import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { AuditModule } from '../audit/audit.module';
import { KybCheck } from './kyb-check.entity';
import { KybCheckProcessor } from './kyb-check.processor';
import { KybCheckQueue } from './kyb-check.queue';
import { KYB_CHECK_QUEUE } from './kyb-job';
import { KYB_PROVIDER, KYB_RANDOM } from './kyb-provider';
import { KybWorkerApplicationsRepository } from './kyb-worker-applications.repository';
import { SimulatedKybProvider } from './simulated-kyb-provider';

// The KYB check feature (docs/adrs/kyb-check.md). The queue has no connection of its own: it and
// the @Processor worker both use the root connection from `BullModule.forRootAsync` in AppModule,
// so they share one policy.
//
// Only the producer is exported. The worker-only repository, the processor and the provider must
// not be injectable anywhere else: the repository is unscoped (SYSTEM only), and the provider may
// only be called from the worker (.claude/rules/queue.md).
@Module({
  imports: [
    TypeOrmModule.forFeature([MerchantApplication, KybCheck]),
    AuditModule,
    BullModule.registerQueue({ name: KYB_CHECK_QUEUE }),
  ],
  providers: [
    KybCheckQueue,
    KybWorkerApplicationsRepository,
    KybCheckProcessor,
    { provide: KYB_PROVIDER, useClass: SimulatedKybProvider },
    { provide: KYB_RANDOM, useValue: Math.random },
  ],
  exports: [KybCheckQueue],
})
export class KybModule {}
