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
import { CreativeTeamService } from '../teams/creative-team.service';
import { CampaignReviewTeamService } from '../teams/campaign-review-team.service';
import { CampaignCreatorService } from '../campaigns/campaign-creator/campaign-creator.service';
import { CreativePackage } from '../creative/schemas/creative-package.schema';

@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly companiesService: CompaniesService,
    private readonly strategyTeam: StrategyTeamService,
    private readonly digestWriter: DigestWriterService,
    private readonly creativeTeam: CreativeTeamService,
    private readonly campaignReviewTeam: CampaignReviewTeamService,
    private readonly campaignCreator: CampaignCreatorService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackage>,
    @InjectModel(CoordinatorOutput.name)
    private readonly coordinatorOutputModel: Model<CoordinatorOutput>,
    @InjectModel(ResearchOutput.name)
    private readonly researchOutputModel: Model<ResearchOutput>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBrief>,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBrief>,
  ) {}

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
   * GET /api/v1/pipeline/runs/:runId
   * Poll for pipeline status.
   */
  @Get('runs/:runId')
  async getStatus(@Param('runId') runId: string) {
    const run = await this.orchestrator.getStatus(runId);
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
      const competitorResearch = research.find((r) => r.type === 'competitor')?.content ?? '';
      const marketResearch = research.find((r) => r.type === 'market')?.content ?? '';

      const testRunId = `strategy-test-${Date.now()}`;

      const result = await this.strategyTeam.run(
        company,
        testRunId,
        {
          coordinatorOutputId: (coordOutput as any)._id.toString(),
          content: coordOutput.content,
          topSignals: coordOutput.topSignals,
        },
        competitorResearch,
        marketResearch,
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
        },
        {
          briefs: allBriefs.map((b) => ({
            briefId: b.selected ? creativeBrief.briefId : (b as any).briefId ?? '',
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
