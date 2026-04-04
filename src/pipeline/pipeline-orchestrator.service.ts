import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CompaniesService } from '../companies/companies.service';
import { PipelineRun, PipelineRunDocument } from './schemas/pipeline-run.schema';
import { ScoutOutput, ScoutOutputDocument } from './schemas/scout-output.schema';
import { CoordinatorOutput, CoordinatorOutputDocument } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputDocument } from './schemas/research-output.schema';
import { CreativeBrief, CreativeBriefDocument } from './schemas/creative-brief.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from './schemas/intelligence-brief.schema';
import { Digest, DigestDocument } from './schemas/digest.schema';
import { InstagramScout } from './scouts/instagram.scout';
import { RedditScout } from './scouts/reddit.scout';
import { TwitterScout } from './scouts/twitter.scout';
import { YoutubeScout } from './scouts/youtube.scout';
import { CoordinatorService, CoordinatorResult } from './coordinator.service';
import { IdeaPoolService, IdeaPoolResult } from './idea-pool.service';
import { DigestWriterService } from './digest-writer.service';
import { CreativeProducerService } from '../creative/creative-producer/creative-producer.service';
import { CampaignCreatorService } from '../campaigns/campaign-creator/campaign-creator.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { StrategyTeamService } from '../teams/strategy-team.service';

export interface TriggerPipelineResult {
  runId: string;
  status: string;
  resumed?: boolean;
}

@Injectable()
export class PipelineOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(PipelineOrchestratorService.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly instagramScout: InstagramScout,
    private readonly redditScout: RedditScout,
    private readonly twitterScout: TwitterScout,
    private readonly youtubeScout: YoutubeScout,
    private readonly coordinatorService: CoordinatorService,
    private readonly digestWriterService: DigestWriterService,
    private readonly creativeProducerService: CreativeProducerService,
    private readonly campaignCreatorService: CampaignCreatorService,
    private readonly campaignsService: CampaignsService,
    private readonly strategyTeam: StrategyTeamService,
    private readonly ideaPoolService: IdeaPoolService,
    @InjectModel(PipelineRun.name)
    private readonly pipelineRunModel: Model<PipelineRunDocument>,
    @InjectModel(ScoutOutput.name)
    private readonly scoutOutputModel: Model<ScoutOutputDocument>,
    @InjectModel(CoordinatorOutput.name)
    private readonly coordinatorOutputModel: Model<CoordinatorOutputDocument>,
    @InjectModel(ResearchOutput.name)
    private readonly researchOutputModel: Model<ResearchOutputDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(Digest.name)
    private readonly digestModel: Model<DigestDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recoverStuckRuns();
  }

  private async recoverStuckRuns(): Promise<void> {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stuckStatuses = ['pending', 'scouts_running', 'intelligence_running', 'idea_pool_running'];

    const stuckRuns = await this.pipelineRunModel
      .find({
        status: { $in: stuckStatuses },
        updatedAt: { $lt: twoHoursAgo },
      })
      .lean()
      .exec();

    if (stuckRuns.length === 0) return;

    this.logger.warn(`Found ${stuckRuns.length} stuck run(s) — recovering...`);

    for (const run of stuckRuns) {
      this.logger.log(`Recovering stuck run: ${run.runId} (status: ${run.status})`);
      await this.pipelineRunModel.updateOne(
        { runId: run.runId },
        { status: 'pending', error: null },
      );
      this.executeDAG(run.tenantId, run.runId).catch((err) => {
        this.logger.error(`Recovery failed for ${run.runId}: ${err.message}`);
      });
    }
  }

  async trigger(tenantId: string): Promise<TriggerPipelineResult> {
    const company = await this.companiesService.findByTenantId(tenantId);

    if (!company.prompts) {
      throw new Error(`Company ${tenantId} has no prompts. Run /regenerate first.`);
    }

    // Check for a resumable failed run
    const failedRun = await this.pipelineRunModel
      .findOne({ tenantId, status: 'failed' })
      .sort({ startedAt: -1 })
      .lean()
      .exec();

    if (failedRun) {
      this.logger.log(`[${failedRun.runId}] Resuming failed run`);
      await this.pipelineRunModel.updateOne(
        { runId: failedRun.runId },
        { status: 'pending', error: null },
      );
      this.executeDAG(tenantId, failedRun.runId).catch((err) => {
        this.logger.error(`Pipeline DAG failed: ${err.message}`, err.stack);
      });
      return { runId: failedRun.runId, status: 'pending', resumed: true };
    }

    // Fresh run
    const runId = uuidv4();
    await this.pipelineRunModel.create({ tenantId, runId, status: 'pending', startedAt: new Date() });

    this.executeDAG(tenantId, runId).catch((err) => {
      this.logger.error(`Pipeline DAG failed: ${err.message}`, err.stack);
    });

    return { runId, status: 'pending', resumed: false };
  }

  async getStatus(tenantId: string, runId: string): Promise<PipelineRunDocument | null> {
    return this.pipelineRunModel.findOne({ tenantId, runId }).lean().exec();
  }

  async regenerateDigest(tenantId: string, runId: string): Promise<void> {
    const company = await this.companiesService.findByTenantId(tenantId);

    // Load coordinator result
    const coordinatorOutput = await this.coordinatorOutputModel
      .findOne({ tenantId, runId })
      .lean()
      .exec();
    if (!coordinatorOutput) {
      throw new Error(`No coordinator output found for runId=${runId}`);
    }

    // Load creative brief (selected idea)
    const creativeBrief = await this.creativeBriefModel
      .findOne({ tenantId, runId })
      .lean()
      .exec();
    if (!creativeBrief) {
      throw new Error(`No creative brief found for runId=${runId}`);
    }

    // Load all intelligence briefs
    const allBriefs = await this.intelligenceBriefModel
      .find({ tenantId, runId })
      .lean()
      .exec();

    // Delete existing digests for this run so we get a fresh set
    await this.digestModel.deleteMany({ tenantId, runId });

    const coordinatorResult: CoordinatorResult = {
      coordinatorOutputId: coordinatorOutput._id.toString(),
      content: coordinatorOutput.content,
      topSignals: coordinatorOutput.topSignals,
    };

    const ideaPoolResult: IdeaPoolResult = {
      briefs: allBriefs.map((b) => ({
        briefId: b.selected ? creativeBrief.briefId : '',
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.selected ? creativeBrief.hook : '',
        keyMessage: b.selected ? creativeBrief.keyMessage : '',
        conversionBridge: b.selected ? creativeBrief.conversionBridge : '',
        suggestedBudget: b.suggestedBudget,
        finalScore: b.finalScore,
      })),
      selectedBriefId: creativeBrief.briefId,
      selectionReason: creativeBrief.selectionReason,
    };

    this.logger.log(`[${runId}] Regenerating digest for tenantId=${tenantId}`);
    await this.digestWriterService.run(company, runId, coordinatorResult, ideaPoolResult);
    this.logger.log(`[${runId}] Digest regenerated`);
  }

  private async executeDAG(tenantId: string, runId: string): Promise<void> {
    const update = (status: string, phase: string) =>
      this.pipelineRunModel.updateOne({ runId }, { status, phase });

    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // ── Phase A: Scouts ───────────────────────────────────────────────────
      const existingScouts = await this.scoutOutputModel
        .find({ tenantId, runId })
        .lean()
        .exec();

      if (existingScouts.length >= 4) {
        this.logger.log(`[${runId}] Phase A: skipped — scouts already complete`);
      } else {
        await update('scouts_running', 'scouts');
        this.logger.log(`[${runId}] Phase A: scouts starting`);

        const [instagram, reddit, twitter, youtube] = await Promise.all([
          this.instagramScout.execute(company, runId),
          this.redditScout.execute(company, runId),
          this.twitterScout.execute(company, runId),
          this.youtubeScout.execute(company, runId),
        ]);

        this.logger.log(
          `[${runId}] Phase A done — signals: instagram=${instagram.trending_topics.length} reddit=${reddit.trending_topics.length} twitter=${twitter.trending_topics.length} youtube=${youtube.trending_topics.length}`,
        );
      }

      // ── Phase B: Coordinator ──────────────────────────────────────────────
      const existingCoordinator = await this.coordinatorOutputModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();

      let coordinatorResult: CoordinatorResult;

      if (existingCoordinator) {
        this.logger.log(`[${runId}] Phase B: skipped — coordinator already complete`);
        coordinatorResult = {
          coordinatorOutputId: existingCoordinator._id.toString(),
          content: existingCoordinator.content,
          topSignals: existingCoordinator.topSignals,
        };
      } else {
        await update('intelligence_running', 'coordinator');
        this.logger.log(`[${runId}] Phase B: coordinator`);
        coordinatorResult = await this.coordinatorService.run(company, runId);
      }

      // ── Phase C: Intelligence agents ──────────────────────────────────────
      const existingResearch = await this.researchOutputModel
        .find({ tenantId, runId })
        .lean()
        .exec();

      let competitorResearch: string;
      let marketResearch: string;

      if (existingResearch.length >= 2) {
        this.logger.log(`[${runId}] Phase C: skipped — research already complete`);
        competitorResearch = existingResearch.find((r) => r.type === 'competitor')?.content ?? '';
        marketResearch = existingResearch.find((r) => r.type === 'market')?.content ?? '';
      } else {
        this.logger.log(`[${runId}] Phase C: intelligence agents`);
        [competitorResearch, marketResearch] = await Promise.all([
          this.coordinatorService.runCompetitorResearch(company, runId, coordinatorResult.content),
          this.coordinatorService.runMarketResearch(company, runId, coordinatorResult.content),
        ]);
      }

      // ── Phase D: Idea Pool ────────────────────────────────────────────────
      const existingBrief = await this.creativeBriefModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();

      let ideaPoolResult!: IdeaPoolResult;

      if (existingBrief) {
        this.logger.log(`[${runId}] Phase D: skipped — idea pool already complete`);
        const allBriefs = await this.intelligenceBriefModel
          .find({ tenantId, runId })
          .lean()
          .exec();
        ideaPoolResult = {
          briefs: allBriefs.map((b) => ({
            briefId: b.selected ? existingBrief.briefId : '',
            topic: b.topic,
            angle: b.angle,
            platform: b.platform,
            format: b.format,
            audience: b.audience,
            hook: b.selected ? existingBrief.hook : '',
            keyMessage: b.selected ? existingBrief.keyMessage : '',
            conversionBridge: b.selected ? existingBrief.conversionBridge : '',
            suggestedBudget: b.suggestedBudget,
            finalScore: b.finalScore,
          })),
          selectedBriefId: existingBrief.briefId,
          selectionReason: existingBrief.selectionReason,
        };
      } else {
        await update('idea_pool_running', 'idea_pool');

        // Try Strategy Team (peer-to-peer debate) with retry + fallback
        let teamSucceeded = false;
        for (let attempt = 1; attempt <= 2 && !teamSucceeded; attempt++) {
          try {
            this.logger.log(`[${runId}] Phase D: Strategy Team attempt ${attempt}/2`);
            const teamResult = await this.strategyTeam.run(
              company, runId, coordinatorResult, competitorResearch, marketResearch,
            );

            // Validate: did a real debate happen?
            if (teamResult.briefs.length > 0 && teamResult.selectedBriefId) {
              ideaPoolResult = teamResult;
              teamSucceeded = true;
              this.logger.log(`[${runId}] Phase D done (Strategy Team) — ${teamResult.briefs.length} ideas, winner selected`);
            } else {
              this.logger.warn(`[${runId}] Strategy Team returned empty/invalid result on attempt ${attempt}`);
            }
          } catch (err: any) {
            this.logger.warn(`[${runId}] Strategy Team attempt ${attempt} failed: ${err.message}`);
          }
        }

        // Fallback: single-agent IdeaPool
        if (!teamSucceeded) {
          this.logger.warn(`[${runId}] Phase D: falling back to single-agent IdeaPool`);
          ideaPoolResult = await this.ideaPoolService.run(
            company, runId, coordinatorResult, competitorResearch, marketResearch,
          );
          this.logger.log(`[${runId}] Phase D done (IdeaPool fallback) — ${ideaPoolResult.briefs.length} ideas`);
        }
      }

      // ── Phase E: Digest ───────────────────────────────────────────────────
      const existingDigest = await this.digestModel
        .findOne({ tenantId, runId, type: 'cta' })
        .lean()
        .exec();

      if (existingDigest) {
        this.logger.log(`[${runId}] Phase E: skipped — digest already complete`);
      } else {
        this.logger.log(`[${runId}] Phase E: digest writer`);
        await this.digestWriterService.run(company, runId, coordinatorResult, ideaPoolResult);
      }

      // ── Phase F: Creative Production ──────────────────────────────────────
      const existingCreative = await this.creativeProducerService.findByBriefId(
        tenantId,
        ideaPoolResult.selectedBriefId,
      );

      let creativePackage: any;

      if (existingCreative) {
        this.logger.log(`[${runId}] Phase F: skipped — creative already complete`);
        creativePackage = existingCreative;
      } else {
        await update('creative_running', 'creative');
        this.logger.log(`[${runId}] Phase F: creative production`);

        const selectedBrief = ideaPoolResult.briefs.find(
          (b) => b.briefId === ideaPoolResult.selectedBriefId,
        );
        if (!selectedBrief) throw new Error('Selected brief not found in idea pool result');

        creativePackage = await this.creativeProducerService.produce(
          tenantId,
          selectedBrief.briefId,
          runId,
          {
            topic: selectedBrief.topic,
            angle: selectedBrief.angle,
            platform: selectedBrief.platform,
            format: selectedBrief.format,
            audience: selectedBrief.audience,
            hook: selectedBrief.hook,
            keyMessage: selectedBrief.keyMessage,
            conversionBridge: selectedBrief.conversionBridge,
          },
        );
      }

      // ── Phase G: Campaign Launch ───────────────────────────────────────────
      const existingCampaign = await this.campaignsService
        .findAll(tenantId)
        .then((campaigns) => campaigns.find((c) => c.runId === runId));

      if (existingCampaign) {
        this.logger.log(`[${runId}] Phase G: skipped — campaign already launched`);
      } else {
        await update('campaign_launching', 'campaign');
        this.logger.log(`[${runId}] Phase G: campaign launch`);

        const creativeBriefDoc = await this.creativeBriefModel
          .findOne({ tenantId, runId, briefId: ideaPoolResult.selectedBriefId })
          .lean()
          .exec();

        if (!creativeBriefDoc) throw new Error('Creative brief not found for campaign launch');

        const campaign = await this.campaignCreatorService.create(
          creativeBriefDoc,
          creativePackage,
          company,
          runId,
        );

        await this.pipelineRunModel.updateOne(
          { runId },
          { campaignId: campaign._id.toString(), metaCampaignId: campaign.metaCampaignId },
        );
      }

      // ── Done ──────────────────────────────────────────────────────────────
      await this.pipelineRunModel.updateOne(
        { runId },
        {
          status: 'completed',
          phase: 'done',
          completedAt: new Date(),
          briefsGenerated: ideaPoolResult.briefs.length,
          selectedBriefId: ideaPoolResult.selectedBriefId,
        },
      );

      this.logger.log(`[${runId}] Pipeline COMPLETED`);
    } catch (err: any) {
      await this.pipelineRunModel.updateOne(
        { runId },
        { status: 'failed', error: err.message, completedAt: new Date() },
      );
      this.logger.error(`[${runId}] Pipeline FAILED: ${err.message}`);
    }
  }
}
