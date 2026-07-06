import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CycleProcessor } from './cycle.processor';
import { SnapshotProcessor } from './snapshot.processor';
import { INTELLIGENCE_QUEUES } from './intelligence-queue.constants';
import { IntelligenceSchedulerService } from './intelligence-scheduler.service';
import {
  TENANT_CAMPAIGNS_PROVIDER,
  TenantCampaignsProvider,
} from './tenant-campaigns.provider.interface';

/**
 * Wires the two intelligence BullMQ queues + their processors +
 * enrollment service.
 *
 * A TenantCampaignsProvider must be supplied — the provider tells the
 * processors which campaigns to iterate for a given tenant. The
 * follow-up "campaigns adapter" PR wires the real impl that queries
 * the campaigns collection.
 */
@Module({})
export class IntelligenceSchedulerModule {
  /**
   * Options are optional. When BOTH are omitted, TENANT_CAMPAIGNS_PROVIDER
   * must be provided by an external @Global module (typically
   * IntelligenceAdaptersModule).
   */
  static forFeature(
    opts: {
      campaignsProviderClass?: Type<TenantCampaignsProvider>;
      campaignsProvider?: Provider;
    } = {},
  ): DynamicModule {
    const localCampaignsProvider: Provider | undefined = opts.campaignsProvider
      ? opts.campaignsProvider
      : opts.campaignsProviderClass
        ? { provide: TENANT_CAMPAIGNS_PROVIDER, useClass: opts.campaignsProviderClass }
        : undefined;

    return {
      module: IntelligenceSchedulerModule,
      imports: [
        BullModule.registerQueue(
          { name: INTELLIGENCE_QUEUES.SNAPSHOT },
          { name: INTELLIGENCE_QUEUES.CYCLE },
        ),
      ],
      providers: [
        SnapshotProcessor,
        CycleProcessor,
        IntelligenceSchedulerService,
        ...(localCampaignsProvider ? [localCampaignsProvider] : []),
      ],
      exports: [IntelligenceSchedulerService],
    };
  }
}
