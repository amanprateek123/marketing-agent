import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PipelineRun, PipelineRunSchema } from './schemas/pipeline-run.schema';
import { ScoutOutput, ScoutOutputSchema } from './schemas/scout-output.schema';
import { ScoutSignal, ScoutSignalSchema } from './schemas/scout-signal.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from './schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefSchema } from './schemas/creative-brief.schema';
import { CoordinatorOutput, CoordinatorOutputSchema } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputSchema } from './schemas/research-output.schema';
import { Digest, DigestSchema } from './schemas/digest.schema';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CreativeModule } from '../creative/creative.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { MetaAdsLibraryOutput, MetaAdsLibraryOutputSchema } from './schemas/meta-ads-library-output.schema';
import { MetaAdsLibraryService } from './meta-ads-library.service';
import { InstagramScout } from './scouts/instagram.scout';
import { RedditScout } from './scouts/reddit.scout';
import { TwitterScout } from './scouts/twitter.scout';
import { YoutubeScout } from './scouts/youtube.scout';
import { YoutubeApiService } from './scouts/youtube-api.service';
import { RedditApiService } from './scouts/reddit-api.service';
import { CoordinatorService } from './coordinator.service';
import { IdeaPoolService } from './idea-pool.service';
import { DigestWriterService } from './digest-writer.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineController } from './pipeline.controller';
import { UsageLog, UsageLogSchema } from '../claude/schemas/usage-log.schema';
import { StrategyTeamService } from '../teams/strategy-team.service';
import { CreativeTeamService } from '../teams/creative-team.service';
import { CampaignReviewTeamService } from '../teams/campaign-review-team.service';
import { ExperimentDesignerService } from '../teams/experiment-designer.service';
import { CreativePackage, CreativePackageSchema } from '../creative/schemas/creative-package.schema';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PipelineRun.name, schema: PipelineRunSchema },
      { name: MetaAdsLibraryOutput.name, schema: MetaAdsLibraryOutputSchema },
      { name: ScoutOutput.name, schema: ScoutOutputSchema },
      { name: ScoutSignal.name, schema: ScoutSignalSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: CreativeBrief.name, schema: CreativeBriefSchema },
      { name: CoordinatorOutput.name, schema: CoordinatorOutputSchema },
      { name: ResearchOutput.name, schema: ResearchOutputSchema },
      { name: Digest.name, schema: DigestSchema },
      { name: UsageLog.name, schema: UsageLogSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
      // Required by CampaignReviewTeamService.computeAudiencePerformance which
      // queries past launched campaigns to surface per-audience CPA in the
      // Review Team prompt. Schema is also registered in CampaignsModule —
      // forFeature is module-scoped so duplicate registration is harmless.
      { name: Campaign.name, schema: CampaignSchema },
    ]),
    ClaudeModule,
    forwardRef(() => CompaniesModule),
    DeliveryModule,
    CreativeModule,
    CampaignsModule,
  ],
  controllers: [PipelineController],
  providers: [
    MetaAdsLibraryService,
    YoutubeApiService,
    RedditApiService,
    InstagramScout,
    RedditScout,
    TwitterScout,
    YoutubeScout,
    CoordinatorService,
    IdeaPoolService,
    DigestWriterService,
    PipelineOrchestratorService,
    StrategyTeamService,
    CreativeTeamService,
    ExperimentDesignerService,
    CampaignReviewTeamService,
  ],
  exports: [
    PipelineOrchestratorService,
    InstagramScout,
    RedditScout,
    TwitterScout,
    YoutubeScout,
  ],
})
export class PipelineModule {}
