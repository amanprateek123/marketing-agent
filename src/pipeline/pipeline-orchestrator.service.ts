import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CompaniesService } from '../companies/companies.service';
import { PipelineRun, PipelineRunDocument } from './schemas/pipeline-run.schema';
import { InstagramScout } from './scouts/instagram.scout';
import { RedditScout } from './scouts/reddit.scout';
import { TwitterScout } from './scouts/twitter.scout';
import { YoutubeScout } from './scouts/youtube.scout';
import { CoordinatorService } from './coordinator.service';
import { IdeaPoolService } from './idea-pool.service';
import { DigestWriterService } from './digest-writer.service';

export interface TriggerPipelineResult {
  runId: string;
  status: string;
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
  ) {}

  async trigger(tenantId: string): Promise<TriggerPipelineResult> {
    const company = await this.companiesService.findByTenantId(tenantId);

    if (!company.prompts) {
      throw new Error(
        `Company ${tenantId} has no prompts. Run /regenerate first.`,
      );
    }

    const runId = uuidv4();

    const run = await this.pipelineRunModel.create({
      tenantId,
      runId,
      status: 'pending',
      startedAt: new Date(),
    });

    // Fire-and-forget: don't await, return runId immediately
    this.executeDAG(tenantId, runId, run._id.toString()).catch((err) => {
      this.logger.error(`Pipeline DAG failed: ${err.message}`, err.stack);
    });

    return { runId, status: 'pending' };
  }

  async getStatus(runId: string): Promise<PipelineRunDocument | null> {
    return this.pipelineRunModel.findOne({ runId }).lean().exec();
  }

  private async executeDAG(
    tenantId: string,
    runId: string,
    _docId: string,
  ): Promise<void> {
    const update = (status: string, phase: string) =>
      this.pipelineRunModel.updateOne({ runId }, { status, phase });

    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // ── Phase A: Scouts run in parallel ──────────────────────────────────
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

      // ── Phase B: Coordinator synthesises signals ──────────────────────────
      await update('intelligence_running', 'coordinator');
      this.logger.log(`[${runId}] Phase B: coordinator`);

      const coordinatorResult = await this.coordinatorService.run(company, runId);

      // ── Phase C: Intelligence agents run in parallel ──────────────────────
      this.logger.log(`[${runId}] Phase C: intelligence agents`);

      const [competitorResearch, marketResearch] = await Promise.all([
        this.coordinatorService.runCompetitorResearch(
          company,
          runId,
          coordinatorResult.content,
        ),
        this.coordinatorService.runMarketResearch(
          company,
          runId,
          coordinatorResult.content,
        ),
      ]);

      // ── Phase D: Idea Pool ────────────────────────────────────────────────
      await update('idea_pool_running', 'idea_pool');
      this.logger.log(`[${runId}] Phase D: idea pool`);

      const ideaPoolResult = await this.ideaPoolService.run(
        company,
        runId,
        coordinatorResult,
        competitorResearch,
        marketResearch,
      );

      // ── Phase E: Digest ───────────────────────────────────────────────────
      this.logger.log(`[${runId}] Phase E: digest writer`);

      await this.digestWriterService.run(
        company,
        runId,
        coordinatorResult,
        ideaPoolResult,
      );

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
