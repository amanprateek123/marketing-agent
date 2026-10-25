import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { PmClickhouseClient } from './clients/pm-clickhouse.client';
import { PmMetabaseClient } from './clients/pm-metabase.client';
import { PmController } from './pm.controller';
import { pmEnv } from './pm.config';
import { PmScheduler } from './pm.scheduler';
import { PmLock, PmLockSchema } from './schemas/pm-lock.schema';
import { PmOrder, PmOrderSchema } from './schemas/pm-order.schema';
import { PmSyncRun, PmSyncRunSchema } from './schemas/pm-sync-run.schema';
import {
  PmVisitorDay,
  PmVisitorDaySchema,
} from './schemas/pm-visitor-day.schema';
import { AttributionSync } from './sync/attribution.sync';
import { OrdersSync } from './sync/orders.sync';
import { PmSyncService } from './sync/pm-sync.service';
import { VisitorDaysSync } from './sync/visitor-days.sync';

/**
 * Performance Marketeer — kept separate from the rest of marketing-agent: its
 * own config, collections (pm_*), clients and jobs. It depends on nothing else
 * in the app, and nothing else depends on it.
 */
@Module({
  imports: [
    ConfigModule.forFeature(pmEnv),
    MongooseModule.forFeature([
      { name: PmVisitorDay.name, schema: PmVisitorDaySchema },
      { name: PmOrder.name, schema: PmOrderSchema },
      { name: PmSyncRun.name, schema: PmSyncRunSchema },
      { name: PmLock.name, schema: PmLockSchema },
    ]),
  ],
  controllers: [PmController],
  providers: [
    PmClickhouseClient,
    PmMetabaseClient,
    VisitorDaysSync,
    OrdersSync,
    AttributionSync,
    PmSyncService,
    PmScheduler,
  ],
  exports: [PmSyncService],
})
export class PerformanceMarketeerModule {}
