import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Campaign, CampaignSchema } from './schemas/campaign.schema';
import { AuditSnapshot, AuditSnapshotSchema } from './schemas/audit-snapshot.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefSchema } from '../pipeline/schemas/creative-brief.schema';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignCreatorService } from './campaign-creator/campaign-creator.service';
import { CampaignAuditorService } from './campaign-auditor/campaign-auditor.service';
import { CampaignOptimizerService } from './campaign-auditor/campaign-optimizer.service';
import { SignalDetectorService } from './campaign-auditor/signal-detector.service';
import { AuditAgentService } from './campaign-auditor/audit-agent.service';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CommonModule } from '../common/common.module';
import { LearningModule } from '../learning/learning.module';
import { UsageLog, UsageLogSchema } from '../claude/schemas/usage-log.schema';
import { CampaignReviewTeamService } from '../teams/campaign-review-team.service';
import { MetaAdsService } from './meta-ads/meta-ads.service';
import { MetaMetricsService } from './meta-ads/meta-metrics.service';
import { MetaLearningImporterService } from './meta-ads/meta-learning-importer.service';
import { PatternCalculatorService } from './meta-ads/pattern-calculator.service';
import { CampaignSyncService } from './meta-ads/campaign-sync.service';
import { CampaignCaseStudy, CampaignCaseStudySchema } from './schemas/campaign-case-study.schema';
import { MetaLearningImport, MetaLearningImportSchema } from './schemas/meta-learning-import.schema';
import { EnrichedCampaign, EnrichedCampaignSchema } from './schemas/enriched-campaign.schema';
import { DeliveryModule } from '../delivery/delivery.module';
import { CreativePackage, CreativePackageSchema } from '../creative/schemas/creative-package.schema';
import { QUEUES } from '../scheduler/queue.constants';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: AuditSnapshot.name, schema: AuditSnapshotSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: CreativeBrief.name, schema: CreativeBriefSchema },
      { name: UsageLog.name, schema: UsageLogSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
      { name: CampaignCaseStudy.name, schema: CampaignCaseStudySchema },
      { name: MetaLearningImport.name, schema: MetaLearningImportSchema },
      { name: EnrichedCampaign.name, schema: EnrichedCampaignSchema },
    ]),
    BullModule.registerQueue({ name: QUEUES.META_LEARNING_IMPORT }),
    ClaudeModule,
    forwardRef(() => CompaniesModule),
    CommonModule,
    LearningModule,
    DeliveryModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignCreatorService, CampaignAuditorService, CampaignOptimizerService, SignalDetectorService, AuditAgentService, CampaignReviewTeamService, MetaAdsService, MetaMetricsService, MetaLearningImporterService, PatternCalculatorService, CampaignSyncService],
  exports: [CampaignsService, CampaignCreatorService, CampaignAuditorService, MetaLearningImporterService, CampaignSyncService],
})
export class CampaignsModule {}
