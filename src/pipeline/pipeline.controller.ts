import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { CompaniesService } from '../companies/companies.service';
import { StrategyTeamService } from '../teams/strategy-team.service';
import { DigestWriterService } from './digest-writer.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CoordinatorOutput } from './schemas/coordinator-output.schema';
import { ResearchOutput } from './schemas/research-output.schema';
import { CreativeBrief } from './schemas/creative-brief.schema';
import { IntelligenceBrief } from './schemas/intelligence-brief.schema';
import { ScoutOutput } from './schemas/scout-output.schema';
import { Digest } from './schemas/digest.schema';
import { PipelineRun } from './schemas/pipeline-run.schema';
import { CreativeTeamService } from '../teams/creative-team.service';
import { CampaignReviewTeamService } from '../teams/campaign-review-team.service';
import { CampaignCreatorService } from '../campaigns/campaign-creator/campaign-creator.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreativeProducerService } from '../creative/creative-producer/creative-producer.service';
import { CreativePackage } from '../creative/schemas/creative-package.schema';
import { MetaAdsLibraryOutput } from './schemas/meta-ads-library-output.schema';

@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly companiesService: CompaniesService,
    private readonly campaignsService: CampaignsService,
    private readonly strategyTeam: StrategyTeamService,
    private readonly digestWriter: DigestWriterService,
    private readonly creativeTeam: CreativeTeamService,
    private readonly campaignReviewTeam: CampaignReviewTeamService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly creativeProducer: CreativeProducerService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackage>,
    @InjectModel(MetaAdsLibraryOutput.name)
    private readonly metaAdsLibraryOutputModel: Model<MetaAdsLibraryOutput>,
    @InjectModel(CoordinatorOutput.name)
    private readonly coordinatorOutputModel: Model<CoordinatorOutput>,
    @InjectModel(ResearchOutput.name)
    private readonly researchOutputModel: Model<ResearchOutput>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBrief>,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBrief>,
    @InjectModel(ScoutOutput.name)
    private readonly scoutOutputModel: Model<ScoutOutput>,
    @InjectModel(Digest.name)
    private readonly digestModel: Model<Digest>,
    @InjectModel(PipelineRun.name)
    private readonly pipelineRunModel: Model<PipelineRun>,
  ) {}

  /**
   * GET /api/v1/pipeline/:tenantId/runs
   * List all pipeline runs for a tenant, newest first.
   */
  @Get(':tenantId/runs')
  async listRuns(@Param('tenantId') tenantId: string) {
    const runs = await this.pipelineRunModel
      .find({ tenantId })
      .sort({ startedAt: -1 })
      .limit(20)
      .lean()
      .exec();
    return runs;
  }

  /**
   * GET /api/v1/pipeline/:tenantId/runs/:runId/full
   * Returns the complete pipeline run data — all sub-documents bundled in one response.
   * Used by the dashboard Run Detail page.
   */
  @Get(':tenantId/runs/:runId/full')
  async getRunFull(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    const run = await this.orchestrator.getStatus(tenantId, runId);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    const [scouts, coordinator, research, briefs, creativeBrief, digests, campaign, adLibrary] =
      await Promise.all([
        this.scoutOutputModel.find({ tenantId, runId }).lean().exec(),
        this.coordinatorOutputModel.findOne({ tenantId, runId }).lean().exec(),
        this.researchOutputModel.find({ tenantId, runId }).lean().exec(),
        this.intelligenceBriefModel.find({ tenantId, runId }).sort({ finalScore: -1 }).lean().exec(),
        this.creativeBriefModel.findOne({ tenantId, runId }).lean().exec(),
        this.digestModel.find({ tenantId, runId }).lean().exec(),
        this.campaignsService.findByRunId(tenantId, runId),
        this.metaAdsLibraryOutputModel.findOne({ tenantId, runId }).lean().exec(),
      ]);

    // Attach creative package to campaign data
    let creativePackage = null;
    if (creativeBrief) {
      creativePackage = await this.creativePackageModel
        .findOne({ tenantId, briefId: (creativeBrief as any).briefId })
        .lean()
        .exec();
    }

    // Normalize creative package to new schema shape for backward compatibility.
    // Old packages have flat imageUrl/videoUrl fields — convert to images[]/video{} so
    // the frontend always receives the same shape regardless of when the run was created.
    if (creativePackage) {
      const pkg = creativePackage as any;
      if (!pkg.images || pkg.images.length === 0) {
        pkg.images = pkg.imageUrl
          ? [{ variantIndex: 0, imagePrompt: pkg.imagePrompt ?? '', imageUrl: pkg.imageUrl }]
          : [];
      }
      if (!pkg.video) {
        pkg.video = (pkg.videoUrl || pkg.videoPrompt)
          ? {
              variantIndex: pkg.selectedCopyIndex ?? 0,
              videoPrompt: pkg.videoPrompt ?? '',
              videoUrl: pkg.videoUrl ?? '',
              videoThumbnailUrl: pkg.videoThumbnailUrl ?? '',
            }
          : null;
      }
    }

    return {
      run,
      scouts,
      coordinator,
      research,
      adLibrary: adLibrary?.insights ?? null,
      briefs,
      creativeBrief,
      creativePackage,
      campaign,
      digests,
    };
  }

  /**
   * POST /api/v1/pipeline/:tenantId/trigger
   * Starts a pipeline run for a tenant. Returns immediately with runId.
   */
  @Post(':tenantId/trigger')
  async trigger(@Param('tenantId') tenantId: string) {
    try {
      return await this.orchestrator.trigger(tenantId);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/pipeline/:tenantId/runs/:runId
   * Poll for pipeline status.
   */
  @Get(':tenantId/runs/:runId')
  async getStatus(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    const run = await this.orchestrator.getStatus(tenantId, runId);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return run;
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/strategy-team-test
   * Runs ONLY the Strategy Team debate using existing scout/research data from a past run.
   * Reuses coordinator output + competitor/market research already in MongoDB.
   */
  @Post(':tenantId/runs/:runId/strategy-team-test')
  async strategyTeamTest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // Load existing coordinator output
      const coordOutput = await this.coordinatorOutputModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();
      if (!coordOutput) {
        throw new Error(`No coordinator output found for runId=${runId}`);
      }

      // Load existing research
      const research = await this.researchOutputModel
        .find({ tenantId, runId })
        .lean()
        .exec();
      const rawCompetitor = research.find((r) => r.type === 'competitor');
      const rawMarket = research.find((r) => r.type === 'market');

      const fallbackResearch = (summary: string) => ({
        insights: [{ insight: 'Research unavailable', implication: summary.slice(0, 300), urgency: 'low' as const, score: 1 }],
        rawSummary: summary.slice(0, 300),
      });

      const competitorResearch = rawCompetitor?.structured ?? fallbackResearch(rawCompetitor?.content ?? '');
      const marketResearch = rawMarket?.structured ?? fallbackResearch(rawMarket?.content ?? '');

      const testRunId = `strategy-test-${Date.now()}`;

      const result = await this.strategyTeam.run(
        company,
        testRunId,
        {
          coordinatorOutputId: (coordOutput as any)._id.toString(),
          content: coordOutput.content,
          topSignals: coordOutput.topSignals,
          viralTrends: (coordOutput as any).viralTrends ?? [],
        },
        competitorResearch,
        marketResearch,
        { competitorAds: [], gaps: [], dominantFormat: 'unknown', rawSummary: '' },
      );

      return { success: true, runId: testRunId, result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/generate-digest
   * Generates digest from Strategy Team debate output.
   * Uses coordinator data from sourceRunId and strategy briefs from the given runId.
   */
  @Post(':tenantId/runs/:runId/generate-digest')
  async generateDigestFromDebate(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // Load creative brief to find source coordinator run
      const creativeBrief = await this.creativeBriefModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();
      if (!creativeBrief) {
        throw new Error(`No creative brief found for runId=${runId}`);
      }

      // Load coordinator from the most recent full pipeline run
      const coordOutput = await this.coordinatorOutputModel
        .findOne({ tenantId })
        .sort({ _id: -1 })
        .lean()
        .exec();
      if (!coordOutput) {
        throw new Error('No coordinator output found');
      }

      // Load all intelligence briefs from the strategy test run
      const allBriefs = await this.intelligenceBriefModel
        .find({ tenantId, runId })
        .lean()
        .exec();

      await this.digestWriter.run(
        company,
        runId,
        {
          coordinatorOutputId: (coordOutput as any)._id.toString(),
          content: coordOutput.content,
          topSignals: coordOutput.topSignals,
          viralTrends: (coordOutput as any).viralTrends ?? [],
        },
        {
          briefs: allBriefs.map((b) => ({
            briefId: b.selected ? creativeBrief.briefId : (b as any).briefId ?? '',
            product: (b as any).product ?? '',
            targetSegment: (b as any).targetSegment ?? '',
            topic: b.topic,
            angle: b.angle,
            platform: b.platform,
            format: b.format,
            audience: b.audience,
            hook: b.selected ? creativeBrief.hook : (b as any).hook ?? '',
            keyMessage: b.selected ? creativeBrief.keyMessage : (b as any).keyMessage ?? '',
            conversionBridge: b.selected ? creativeBrief.conversionBridge : (b as any).conversionBridge ?? '',
            suggestedBudget: b.suggestedBudget,
            finalScore: b.finalScore,
          })),
          selectedBriefId: creativeBrief.briefId,
          selectionReason: creativeBrief.selectionReason,
        },
      );

      return { success: true, message: 'Digest generated and delivered' };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/creative-team-test
   * Runs ONLY the Creative Team debate using an existing creative brief.
   */
  @Post(':tenantId/runs/:runId/creative-team-test')
  async creativeTeamTest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      const brief = await this.creativeBriefModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();
      if (!brief) {
        throw new Error(`No creative brief found for runId=${runId}`);
      }

      const testRunId = `creative-test-${Date.now()}`;

      const result = await this.creativeTeam.run(
        {
          topic: brief.topic,
          angle: brief.angle,
          platform: brief.platform,
          format: brief.format,
          audience: brief.audience,
          hook: brief.hook,
          keyMessage: brief.keyMessage,
          conversionBridge: brief.conversionBridge,
        },
        company,
        testRunId,
      );

      return { success: true, runId: testRunId, result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/campaign-review-test
   * Full flow: Campaign Review Team debate → save as pending_approval → Slack notification.
   * Returns the campaignId for approval.
   */
  @Post(':tenantId/runs/:runId/campaign-review-test')
  async campaignReviewTest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      const brief = await this.creativeBriefModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();
      if (!brief) throw new Error(`No creative brief found for runId=${runId}`);

      // Try to load creative package, use empty if not found
      const pkg = await this.creativePackageModel
        .findOne({ tenantId, briefId: brief.briefId })
        .lean()
        .exec();

      const testRunId = `review-test-${Date.now()}`;

      console.log('Starting campaign review test with brief:', pkg);

      // Full flow: review → save as pending_approval → Slack
      const campaign = await this.campaignCreator.create(
        { ...brief, runId: testRunId } as any,
        (pkg ?? {}) as any,
        company,
        testRunId,
      );

      return {
        success: true,
        runId: testRunId,
        campaignId: (campaign as any)._id.toString(),
        status: campaign.status,
        budget: campaign.budget,
        message: 'Campaign pending approval. Check Slack or call POST /api/v1/campaigns/' + tenantId + '/' + (campaign as any)._id.toString() + '/approve to launch.',
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/produce/:briefId
   * Tenant picks any idea from the digest and triggers creative production + campaign review.
   * The system's auto-selected winner runs automatically. This endpoint lets tenants
   * run additional ideas as separate campaigns.
   */
  @Post(':tenantId/runs/:runId/produce/:briefId')
  async produceIdea(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
    @Param('briefId') briefId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // Find the intelligence brief
      const brief = await this.intelligenceBriefModel
        .findOne({ tenantId, runId, briefId })
        .lean()
        .exec();
      if (!brief) throw new Error(`Idea ${briefId} not found in run ${runId}`);

      const produceRunId = `produce-${briefId.slice(0, 8)}-${Date.now()}`;

      // Save as creative brief first (so campaign creator can find it)
      await this.creativeBriefModel.create({
        tenantId,
        runId: produceRunId,
        briefId,
        topic: brief.topic,
        angle: brief.angle,
        platform: brief.platform,
        format: brief.format,
        audience: brief.audience,
        hook: (brief as any).hook ?? '',
        keyMessage: (brief as any).keyMessage ?? '',
        conversionBridge: (brief as any).conversionBridge ?? '',
        suggestedBudget: brief.suggestedBudget,
        finalScore: brief.finalScore,
        selected: true,
        selectionReason: 'Manually selected by tenant from digest',
      });

      // Phase F: Creative production
      const creativePackage = await this.creativeProducer.produce(
        tenantId,
        briefId,
        produceRunId,
        {
          topic: brief.topic,
          angle: brief.angle,
          platform: brief.platform,
          format: brief.format,
          audience: brief.audience,
          hook: (brief as any).hook ?? '',
          keyMessage: (brief as any).keyMessage ?? '',
          conversionBridge: (brief as any).conversionBridge ?? '',
          audienceStage: (brief as any).audienceStage,
          explorationArm: (brief as any).explorationArm,
          // Forward exploit-winner marker — Creative Team reads it and anchors
          // on the source winner's hookLine pattern.
          winnerCloneOf: (brief as any).winnerCloneOf,
        },
      );

      // Phase G: Campaign creation (review + pending approval)
      const creativeBrief = await this.creativeBriefModel
        .findOne({ tenantId, runId: produceRunId, briefId })
        .lean()
        .exec();

      const campaign = await this.campaignCreator.create(
        creativeBrief as any,
        creativePackage,
        company,
        produceRunId,
      );

      return {
        success: true,
        runId: produceRunId,
        briefId,
        topic: brief.topic,
        campaignId: (campaign as any)._id.toString(),
        status: campaign.status,
        message: `Idea "${brief.topic}" is now in creative production + campaign review. Check Slack for approval.`,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/regenerate-digest
   * Regenerate and re-deliver the digest for an existing run using stored data.
   */
  @Post(':tenantId/runs/:runId/regenerate-digest')
  async regenerateDigest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      await this.orchestrator.regenerateDigest(tenantId, runId);
      return { success: true, message: 'Digest regenerated and delivered' };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }
}
