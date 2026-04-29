import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CompaniesService } from '../companies/companies.service';
import { PipelineRun, PipelineRunDocument } from './schemas/pipeline-run.schema';
import { ScoutOutput, ScoutOutputDocument } from './schemas/scout-output.schema';
import { CoordinatorOutput, CoordinatorOutputDocument } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputDocument, StructuredResearch } from './schemas/research-output.schema';
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
import { MetaAdsLibraryService } from './meta-ads-library.service';
import { MetaAdsLibraryInsights } from './schemas/meta-ads-library-output.schema';

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
    private readonly metaAdsLibrary: MetaAdsLibraryService,
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

    this.logger.warn(`Found ${stuckRuns.length} stuck run(s) — recovering with staggered starts...`);

    for (let i = 0; i < stuckRuns.length; i++) {
      const run = stuckRuns[i];
      this.logger.log(`Recovering stuck run: ${run.runId} tenantId=${run.tenantId} (status: ${run.status})`);
      await this.pipelineRunModel.updateOne(
        { tenantId: run.tenantId, runId: run.runId },
        { status: 'pending', error: null },
      );

      // Stagger recovery — 30s between each run to avoid thundering herd
      const delayMs = i * 30_000;
      setTimeout(() => {
        this.executeDAG(run.tenantId, run.runId).catch((err) => {
          this.logger.error(`Recovery failed for ${run.runId}: ${err.message}`);
        });
      }, delayMs);
    }
  }

  async trigger(tenantId: string): Promise<TriggerPipelineResult> {
    const company = await this.companiesService.findByTenantId(tenantId);

    if (!company.prompts) {
      throw new Error(`Company ${tenantId} has no prompts. Run /regenerate first.`);
    }

    // ── Concurrent-run guard ───────────────────────────────────────────────────
    // Manual /trigger + scheduled BullMQ + recoverStuckRuns can all fire for
    // the same tenant. Two parallel executeDAGs share tenantId, write into
    // separate runId namespaces, double Claude spend, double Slack delivery,
    // and racing campaign launches both hit Meta. Guard via in-flight check.
    // Status set: pending = queued, running = executing, in_progress = mid-DAG.
    const inFlight = await this.pipelineRunModel
      .findOne({ tenantId, status: { $in: ['pending', 'running', 'in_progress'] } })
      .lean()
      .exec();
    if (inFlight) {
      // Stale-run rescue: if the pending/running doc is older than the recovery
      // window, treat it as orphaned (process crashed) — let the caller proceed
      // (recoverStuckRuns will reclaim it). Otherwise reject the trigger.
      const ageMs = Date.now() - new Date((inFlight as any).startedAt).getTime();
      const STALE_MS = 2 * 60 * 60 * 1000; // 2h matches existing recovery TTL
      if (ageMs < STALE_MS) {
        this.logger.warn(`[${inFlight.runId}] Trigger rejected — pipeline already in flight (status=${inFlight.status}, age=${Math.round(ageMs / 1000)}s)`);
        return { runId: inFlight.runId, status: inFlight.status, resumed: false };
      }
      this.logger.warn(`[${inFlight.runId}] Stale in-flight run detected (age=${Math.round(ageMs / 60000)}m) — proceeding with new trigger; recovery will reconcile`);
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
    await this.pipelineRunModel.create({
      tenantId, runId, status: 'pending', startedAt: new Date(),
      // Stamp prompt version so we can later correlate run quality with prompt drift
      promptsVersion: (company as any).promptsVersion ?? 1,
    });

    this.executeDAG(tenantId, runId).catch((err) => {
      this.logger.error(`Pipeline DAG failed: ${err.message}`, err.stack);
    });

    return { runId, status: 'pending', resumed: false };
  }

  /**
   * Synchronous variant of trigger() for BullMQ workers. Awaits the full DAG
   * execution and re-throws on failure so BullMQ records the job as failed and
   * retries per the queue's `attempts` config. The HTTP `trigger()` path
   * deliberately fires-and-forgets so the controller can return runId quickly;
   * worker jobs need the opposite — the job lifecycle must reflect DAG outcome.
   */
  async runForJob(tenantId: string): Promise<TriggerPipelineResult> {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.prompts) {
      throw new Error(`Company ${tenantId} has no prompts. Run /regenerate first.`);
    }

    // Same in-flight + resume gating as trigger(), minus the fire-and-forget.
    const inFlight = await this.pipelineRunModel
      .findOne({ tenantId, status: { $in: ['pending', 'running', 'in_progress'] } })
      .lean()
      .exec();
    if (inFlight) {
      const ageMs = Date.now() - new Date((inFlight as any).startedAt).getTime();
      const STALE_MS = 2 * 60 * 60 * 1000;
      if (ageMs < STALE_MS) {
        this.logger.warn(`[${inFlight.runId}] runForJob: skipping — pipeline already in flight`);
        return { runId: inFlight.runId, status: inFlight.status, resumed: false };
      }
    }

    const failedRun = await this.pipelineRunModel
      .findOne({ tenantId, status: 'failed' })
      .sort({ startedAt: -1 })
      .lean()
      .exec();

    let runId: string;
    let resumed = false;
    if (failedRun) {
      runId = failedRun.runId;
      resumed = true;
      await this.pipelineRunModel.updateOne({ runId }, { status: 'pending', error: null });
    } else {
      runId = uuidv4();
      await this.pipelineRunModel.create({
      tenantId, runId, status: 'pending', startedAt: new Date(),
      // Stamp prompt version so we can later correlate run quality with prompt drift
      promptsVersion: (company as any).promptsVersion ?? 1,
    });
    }

    // Await the DAG — throw propagates to BullMQ which records job failure.
    await this.executeDAG(tenantId, runId);
    return { runId, status: 'completed', resumed };
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
      viralTrends: coordinatorOutput.viralTrends ?? [],
    };

    const ideaPoolResult: IdeaPoolResult = {
      briefs: allBriefs.map((b) => ({
        briefId: b.selected ? creativeBrief.briefId : (b.briefId ?? ''),
        product: (b as any).product ?? '',
        targetSegment: (b as any).targetSegment ?? '',
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.hook ?? (b.selected ? creativeBrief.hook : ''),
        keyMessage: b.keyMessage ?? (b.selected ? creativeBrief.keyMessage : ''),
        conversionBridge: b.conversionBridge ?? (b.selected ? creativeBrief.conversionBridge : ''),
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

        // Use allSettled so one failing scout doesn't kill the entire pipeline
        const [igResult, rdResult, twResult, ytResult] = await Promise.allSettled([
          this.instagramScout.execute(company, runId),
          this.redditScout.execute(company, runId),
          this.twitterScout.execute(company, runId),
          this.youtubeScout.execute(company, runId),
        ]);

        const scoutNames = ['instagram', 'reddit', 'twitter', 'youtube'];
        const scoutResults = [igResult, rdResult, twResult, ytResult];
        let successCount = 0;

        for (let i = 0; i < scoutResults.length; i++) {
          const r = scoutResults[i];
          if (r.status === 'fulfilled') {
            successCount++;
          } else {
            this.logger.error(`[${runId}] ${scoutNames[i]} scout failed (continuing): ${r.reason?.message ?? r.reason}`);
          }
        }

        if (successCount === 0) {
          throw new Error('All 4 scouts failed — no signals to process');
        }

        const counts = scoutResults.map((r, i) =>
          r.status === 'fulfilled' ? `${scoutNames[i]}=${r.value.trending_topics.length}` : `${scoutNames[i]}=FAILED`
        );
        this.logger.log(`[${runId}] Phase A done — signals: ${counts.join(' ')}`);
      }

      // ── Phase B + B2: Coordinator & Meta Ads Library (parallel) ─────────────
      // Both depend only on company data + scout outputs — neither depends on the other.
      await update('intelligence_running', 'coordinator');
      this.logger.log(`[${runId}] Phase B+B2: coordinator + meta ads library (parallel)`);

      const [coordinatorSettled, adLibrarySettled] = await Promise.allSettled([
        // Phase B: Coordinator
        (async (): Promise<CoordinatorResult> => {
          const existingCoordinator = await this.coordinatorOutputModel
            .findOne({ tenantId, runId })
            .lean()
            .exec();
          if (existingCoordinator) {
            this.logger.log(`[${runId}] Phase B: skipped — coordinator already complete`);
            return {
              coordinatorOutputId: existingCoordinator._id.toString(),
              content: existingCoordinator.content,
              topSignals: existingCoordinator.topSignals,
              viralTrends: existingCoordinator.viralTrends ?? [],
            };
          }
          return this.coordinatorService.run(company, runId);
        })(),

        // Phase B2: Meta Ads Library
        this.metaAdsLibrary.runIdempotent(company, runId),
      ]);

      // Coordinator is required — fail pipeline if it errors
      if (coordinatorSettled.status === 'rejected') {
        throw new Error(`Coordinator failed: ${coordinatorSettled.reason?.message ?? coordinatorSettled.reason}`);
      }
      const coordinatorResult: CoordinatorResult = coordinatorSettled.value;

      // Meta Ads Library is optional — degrade gracefully
      let adLibraryInsights: MetaAdsLibraryInsights;
      if (adLibrarySettled.status === 'fulfilled') {
        adLibraryInsights = adLibrarySettled.value;
        this.logger.log(`[${runId}] Phase B2: Meta Ads Library done | competitorAds: ${adLibraryInsights.competitorAds.length} | gaps: ${adLibraryInsights.gaps.length}`);
      } else {
        this.logger.warn(`[${runId}] Phase B2: Meta Ads Library failed — continuing without it: ${adLibrarySettled.reason?.message ?? adLibrarySettled.reason}`);
        adLibraryInsights = { competitorAds: [], gaps: [], dominantFormat: 'unknown', rawSummary: '' };
      }

      // ── Phase C: Intelligence agents ──────────────────────────────────────
      const existingResearch = await this.researchOutputModel
        .find({ tenantId, runId })
        .lean()
        .exec();

      let competitorResearch: StructuredResearch;
      let marketResearch: StructuredResearch;

      const fallbackResearch = (summary: string): StructuredResearch => ({
        insights: [{ insight: 'Research unavailable', implication: summary.slice(0, 300), urgency: 'low', score: 1 }],
        rawSummary: summary.slice(0, 300),
      });

      // Check each research type independently — avoid re-running successful ones on resume
      const existingCompetitor = existingResearch.find((r) => r.type === 'competitor');
      const existingMarket = existingResearch.find((r) => r.type === 'market');

      if (existingCompetitor && existingMarket) {
        this.logger.log(`[${runId}] Phase C: skipped — research already complete`);
        competitorResearch = existingCompetitor.structured ?? fallbackResearch(existingCompetitor.content ?? '');
        marketResearch = existingMarket.structured ?? fallbackResearch(existingMarket.content ?? '');
      } else {
        this.logger.log(`[${runId}] Phase C: intelligence agents (competitor: ${existingCompetitor ? 'cached' : 'running'}, market: ${existingMarket ? 'cached' : 'running'})`);

        // Only run what's missing — use allSettled so one failure doesn't kill both
        const [competitorSettled, marketSettled] = await Promise.allSettled([
          existingCompetitor
            ? Promise.resolve(existingCompetitor.structured ?? fallbackResearch(existingCompetitor.content ?? ''))
            : this.coordinatorService.runCompetitorResearch(company, runId, coordinatorResult.content),
          existingMarket
            ? Promise.resolve(existingMarket.structured ?? fallbackResearch(existingMarket.content ?? ''))
            : this.coordinatorService.runMarketResearch(company, runId, coordinatorResult.content),
        ]);

        competitorResearch = competitorSettled.status === 'fulfilled'
          ? competitorSettled.value
          : (() => { this.logger.error(`[${runId}] Competitor research failed (continuing): ${competitorSettled.reason?.message}`); return fallbackResearch(''); })();

        marketResearch = marketSettled.status === 'fulfilled'
          ? marketSettled.value
          : (() => { this.logger.error(`[${runId}] Market research failed (continuing): ${marketSettled.reason?.message}`); return fallbackResearch(''); })();
      }

      // ── Phase D: Idea Pool ────────────────────────────────────────────────
      const existingBrief = await this.creativeBriefModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();

      let ideaPoolResult: IdeaPoolResult | null = null;

      if (existingBrief) {
        this.logger.log(`[${runId}] Phase D: skipped — idea pool already complete`);
        const allBriefs = await this.intelligenceBriefModel
          .find({ tenantId, runId })
          .lean()
          .exec();
        ideaPoolResult = {
          briefs: allBriefs.map((b) => ({
            briefId: b.selected ? existingBrief.briefId : (b.briefId ?? ''),
            product: (b as any).product ?? '',
            targetSegment: (b as any).targetSegment ?? '',
            topic: b.topic,
            angle: b.angle,
            platform: b.platform,
            format: b.format,
            audience: b.audience,
            hook: b.hook ?? (b.selected ? existingBrief.hook : ''),
            keyMessage: b.keyMessage ?? (b.selected ? existingBrief.keyMessage : ''),
            conversionBridge: b.conversionBridge ?? (b.selected ? existingBrief.conversionBridge : ''),
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
              company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights,
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
            company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights,
          );
          this.logger.log(`[${runId}] Phase D done (IdeaPool fallback) — ${ideaPoolResult.briefs.length} ideas`);
        }
      }

      if (!ideaPoolResult) {
        throw new Error(`[${runId}] Phase D failed — both Strategy Team and IdeaPool returned no result. Pipeline aborted.`);
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
            product: selectedBrief.product,
            targetSegment: selectedBrief.targetSegment,
            // Stage from the brief (Strategy Team / IdeaPool now sets this; defaults
            // to 'cold' on the schema for prospecting). Closes the gap where first-pass
            // creatives always defaulted to cold even if the brief was warm-shaped.
            audienceStage: (selectedBrief as any).audienceStage,
          },
        );
      }

      // ── Phase G: Campaign Launch ───────────────────────────────────────────
      const existingCampaign = await this.campaignsService.findByRunId(tenantId, runId);

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
