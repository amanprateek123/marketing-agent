import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { PmClickhouseClient } from './clients/pm-clickhouse.client';
import { PmAnalysisController } from './analysis/pm-analysis.controller';
import { PmAnalysisService } from './analysis/pm-analysis.service';
import { PmMetabaseClient } from './clients/pm-metabase.client';
import { PmMetaClient } from './clients/pm-meta.client';
import { PmController } from './pm.controller';
import { pmEnv } from './pm.config';
import { PmScheduler } from './pm.scheduler';
import { PmAgentController } from './agent/pm-agent.controller';
import { PmLessonsController } from './agent/lessons/pm-lessons.controller';
import { PmLessonsService } from './agent/lessons/lessons.service';
import { PmRecordsService } from './agent/lessons/records.service';
import { PmSituationService } from './agent/lessons/situation.service';
import {
  PmLessonDoc,
  PmLessonEventDoc,
  PmLessonEventSchema,
  PmLessonProposalDoc,
  PmLessonProposalSchema,
  PmLessonSchema,
  PmOwnerRuleDoc,
  PmOwnerRuleSchema,
} from './schemas/pm-lessons.schema';
import {
  PmDecisionRecord,
  PmDecisionRecordSchema,
  PmDiagnosisCheck,
  PmDiagnosisCheckSchema,
  PmOutcomeRecord,
  PmOutcomeRecordSchema,
} from './schemas/pm-lesson-records.schema';
import { PmJournalService } from './agent/journal/journal.service';
import { PmPipelineService } from './agent/pipeline/pm-pipeline.service';
import { PmAgentQueueService } from './agent/pipeline/pm-agent-queue.service';
import { PmCalendarTools } from './agent/tools/calendar.tools';
import { PmCompetitorSync } from './agent/competitors/competitor.sync';
import { PmProxyClient } from './agent/competitors/proxy.client';
import { PmCompetitorTools } from './agent/tools/competitors.tools';
import { PmCreativeTools } from './agent/tools/creatives.tools';
import { PmLandingTools } from './agent/tools/landing.tools';
import {
  PmCompetitorAd,
  PmCompetitorAdSchema,
  PmProxyCache,
  PmProxyCacheSchema,
  PmProxyUsage,
  PmProxyUsageSchema,
} from './schemas/pm-competitor-ad.schema';
import { PmDataTools } from './agent/tools/data.tools';
import { PmAgentRun, PmAgentRunSchema } from './schemas/pm-agent-run.schema';
import {
  PmCampaignTarget,
  PmCampaignTargetSchema,
} from './schemas/pm-campaign-target.schema';
import {
  PmMetaEntitySnapshot,
  PmMetaEntitySnapshotSchema,
} from './schemas/pm-entity-snapshot.schema';
import { PmLock, PmLockSchema } from './schemas/pm-lock.schema';
import {
  PmMetaAccountDaily,
  PmMetaAccountDailySchema,
  PmMetaBreakdown,
  PmMetaBreakdownSchema,
  PmMetaChange,
  PmMetaChangeSchema,
  PmMetaDaily,
  PmMetaDailySchema,
  PmMetaEntity,
  PmMetaEntitySchema,
} from './schemas/pm-meta.schema';
import { PmOrder, PmOrderSchema } from './schemas/pm-order.schema';
import { PmSyncRun, PmSyncRunSchema } from './schemas/pm-sync-run.schema';
import {
  PmVisitorDay,
  PmVisitorDaySchema,
} from './schemas/pm-visitor-day.schema';
import { AttributionSync } from './sync/attribution.sync';
import { MetaSync } from './sync/meta.sync';
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
      { name: PmMetaEntity.name, schema: PmMetaEntitySchema },
      { name: PmMetaDaily.name, schema: PmMetaDailySchema },
      { name: PmMetaBreakdown.name, schema: PmMetaBreakdownSchema },
      { name: PmMetaChange.name, schema: PmMetaChangeSchema },
      { name: PmMetaAccountDaily.name, schema: PmMetaAccountDailySchema },
      { name: PmMetaEntitySnapshot.name, schema: PmMetaEntitySnapshotSchema },
      { name: PmAgentRun.name, schema: PmAgentRunSchema },
      { name: PmCampaignTarget.name, schema: PmCampaignTargetSchema },
      { name: PmCompetitorAd.name, schema: PmCompetitorAdSchema },
      { name: PmProxyUsage.name, schema: PmProxyUsageSchema },
      { name: PmProxyCache.name, schema: PmProxyCacheSchema },
      { name: PmLessonDoc.name, schema: PmLessonSchema },
      { name: PmLessonEventDoc.name, schema: PmLessonEventSchema },
      { name: PmLessonProposalDoc.name, schema: PmLessonProposalSchema },
      { name: PmOwnerRuleDoc.name, schema: PmOwnerRuleSchema },
      { name: PmDecisionRecord.name, schema: PmDecisionRecordSchema },
      { name: PmOutcomeRecord.name, schema: PmOutcomeRecordSchema },
      { name: PmDiagnosisCheck.name, schema: PmDiagnosisCheckSchema },
    ]),
  ],
  controllers: [
    PmController,
    PmAnalysisController,
    PmAgentController,
    PmLessonsController,
  ],
  providers: [
    PmClickhouseClient,
    PmMetabaseClient,
    PmMetaClient,
    MetaSync,
    VisitorDaysSync,
    OrdersSync,
    AttributionSync,
    PmSyncService,
    PmScheduler,
    PmAnalysisService,
    PmJournalService,
    PmDataTools,
    PmCalendarTools,
    PmProxyClient,
    PmCompetitorSync,
    PmCompetitorTools,
    PmCreativeTools,
    PmLandingTools,
    PmPipelineService,
    PmAgentQueueService,
    PmSituationService,
    PmRecordsService,
    PmLessonsService,
  ],
  exports: [PmSyncService],
})
export class PerformanceMarketeerModule {}
