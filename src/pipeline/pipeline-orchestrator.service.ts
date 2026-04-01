import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CompaniesService } from '../companies/companies.service';
import { PipelineRun, PipelineRunDocument } from './schemas/pipeline-run.schema';
import { ScoutOutput, ScoutOutputDocument, ScoutOutputData } from './schemas/scout-output.schema';
import { CoordinatorOutput, CoordinatorOutputDocument } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputDocument } from './schemas/research-output.schema';
import { CreativeBrief, CreativeBriefDocument } from './schemas/creative-brief.schema';
import { Digest, DigestDocument } from './schemas/digest.schema';
import { InstagramScout } from './scouts/instagram.scout';
import { RedditScout } from './scouts/reddit.scout';
import { TwitterScout } from './scouts/twitter.scout';
import { YoutubeScout } from './scouts/youtube.scout';
import { CoordinatorService, CoordinatorResult } from './coordinator.service';
import { IdeaPoolService, IdeaPoolResult } from './idea-pool.service';
import { DigestWriterService } from './digest-writer.service';

export interface TriggerPipelineResult {
  runId: string;
  status: string;
  resumed?: boolean;
}

@Injectable()
export class PipelineOrchestratorService {
  private readonly logger = new Logger(PipelineOrchestratorService.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly instagramScout: InstagramScout,
    private readonly redditScout: RedditScout,
    private readonly twitterScout: TwitterScout,
    private readonly youtubeScout: YoutubeScout,
    private readonly coordinatorService: CoordinatorService,
    private readonly ideaPoolService: IdeaPoolService,
    private readonly digestWriterService: DigestWriterService,
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
    @InjectModel(Digest.name)
    private readonly digestModel: Model<DigestDocument>,
  ) {}

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

  async getStatus(runId: string): Promise<PipelineRunDocument | null> {
    return this.pipelineRunModel.findOne({ runId }).lean().exec();
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

      let scoutData: Record<string, ScoutOutputData>;

      if (existingScouts.length >= 4) {
        this.logger.log(`[${runId}] Phase A: skipped — scouts already complete`);
        scoutData = Object.fromEntries(existingScouts.map((s) => [s.platform, s.data]));
      } else {
        await update('scouts_running', 'scouts');
        this.logger.log(`[${runId}] Phase A: scouts starting`);

        const [instagram, reddit, twitter, youtube] = await Promise.all([
          this.instagramScout.execute(company, runId),
          this.redditScout.execute(company, runId),
          this.twitterScout.execute(company, runId),
          this.youtubeScout.execute(company, runId),
        ]);

        scoutData = { instagram, reddit, twitter, youtube };
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

      let ideaPoolResult: IdeaPoolResult;

      if (existingBrief) {
        this.logger.log(`[${runId}] Phase D: skipped — idea pool already complete`);
        ideaPoolResult = {
          briefs: [],
          selectedBriefId: existingBrief.briefId,
          selectionReason: existingBrief.selectionReason,
        };
      } else {
        await update('idea_pool_running', 'idea_pool');
        this.logger.log(`[${runId}] Phase D: idea pool`);
        ideaPoolResult = await this.ideaPoolService.run(
          company, runId, coordinatorResult, competitorResearch, marketResearch,
        );
      }

      // ── Phase E: Digest ───────────────────────────────────────────────────
      const existingDigest = await this.digestModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();

      if (existingDigest) {
        this.logger.log(`[${runId}] Phase E: skipped — digest already complete`);
      } else {
        this.logger.log(`[${runId}] Phase E: digest writer`);
        await this.digestWriterService.run(company, runId, coordinatorResult, ideaPoolResult);
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
