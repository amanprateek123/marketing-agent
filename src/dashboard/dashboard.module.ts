import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommonModule } from '../common/common.module';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';
import {
  MetricTimeseries,
  MetricTimeseriesSchema,
} from '../campaigns/schemas/metric-timeseries.schema';
import { Company, CompanySchema } from '../companies/schemas/company.schema';
import {
  CreativePackage,
  CreativePackageSchema,
} from '../creative/schemas/creative-package.schema';
import {
  IntelligenceDecision,
  IntelligenceDecisionSchema,
} from '../intelligence/decisions/intelligence-decision.schema';
import {
  CampaignIntelligenceCycle,
  CampaignIntelligenceCycleSchema,
} from '../intelligence/orchestrator/cycle.schema';
import {
  ExecutedAction,
  ExecutedActionSchema,
} from '../learning/schemas/executed-action.schema';
import {
  PipelineRun,
  PipelineRunSchema,
} from '../pipeline/schemas/pipeline-run.schema';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Read-only aggregation layer over every collection a tenant owns.
 *
 * Registers the schemas directly rather than importing the owning feature
 * modules — this module only ever reads, and importing CampaignsModule /
 * PipelineModule here would drag their queues, processors and Meta clients
 * into a module whose entire job is to answer one GET.
 */
@Module({
  imports: [
    CommonModule,
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: Company.name, schema: CompanySchema },
      { name: MetricTimeseries.name, schema: MetricTimeseriesSchema },
      { name: PipelineRun.name, schema: PipelineRunSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
      { name: IntelligenceDecision.name, schema: IntelligenceDecisionSchema },
      {
        name: CampaignIntelligenceCycle.name,
        schema: CampaignIntelligenceCycleSchema,
      },
      { name: ExecutedAction.name, schema: ExecutedActionSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
