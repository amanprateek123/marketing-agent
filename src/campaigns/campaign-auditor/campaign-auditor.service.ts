import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { AgentType } from '../../claude/claude.types';
import { CompaniesService } from '../../companies/companies.service';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { AuditSnapshot, AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';
import { SignalDetectorService, AuditSignalPacket } from './signal-detector.service';
import { AuditAgentService, AuditVerdict } from './audit-agent.service';
import { MetaMetricsService, FullCampaignMetrics } from '../meta-ads/meta-metrics.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { withUtmParams } from '../meta-ads/meta-utm.util';
import { SlackService } from '../../delivery/slack.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';
import { CreativeLearningService } from '../../learning/creative-learning.service';
import { CampaignLearningService } from '../../learning/campaign-learning.service';
import { ShadowActionService } from '../../learning/shadow-action.service';
import { CampaignOptimizerService } from './campaign-optimizer.service';
import { QUEUES } from '../../scheduler/queue.constants';
import { HOOK_STYLES_DR } from '../../common/creative/hook-styles';

export interface AuditResult {
  tenantId: string;
  campaignsAudited: number;
  paused: number;
  actionsCreated: number;
  performanceWritten: number;
}

/**
 * Name normalisation between Meta's two APIs:
 *   - INSIGHTS API returns position labels: 'feed', 'instagram_reels', 'instagram_stories', 'facebook_reels', 'facebook_stories', 'instream_video', etc.
 *   - TARGETING API uses different labels: facebook_positions=['feed','facebook_reels','story',...], instagram_positions=['stream','reels','story',...]
 *
 * The maps below let the byPlacement filter cross-check: given a targeting
 * position (e.g. instagram_positions=['reels']), which insights position labels
 * mean "currently active"? Without this, an ad set restricted to 'reels' in
 * targeting wouldn't match the 'instagram_reels' insights label and we'd
 * incorrectly tag IG Reels spend as "excluded from targeting".
 */
const TARGETING_POSITION_TO_INSIGHTS: Record<string, string> = {
  // facebook
  'facebook|feed': 'feed',
  'facebook|right_hand_column': 'right_hand_column',
  'facebook|marketplace': 'marketplace',
  'facebook|video_feeds': 'video_feeds',
  'facebook|story': 'facebook_stories',
  'facebook|search': 'search',
  'facebook|instream_video': 'instream_video',
  'facebook|facebook_reels': 'facebook_reels',
  // instagram — 'stream' = IG Feed (NOT Reels — this is the bug that cost us 18h on 91astro)
  'instagram|stream': 'feed',
  'instagram|story': 'instagram_stories',
  'instagram|explore': 'explore',
  'instagram|reels': 'instagram_reels',
  'instagram|shop': 'shop',
  'instagram|profile_feed': 'profile_feed',
  'instagram|ig_search': 'ig_search',
  // audience_network
  'audience_network|classic': 'classic',
  'audience_network|rewarded_video': 'rewarded_video',
  'audience_network|instream_video': 'instream_video',
};

/**
 * Reverse map: when an ad set has null positions for a platform (= all positions
 * active), we mark ALL of these insights position labels as currently-active so
 * the byPlacement filter doesn't incorrectly exclude any.
 */
const TARGETING_TO_INSIGHTS_POSITIONS: Record<string, string[]> = {
  facebook: ['feed', 'right_hand_column', 'marketplace', 'video_feeds', 'facebook_stories', 'search', 'instream_video', 'facebook_reels'],
  instagram: ['feed', 'instagram_stories', 'explore', 'instagram_reels', 'shop', 'profile_feed', 'ig_search'],
  audience_network: ['classic', 'rewarded_video', 'instream_video'],
  messenger: ['messenger_home', 'sponsored_messages', 'story'],
};

@Injectable()
export class CampaignAuditorService {
  private readonly logger = new Logger(CampaignAuditorService.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly campaignsService: CampaignsService,
    private readonly signalDetector: SignalDetectorService,
    private readonly auditAgent: AuditAgentService,
    private readonly optimizer: CampaignOptimizerService,
    private readonly actionLogger: ActionLoggerService,
    private readonly creativeLearning: CreativeLearningService,
    private readonly campaignLearning: CampaignLearningService,
    private readonly shadowActions: ShadowActionService,
    private readonly metaMetrics: MetaMetricsService,
    private readonly metaAds: MetaAdsService,
    private readonly slackService: SlackService,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(AuditSnapshot.name)
    private readonly snapshotModel: Model<AuditSnapshotDocument>,
    @InjectQueue(QUEUES.CREATIVE_PRODUCTION)
    private readonly creativeQueue: Queue,
  ) {}

  /**
   * Execute a single approved action immediately (called from approve endpoint).
   * Runs the same logic as executePendingActions but for one specific action.
   */
  async executeApprovedAction(
    campaign: CampaignDocument,
    company: CompanyDocument,
    actionId: string,
  ): Promise<void> {
    const freshCampaign = await this.campaignModel.findOne({ _id: campaign._id }).exec();
    if (!freshCampaign) return;

    const pendingActions = (freshCampaign as any).pendingActions ?? [];
    const action = pendingActions.find((a: any) => a.actionId === actionId);
    if (!action || action.status !== 'executed') return;

    // Re-run executePendingActions — it will pick up this action since status is 'executed'
    await this.executePendingActions(freshCampaign, company);
  }

  async audit(tenantId: string): Promise<AuditResult> {
    const company = await this.companiesService.findByTenantId(tenantId);
    const activeCampaigns = await this.campaignsService.findActive(tenantId);

    this.logger.log(`Auditing ${activeCampaigns.length} active agent campaign(s) for tenantId=${tenantId}`);

    const result: AuditResult = {
      tenantId,
      campaignsAudited: activeCampaigns.length,
      paused: 0,
      actionsCreated: 0,
      performanceWritten: 0,
    };

    // Fetch account-level CPM environment ONCE per audit batch (not per campaign).
    // This is shared across all campaigns in the same account — distinguishes
    // "your campaign tanked" from "everyone's CPMs spiked this week".
    let marketEnvironment: AuditSignalPacket['marketEnvironment'] = null;
    if (company.meta?.accessToken && company.meta?.accountId && activeCampaigns.length > 0) {
      try {
        marketEnvironment = await this.metaMetrics.fetchAccountEnvironment(
          company.meta.accountId,
          company.meta.accessToken,
        );
      } catch (err: any) {
        this.logger.warn(`Account CPM env fetch failed: ${err.message} — proceeding without it`);
      }
    }

    for (const campaign of activeCampaigns) {
      try {
        await this.auditCampaign(campaign, company, result, marketEnvironment);
      } catch (err: any) {
        this.logger.error(`Audit failed for campaign ${campaign.metaCampaignId}: ${err.message}`);
      }
    }

    this.logger.log(
      `Audit complete: tenantId=${tenantId} audited=${result.campaignsAudited} paused=${result.paused} actions=${result.actionsCreated} written=${result.performanceWritten}`,
    );

    return result;
  }

  /**
   * Audit a single campaign by tenant + campaign Mongo _id. Same flow as `audit()`
   * but scoped to one campaign — fetches the market environment once, then runs
   * the standard auditCampaign pass. Surfaced for the dashboard's "Run Audit Now"
   * button and ad-hoc debugging via POST /:tenantId/:campaignId/audit.
   * Throws if the campaign isn't found under this tenant.
   */
  async auditOne(tenantId: string, campaignId: string): Promise<AuditResult> {
    const company = await this.companiesService.findByTenantId(tenantId);
    // Accept either the Mongo _id (24-char hex from the dashboard URL) or the
    // numeric metaCampaignId (what shows up in Ads Manager and Slack alerts).
    // Without this fallback, callers using the Meta ID get a Mongoose cast error
    // instead of a useful "not found" response.
    const isObjectId = /^[a-f0-9]{24}$/i.test(campaignId);
    const campaign = isObjectId
      ? await this.campaignModel.findOne({ tenantId, _id: campaignId }).exec()
      : await this.campaignModel.findOne({ tenantId, metaCampaignId: campaignId }).exec();
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found for tenantId=${tenantId}`);
    }

    this.logger.log(`Auditing single campaign ${campaign.metaCampaignId} for tenantId=${tenantId}`);

    const result: AuditResult = {
      tenantId,
      campaignsAudited: 1,
      paused: 0,
      actionsCreated: 0,
      performanceWritten: 0,
    };

    // Same market-environment fetch the batch audit does — needed for DiD
    // adjustment on creativeFatigue and the auction_leak leak diagnosis.
    let marketEnvironment: AuditSignalPacket['marketEnvironment'] = null;
    if (company.meta?.accessToken && company.meta?.accountId) {
      try {
        marketEnvironment = await this.metaMetrics.fetchAccountEnvironment(
          company.meta.accountId,
          company.meta.accessToken,
        );
      } catch (err: any) {
        this.logger.warn(`Account CPM env fetch failed: ${err.message} — proceeding without it`);
      }
    }

    try {
      await this.auditCampaign(campaign, company, result, marketEnvironment);
    } catch (err: any) {
      this.logger.error(`Audit failed for campaign ${campaign.metaCampaignId}: ${err.message}`);
      throw err;
    }

    this.logger.log(
      `Single-campaign audit complete: campaignId=${campaignId} paused=${result.paused} actions=${result.actionsCreated} written=${result.performanceWritten}`,
    );

    return result;
  }

  private async auditCampaign(
    campaign: CampaignDocument,
    company: CompanyDocument,
    result: AuditResult,
    marketEnvironment: AuditSignalPacket['marketEnvironment'] = null,
  ): Promise<void> {
    if (!company.meta?.accessToken || !campaign.metaCampaignId) {
      this.logger.warn(`Skipping campaign ${campaign._id}: no Meta credentials or campaignId`);
      return;
    }

    // Skip campaigns less than 1 hour old — no meaningful data yet
    if (campaign.launchedAt) {
      const ageHours = (Date.now() - new Date(campaign.launchedAt).getTime()) / (1000 * 60 * 60);
      if (ageHours < 1) {
        this.logger.debug(`Skipping campaign ${campaign.metaCampaignId}: launched ${ageHours.toFixed(1)}h ago — too early`);
        return;
      }
    }

    // Skip campaigns older than 45 days — they should be paused or graduated by now
    if (campaign.launchedAt) {
      const ageDays = (Date.now() - new Date(campaign.launchedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > 45) {
        this.logger.debug(`Skipping campaign ${campaign.metaCampaignId}: ${Math.round(ageDays)}d old — too old for active auditing`);
        return;
      }
    }

    // ── Fetch live metrics from Meta ──────────────────────────────────────────
    // Match product to the one this campaign is actually selling
    const brief = campaign.briefId
      ? await this.briefModel.findOne({ tenantId: company.tenantId, briefId: campaign.briefId }).lean().exec()
      : null;
    const briefProduct = brief ? (brief as any).product : '';
    const product = (company.products ?? []).find(p => briefProduct ? p.name === briefProduct : p.active)
      ?? (company.products ?? []).find(p => p.active);
    const conversionValue = product?.conversionValue ?? product?.price ?? 0;
    const conversionEvent = product?.conversionEvent ?? 'Purchase';

    const [full, byPlacement, byHour, byDayOfWeek] = await Promise.all([
      this.metaMetrics.fetchFullMetrics(
        campaign.metaCampaignId,
        company.meta.accessToken,
        conversionValue,
        conversionEvent,
      ),
      this.metaMetrics.fetchPlacementBreakdown(
        campaign.metaCampaignId,
        company.meta.accessToken,
        conversionEvent,
      ),
      this.metaMetrics.fetchHourlyBreakdown(
        campaign.metaCampaignId,
        company.meta.accessToken,
        conversionEvent,
      ),
      this.metaMetrics.fetchDayOfWeekBreakdown(
        campaign.metaCampaignId,
        company.meta.accessToken,
        conversionEvent,
      ),
    ]);

    // Save ad-level metrics to campaign document
    await this.saveAdLevelMetrics(campaign, full);

    // Update campaign-level live metrics
    await this.campaignsService.updateMetrics(company.tenantId, campaign._id.toString(), {
      spend: full.campaign.spend,
      impressions: full.campaign.impressions,
      clicks: full.campaign.clicks,
      conversions: full.campaign.conversions,
      roas: full.campaign.roas,
      ctr: full.campaign.ctr,
      cpc: full.campaign.cpc,
    });

    // Execute any expired pending actions (agent campaigns only)
    if (campaign.source === 'agent') {
      await this.executePendingActions(campaign, company);
    }

    // Pre-compute weekly spend — used by both safety rails and signal detector
    const weeklySpend = await this.campaignsService.getWeeklySpend(company.tenantId);

    // ── Layer 1: Safety rails (agent-created campaigns only) ──────────────────
    // Non-agent campaigns (manual/imported) are tracked for metrics but never auto-paused
    if (campaign.source === 'agent') {
      const safetyPaused = await this.runSafetyRails(campaign, full, company, weeklySpend);
      if (safetyPaused) {
        result.paused++;
        return;
      }
    }

    // ── Layer 2: Signal detection ─────────────────────────────────────────────
    const snapshots = await this.snapshotModel
      .find({ tenantId: company.tenantId, campaignId: campaign._id.toString() })
      .sort({ auditedAt: -1 })
      .limit(10)
      .lean()
      .exec() as AuditSnapshotDocument[];

    // Filter byPlacement to tag rows whose placement is ALREADY EXCLUDED from
    // the ad set's current Meta targeting. Without this, the audit reads cumulative
    // lifetime placement spend and re-fires the same narrow_placement recommendation
    // for already-restricted placements every cycle (the 6-consecutive-recommendations
    // loop on 91astro). Stale lifetime data lies; this filter tells the LLM the truth.
    const taggedByPlacement = await this.tagByPlacementWithActiveTargeting(
      campaign, full, byPlacement, company.meta.accessToken,
    );

    const signals = this.signalDetector.detect(
      campaign, full, snapshots, company, weeklySpend, marketEnvironment,
      { byPlacement: taggedByPlacement, byHour, byDayOfWeek },
    );

    // ── Save audit snapshot ───────────────────────────────────────────────────
    const snapshotData = {
      tenantId: company.tenantId,
      campaignId: campaign._id.toString(),
      metaCampaignId: campaign.metaCampaignId,
      auditedAt: new Date(),
      metrics: {
        spend: full.campaign.spend,
        impressions: full.campaign.impressions,
        clicks: full.campaign.clicks,
        conversions: full.campaign.conversions,
        roas: full.campaign.roas,
        ctr: full.campaign.ctr,
        cpc: full.campaign.cpc,
        cpa: full.campaign.cpa,
        frequency: full.campaign.frequency,
      },
      adSets: full.adSets.map(as => ({
        metaAdSetId: as.adSetId,
        name: as.adSetName,
        audienceType: (campaign as any).adSets?.find((a: any) => a.metaAdSetId === as.adSetId)?.audienceType ?? '',
        spend: as.spend,
        conversions: as.conversions,
        ctr: as.ctr,
        cpa: as.cpa,
        roas: as.cpa > 0 && conversionValue > 0 ? conversionValue / as.cpa : 0,
        frequency: as.frequency,
      })),
      ads: full.adSets.flatMap(as =>
        as.ads.map(ad => {
          const localAd = (campaign as any).adSets
            ?.find((a: any) => a.metaAdSetId === as.adSetId)
            ?.ads?.find((a: any) => a.metaAdId === ad.adId);
          const hook = localAd?.hookStyle ?? '';
          const variantIdx = localAd?.copyVariantIndex ?? 0;
          return {
            metaAdId: ad.adId,
            name: hook ? `Ad ${variantIdx + 1} (${hook})` : ad.adId,
            hookStyle: hook,
            copyVariantIndex: variantIdx,
            adSetId: as.adSetId,
            spend: ad.spend,
            impressions: ad.impressions ?? 0,
            conversions: ad.conversions,
            ctr: ad.ctr,
            cpc: ad.cpc,
          };
        }),
      ),
      verdict: null,
      signals,
    };

    // ── Layer 3: Intelligent audit agent ──────────────────────────────────────
    // Short-circuit: skip Claude when all signals are green (saves LLM cost)
    const hasOpportunities =
      signals.opportunities.winningAdSets.length > 0 ||
      signals.opportunities.readyForRetarget ||
      signals.opportunities.earlyFatigue.length > 0;

    const isAllGreen =
      signals.anomalies.highSpendZeroConversions.length === 0 &&
      !signals.anomalies.campaignZeroConversions &&
      signals.anomalies.creativeFatigue.length === 0 &&
      signals.anomalies.audienceFatigue.length === 0 &&
      !signals.anomalies.stuckInLearning &&
      !signals.anomalies.budgetExhaustionRisk &&
      !signals.anomalies.unprofitableAfterDay3 &&
      !signals.anomalies.conversionDataIntegrity &&
      signals.anomalies.hookOverSaturation.length === 0 &&
      !signals.anomalies.cvrVsBenchmarkGap &&
      !signals.safetyBreaches.weeklyCapExceeded &&
      !signals.safetyBreaches.campaignCapExceeded &&
      signals.trends.ctrTrend !== 'declining' &&
      signals.trends.roasTrend !== 'declining' &&
      // Underspending Day-3+ means narrow targeting / losing auctions / creative
      // rejected — none of which are caught by the anomaly set. No other gate
      // catches it, so without this an underspending campaign goes silent.
      signals.trends.spendPace !== 'underspending' &&
      !hasOpportunities;

    // Cooldown removed — manual audits and the 6h cron always re-evaluate when
    // signals are red. Trade-off: every audit cycle that fires an anomaly hits
    // Claude (slightly more spend), in exchange for never silently skipping a
    // material signal because the conversion count happened to be stable.

    if (isAllGreen) {
      const age = signals.campaignAge;
      const conv = full.campaign.conversions;
      // Distinguish "campaign genuinely healthy" from "we don't have enough data
      // to fire any signal yet." Same all-green outcome, very different meaning —
      // case (b) feels safe but is actually blind. Heuristic: ≥50 clicks OR ≥1
      // conversion OR ≥3 snapshots = we have *some* basis to call this healthy.
      const hasEvidence = full.campaign.clicks >= 50
        || full.campaign.conversions >= 1
        || snapshots.length >= 3;
      const status = hasEvidence
        ? 'No anomalies — campaign healthy'
        : `No anomalies — INSUFFICIENT EVIDENCE (clicks=${full.campaign.clicks}, snapshots=${snapshots.length})`;
      const skipVerdict = {
        verdict: 'no_action' as const,
        urgency: null,
        contextInsight: `Day ${age.days.toFixed(0)} | ₹${full.campaign.spend.toFixed(0)} spent | ${conv} conversions | CTR ${full.campaign.ctr.toFixed(2)}% | ${status}`,
        leakDiagnosis: 'none' as const,  // all-green means no leak identified by the rule set
        watchSignals: [] as string[],
        recommendedActions: [] as any[],
      };
      snapshotData.verdict = skipVerdict as any;
      await this.snapshotModel.create(snapshotData);
      this.logger.debug(`All-green skip for campaign ${campaign.metaCampaignId}`);

      // Still run performance writeback even when skipping Claude
      if (campaign.launchedAt) {
        const ageMs = Date.now() - new Date(campaign.launchedAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const written = await this.writePerformanceBack(campaign, full, ageDays);
        if (written) result.performanceWritten++;
      }
      return;
    }

    const freshCampaign = await this.campaignModel.findOne({ _id: campaign._id }).lean().exec();
    const verdict = await this.auditAgent.analyze(freshCampaign ?? campaign, signals, snapshots, company, snapshotData);

    // Save verdict to snapshot
    snapshotData.verdict = verdict as any;
    await this.snapshotModel.create(snapshotData);

    // Persist hook saturation onto the company doc so the Creative Team + Strategy Team
    // can avoid hookStyles already saturated on each audience.
    //
    // Merge strategy: OVERWRITE per (audienceType, hookStyle) with the latest measurement
    // + a timestamp. Pre-B2 this was Math.max merge (monotonic, never decayed) — by month 3
    // the generator was permanently locked out of 2-3 hookStyles per audience. Now each
    // audit refreshes the values it observes; readers (LiveContextBuilder) drop entries
    // older than 14 days so a stale flag from a paused ad set doesn't restrict generation
    // forever. We don't try to AVERAGE across campaigns — the latest measurement IS the
    // current state.
    if (signals.hookSaturation && signals.hookSaturation.length > 0) {
      try {
        const existing = (company.learnings?.creative?.audienceHookSaturation ?? {}) as Record<string, Record<string, { pct: number; updatedAt: Date }>>;
        const merged: Record<string, Record<string, { pct: number; updatedAt: Date }>> = JSON.parse(JSON.stringify(existing));
        const now = new Date();
        for (const h of signals.hookSaturation) {
          if (!merged[h.audienceType]) merged[h.audienceType] = {};
          merged[h.audienceType][h.hookStyle] = { pct: h.saturationPct, updatedAt: now };
        }
        await this.companiesService.updateHookSaturation(company.tenantId, merged);
      } catch (err: any) {
        this.logger.warn(`Failed to persist hookSaturation: ${err.message}`);
      }
    }

    // ── Persist hot winners (drives the Strategy Team's exploit-winner arm) ──
    // Every winnerCandidate is upserted into company.learnings.hotWinners and
    // the campaign is flagged winnerCandidate=true. The next pipeline run's
    // Strategy Team reads hotWinners + clones the top one (varying topic).
    // Idempotent — upsertHotWinner keys on metaAdId and replaces with fresh metrics.
    if ((signals.opportunities.winnerCandidates ?? []).length > 0) {
      try {
        const launchedBudget = (campaign as any)?.campaignConfig?.budget
          ?? (campaign as any)?.budget
          ?? 0;
        const briefTopic = (() => {
          // Best-effort topic surface; brief lookup is async and we don't want
          // to slow the audit path. Topic is decorative for clone diversification.
          const config = (campaign as any)?.campaignConfig;
          return (campaign as any)?.topic ?? config?.topic ?? undefined;
        })();
        const productName = (campaign as any)?.productName
          ?? (company.products ?? []).find(p => p.active)?.name;

        for (const winner of signals.opportunities.winnerCandidates) {
          await this.companiesService.upsertHotWinner(company.tenantId, {
            campaignId: campaign._id.toString(),
            briefId: (campaign as any).briefId ?? '',
            metaAdId: winner.metaAdId,
            productName,
            hookStyle: winner.hookStyle,
            audienceType: winner.audienceType,
            format: winner.format,
            topic: briefTopic,
            spend: winner.spend,
            conversions: winner.conversions,
            cpa: winner.cpa,
            roas: winner.roas,
            ctr: winner.ctr,
            budgetTier: launchedBudget,
            observedAt: new Date(),
          });
        }

        // Flip winnerCandidate=true once. Avoid bumping winnerCandidateAt on
        // every audit — first-time-only timestamp.
        if (!(campaign as any).winnerCandidate) {
          await this.campaignModel.updateOne(
            { _id: campaign._id },
            { $set: { winnerCandidate: true, winnerCandidateAt: new Date() } },
          );
          this.logger.log(
            `Campaign ${campaign._id} flagged winnerCandidate=true (${signals.opportunities.winnerCandidates.length} winning ads)`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`Failed to persist hotWinners: ${err.message}`);
      }
    }

    // ── Layer 4: Actions only for agent-created campaigns ────────────────────
    // Manual/imported campaigns: audit runs but no actions are created or executed
    if (campaign.source === 'agent' && verdict.verdict === 'act') {
      const gracePeriodHours = company.pipelineConfig?.pauseGracePeriodHours ?? 12;
      const ageDays = signals.campaignAge.days;

      // TypeScript-enforced timing rules — Claude cannot override
      const recordTimingShadow = (action: any, reason: 'timing_guard_day_0_3' | 'timing_guard_day_3_7_growth') => {
        void this.shadowActions.recordBlocked({
          tenantId: company.tenantId,
          campaignId: campaign._id.toString(),
          metaCampaignId: campaign.metaCampaignId,
          proposedAction: {
            type: action.type, targetId: action.targetId, targetName: action.targetName,
            reason: action.reason, priority: action.priority, params: action.params,
          },
          blockedReason: reason,
          metricsAtT: {
            spend: campaign.spend ?? 0,
            impressions: campaign.impressions ?? 0,
            clicks: campaign.clicks ?? 0,
            conversions: campaign.conversions ?? 0,
            ctr: campaign.ctr ?? 0,
            cpc: campaign.cpc ?? 0,
            cpa: (campaign as any).cpa ?? 0,
            roas: campaign.roas ?? 0,
            frequency: (campaign as any).frequency ?? 0,
          },
        });
      };

      const allowedActions = verdict.recommendedActions.filter(action => {
        const isPause = action.type === 'pause_ad' || action.type === 'pause_adset';
        const isGrowth = action.type === 'scale_adset' || action.type === 'add_creative' || action.type === 'add_adset';
        const isCreativeFix = action.type === 'replace_creative';
        // Throttle = less destructive than pause. The auditor prompt explicitly tells the LLM
        // to use these for safety-rail breaches in day 0-3 (e.g. budget cap creep). If a
        // high-priority pause is allowed through, a high-priority throttle must be too —
        // otherwise the only escape from a budget breach in day 0-3 is the more destructive
        // pause action, which contradicts the prompt's "throttle before pause" rule.
        const isSafetyThrottle = action.type === 'reduce_total_budget';

        if (ageDays < 3) {
          // Day 0-3: only allow pauses or safety throttles if priority=high (overspending,
          // frequency breach). LLM is responsible for setting priority=high on safety cases.
          if ((isPause || isSafetyThrottle) && action.priority === 'high') {
            this.logger.log(`Timing guard: allowing high-priority ${action.type} on "${action.targetName}" in day 0-3 (safety exception)`);
            return true;
          }
          this.logger.warn(`Timing guard: blocking ${action.type} on "${action.targetName}" — campaign is ${ageDays.toFixed(1)}d old (< 3d)`);
          recordTimingShadow(action, 'timing_guard_day_0_3');
          return false;
        }
        if (ageDays < 7 && isGrowth) {
          // Day 3-7: pause + replace allowed, NO growth actions
          this.logger.warn(`Timing guard: blocking growth action ${action.type} — campaign is ${ageDays.toFixed(1)}d old (< 7d)`);
          recordTimingShadow(action, 'timing_guard_day_3_7_growth');
          return false;
        }
        return true;
      });

      for (const action of allowedActions) {
        const metrics: Record<string, any> = { ...(action.params ?? {}) };

        if (action.type === 'replace_creative') {
          metrics.replacementHook = this.pickReplacementHook(campaign, action.targetId, company);
          metrics.fatiguedHook = (campaign as any).adSets
            ?.flatMap((as: any) => as.ads ?? [])
            ?.find((a: any) => a.metaAdId === action.targetId)?.hookStyle ?? '';
        } else if (action.type === 'add_creative') {
          metrics.hookStyle = action.params?.hookStyle
            ?? this.pickReplacementHook(campaign, action.targetId, company);
        } else if (action.type === 'add_adset') {
          metrics.audienceType = action.params?.audienceType ?? 'retarget';
          metrics.targeting = action.params?.targeting ?? {};
          metrics.campaignId = campaign.metaCampaignId;
        } else if (action.type === 'refresh_audience') {
          // Capture source ad set's current frequency + campaign-level CTR trend
          // so the optimizer can re-validate at execution time (gates: freq>4.5, CTR not declining).
          const liveSourceAdSet = snapshotData.adSets?.find((as: any) => as.metaAdSetId === action.targetId);
          metrics.sourceFrequency = Number(liveSourceAdSet?.frequency ?? 0);
          metrics.sourceCtrTrend = signals.trends.ctrTrend;
        }

        const created = await this.createPendingAction(campaign, company, {
          type: action.type,
          targetId: action.targetId,
          targetName: action.targetName,
          reason: action.reason,
          metrics,
          gracePeriodHours: action.priority === 'high' ? gracePeriodHours : gracePeriodHours * 2,
        });
        if (created) result.actionsCreated++;
      }

      // Layer 3 — fire executePendingActions a second time to apply any actions
      // just marked status='executed' by the auto-apply path in createPendingAction.
      // The earlier executePendingActions() call (line ~266) ran BEFORE the verdict
      // produced new actions, so without this second pass auto-applied actions sit
      // in queue until the next 6h audit cycle — defeats the autonomy.
      if (campaign.source === 'agent') {
        const freshCampaign = await this.campaignModel.findOne({ _id: campaign._id }).exec();
        if (freshCampaign) await this.executePendingActions(freshCampaign, company);
      }

      // Send Slack digest for "act" verdict
      try {
        await this.sendAuditDigest(campaign, company, verdict, signals);
      } catch (slackErr: any) {
        this.logger.error(`Audit Slack digest failed — actions still created: ${slackErr.message}`);
      }
    } else if (verdict.verdict === 'watch') {
      // Only notify Slack if there are specific watch signals
      if (verdict.watchSignals.length > 0) {
        try {
          await this.sendWatchNotification(campaign, company, verdict);
        } catch (slackErr: any) {
          this.logger.error(`Audit watch Slack notification failed: ${slackErr.message}`);
        }
      }
    }

    // ── Performance writeback at day 7/14/30 ─────────────────────────────────
    const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const written = await this.writePerformanceBack(campaign, full, ageDays);
    if (written) result.performanceWritten++;

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: `audit_${verdict.verdict}`,
      reason: verdict.contextInsight,
      outcome: `Verdict: ${verdict.verdict} | urgency: ${verdict.urgency ?? 'none'} | actions: ${verdict.recommendedActions.length}`,
      metadata: { campaignId: campaign._id.toString(), metaCampaignId: campaign.metaCampaignId },
    });
  }

  /**
   * Tag byPlacement breakdown rows with whether the placement is currently
   * active in the ad sets' Meta targeting. Without this tag, the audit reads
   * cumulative lifetime placement spend and re-fires narrow_placement on
   * placements that have already been excluded — Groundhog Day on actions.
   *
   * For each ad set in the campaign, GET targeting and extract:
   *   - publisher_platforms (null = all platforms; else allow-list)
   *   - facebook_positions / instagram_positions / audience_network_positions
   *     / messenger_positions (null = all positions within platform; else allow-list)
   *
   * Then for each byPlacement row, check if its (publisherPlatform, platformPosition)
   * is in the union of active placements across all ad sets. If NOT, tag it
   * `excludedFromTargeting: true` so the audit-agent prompt knows to skip it
   * when recommending narrow_placement.
   *
   * Naming note: insights returns 'feed','instagram_reels','instagram_stories'
   * etc. while targeting uses 'feed','reels','story' — we normalize via a map.
   */
  private async tagByPlacementWithActiveTargeting(
    campaign: CampaignDocument,
    full: FullCampaignMetrics,
    byPlacement: any[],
    accessToken: string,
  ): Promise<any[]> {
    if (!byPlacement?.length) return byPlacement;

    // Build the set of (platform, insights-position) combos currently active across
    // all ad sets in this campaign. Union — if ANY ad set delivers a placement,
    // it's "active" at the campaign level.
    const activeKeys = new Set<string>();
    let allOpen = false;   // any ad set with null targeting = all-placements-active

    try {
      for (const adSet of (full.adSets ?? [])) {
        const targeting = await this.metaAds.getAdSetTargeting(adSet.adSetId, accessToken);
        if (!targeting) continue;
        const platforms: string[] | null = targeting.publisher_platforms ?? null;
        if (!platforms || platforms.length === 0) {
          // null publisher_platforms = Meta Advantage+ Placements = all active
          allOpen = true;
          break;
        }
        for (const p of platforms) {
          const positions: string[] | null =
            p === 'facebook' ? targeting.facebook_positions
            : p === 'instagram' ? targeting.instagram_positions
            : p === 'audience_network' ? targeting.audience_network_positions
            : p === 'messenger' ? targeting.messenger_positions
            : null;
          if (!positions || positions.length === 0) {
            // null positions for a platform = all positions within that platform
            // Mark every insights-position for that platform as active.
            for (const ip of TARGETING_TO_INSIGHTS_POSITIONS[p] ?? []) {
              activeKeys.add(`${p}|${ip}`);
            }
          } else {
            for (const pos of positions) {
              const insightsPos = TARGETING_POSITION_TO_INSIGHTS[`${p}|${pos}`] ?? pos;
              activeKeys.add(`${p}|${insightsPos}`);
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Active-targeting fetch failed: ${err.message} — proceeding without byPlacement filter`);
      return byPlacement;
    }

    return byPlacement.map(row => ({
      ...row,
      excludedFromTargeting: allOpen ? false : !activeKeys.has(`${row.publisherPlatform}|${row.platformPosition}`),
    }));
  }

  // ── Layer 1: Safety Rails ───────────────────────────────────────────────────
  private async runSafetyRails(
    campaign: CampaignDocument,
    full: FullCampaignMetrics,
    company: CompanyDocument,
    weeklySpend: number,
  ): Promise<boolean> {
    const spend = full.campaign.spend;
    const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Campaign cap exceeded
    if (company.maxBudgetPerCampaign && spend > company.maxBudgetPerCampaign) {
      await this.pauseCampaign(campaign, company, `Campaign spend ₹${spend.toFixed(0)} exceeded hard cap ₹${company.maxBudgetPerCampaign}`);
      return true;
    }

    // Weekly budget cap
    if (company.weeklyBudgetCap && weeklySpend > company.weeklyBudgetCap) {
      await this.pauseCampaign(campaign, company, `Weekly spend ₹${weeklySpend.toFixed(0)} exceeded weekly cap ₹${company.weeklyBudgetCap}`);
      return true;
    }

    // Frequency hard stop — audience fatigue (not just a warning)
    const maxFreq = company.pauseIfFrequencyAbove ?? 6;
    if (full.campaign.frequency > maxFreq * 1.5) {
      await this.pauseCampaign(campaign, company, `Frequency ${full.campaign.frequency.toFixed(1)} critically high (limit ${maxFreq}x1.5) — severe audience fatigue`);
      return true;
    }

    // Stuck in learning with significant spend — compare against expected cumulative (dailyBudget × days)
    const coldStartDays = company.pipelineConfig?.coldStartDays ?? 14;
    const expectedSpendToDate = (campaign.budget ?? 0) * Math.max(ageDays, 1);
    if (ageDays > coldStartDays * 2 && full.campaign.conversions === 0 && expectedSpendToDate > 0 && spend > expectedSpendToDate * 0.5) {
      await this.pauseCampaign(campaign, company, `${Math.round(ageDays)}d with 0 conversions and ₹${spend.toFixed(0)} spent (${Math.round(spend / expectedSpendToDate * 100)}% of expected) — safety pause`);
      return true;
    }

    return false;
  }

  private async saveAdLevelMetrics(campaign: CampaignDocument, full: FullCampaignMetrics): Promise<void> {
    const adSets = (campaign as any).adSets ?? [];
    if (adSets.length === 0) return;

    const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    for (const adSet of adSets) {
      const metaAdSet = full.adSets.find(a => a.adSetId === adSet.metaAdSetId);
      if (!metaAdSet) continue;

      adSet.metrics = {
        spend: metaAdSet.spend,
        impressions: metaAdSet.impressions,
        clicks: metaAdSet.clicks,
        conversions: metaAdSet.conversions,
        ctr: metaAdSet.ctr,
        cpc: metaAdSet.cpc,
        cpa: metaAdSet.cpa,
        frequency: metaAdSet.frequency,
        reach: metaAdSet.reach,
      };

      for (const ad of adSet.ads) {
        const metaAd = metaAdSet.ads.find((a: any) => a.adId === ad.metaAdId);
        if (!metaAd) continue;

        ad.metrics = {
          spend: metaAd.spend,
          impressions: metaAd.impressions,
          clicks: metaAd.clicks,
          conversions: metaAd.conversions,
          ctr: metaAd.ctr,
          cpc: metaAd.cpc,
        };

        // Set CTR baseline from first 48h
        if (!ad.ctrBaseline && ageHours >= 48 && metaAd.ctr > 0) {
          ad.ctrBaseline = metaAd.ctr;
          ad.baselineSetAt = new Date();
        }
      }
    }

    await this.campaignModel.updateOne({ _id: campaign._id }, { adSets, lastAuditedAt: new Date() });
  }

  private async createPendingAction(
    campaign: CampaignDocument,
    company: CompanyDocument,
    action: {
      type:
        | 'pause_ad'
        | 'pause_adset'
        | 'scale_adset'
        | 'replace_creative'
        | 'add_creative'
        | 'add_adset'
        | 'shift_budget_between_adsets'
        | 'reduce_total_budget'
        | 'narrow_placement'
        | 'dayparting'
        | 'refresh_audience';
      targetId: string;
      targetName: string;
      reason: string;
      metrics: Record<string, any>;
      gracePeriodHours: number;
    },
  ): Promise<boolean> {
    const pendingActions = (campaign as any).pendingActions ?? [];

    // Deduplicate only against PENDING actions, not executed ones.
    // Rationale: an executed action represents past state. A new audit producing the
    // same action type on the same target (with potentially different params) means
    // the system is proposing an updated version of the same intent — e.g. the first
    // narrow_placement only dropped Audience Network and the second proposes
    // position-level surgery. Blocking on prior executed actions traps the agent
    // in the first decision forever. Pending-only dedup keeps the queue clean
    // without silencing supersession.
    const existing = pendingActions.find(
      (a: any) => a.targetId === action.targetId && a.type === action.type &&
        a.status === 'pending',
    );
    if (existing) return false;

    // Special case for add_creative: also block when a recent (last 24h) action
    // with the SAME hookStyle was already auto-applied. Without this, the audit
    // re-fires add_creative every cycle until Meta delivery shifts share to the
    // new ad — producing 2-3 identical hookStyle ads in rapid succession instead
    // of one. Other hooks within 24h are still allowed (e.g. pain_point at 9am
    // + social_proof at 6pm is legitimate diversification). Different targetIds
    // (different ad sets) also bypass — each ad set tracks independently.
    if (action.type === 'add_creative') {
      const HOOK_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
      const recentSameHook = pendingActions.find(
        (a: any) => a.targetId === action.targetId
          && a.type === 'add_creative'
          && a.metrics?.hookStyle === action.metrics?.hookStyle
          && (a.status === 'pending' || a.status === 'executed')
          && a.recommendedAt
          && (Date.now() - new Date(a.recommendedAt).getTime()) < HOOK_DEDUP_WINDOW_MS,
      );
      if (recentSameHook) {
        this.logger.log(
          `Skipping add_creative on "${action.targetName}" — hookStyle "${action.metrics?.hookStyle}" already added/queued within 24h (existing action ${recentSameHook.actionId})`,
        );
        return false;
      }
    }

    const actionId = uuidv4();
    const now = new Date();
    const executeAt = new Date(now.getTime() + action.gracePeriodHours * 60 * 60 * 1000);

    // Layer 3 — auto-apply for low-risk, reversible actions. Skips the human
    // approval gate so the autonomous loop closes end-to-end. Non-reversible
    // actions (pause, audience refresh, big budget cuts) still require approval.
    //
    // Reversibility criteria:
    //   - narrow_placement: placements can be re-broadened by another narrow_placement
    //   - add_creative: additive, doesn't pause winners
    //   - dayparting: schedule can be cleared anytime
    //   - shift_budget_between_adsets: small (≤30%) intra-campaign reallocation
    //
    // Safety nets that make auto-apply safe:
    //   - TS-side parser validates params (e.g. position constants, schedule shape)
    //   - Optimizer-side guards refuse actions that violate Meta business rules
    //   - Frequency/CTR/breakeven gates inside the optimizer prevent extreme moves
    //   - The verdict was produced by Sonnet against the LEAK DIAGNOSIS FRAMEWORK
    const AUTO_APPLY_TYPES = new Set(['narrow_placement', 'add_creative', 'dayparting']);
    const shiftPercent = Number(action.metrics?.shiftPercent ?? 0);
    const isSmallShift = action.type === 'shift_budget_between_adsets' && Number.isFinite(shiftPercent) && shiftPercent > 0 && shiftPercent <= 30;
    const autoApply = AUTO_APPLY_TYPES.has(action.type) || isSmallShift;

    pendingActions.push({
      actionId,
      type: action.type,
      targetId: action.targetId,
      targetName: action.targetName,
      reason: action.reason,
      metrics: action.metrics,
      recommendedAt: now,
      // Auto-apply actions get executeAt=now so the next executePendingActions pass
      // picks them up immediately. Approval-gated actions retain the grace period
      // (gives operators time to review in Slack/dashboard).
      executeAt: autoApply ? now : executeAt,
      status: autoApply ? 'executed' : 'pending',
      // CRITICAL: set executedAt for auto-applied actions so the inner-handler
      // `manuallyApproved` checks (e.g. add_creative line ~1045) treat them as
      // approved-to-run. Without this, action sits at status='executed' but each
      // handler's `if (!manuallyApproved) continue;` skips it forever. The "already
      // ran" guard at line 904 still works because on first executePendingActions
      // pass executedAt is < 60s old (not skipped); on subsequent audits it's
      // hours old → skipped. Same semantics as a human-approved action.
      executedAt: autoApply ? now : undefined,
      autoApplied: autoApply || undefined,
    });

    await this.campaignModel.updateOne({ _id: campaign._id }, { pendingActions });
    if (autoApply) {
      this.logger.log(`Auto-applied ${action.type} on "${action.targetName}" (Layer 3 low-risk auto-apply)`);
    }
    return true;
  }

  private async executePendingActions(campaign: CampaignDocument, company: CompanyDocument): Promise<void> {
    const pendingActions = (campaign as any).pendingActions ?? [];
    const now = new Date();
    let updated = false;

    for (const action of pendingActions) {
      if (action.status !== 'pending' && action.status !== 'executed') continue;
      // Only execute if manually triggered (status = 'executed') or grace period expired
      const graceExpired = new Date(action.executeAt) <= now;
      const manuallyApproved = action.status === 'executed' && action.executedAt;

      if (!graceExpired && !manuallyApproved) continue;
      if (action.status === 'executed' && action.executedAt && new Date(action.executedAt) < new Date(now.getTime() - 60 * 1000)) continue; // already ran

      try {
        if (action.type === 'pause_ad') {
          await this.metaAds.pauseAd(action.targetId, company.meta!.accessToken);
          for (const adSet of (campaign as any).adSets ?? []) {
            const ad = adSet.ads.find((a: any) => a.metaAdId === action.targetId);
            if (ad) ad.status = 'paused';
          }
        } else if (action.type === 'pause_adset') {
          await this.metaAds.pauseAdSet(action.targetId, company.meta!.accessToken);
          const adSet = ((campaign as any).adSets ?? []).find((a: any) => a.metaAdSetId === action.targetId);
          if (adSet) adSet.status = 'paused';
        } else if (action.type === 'shift_budget_between_adsets') {
          // Revenue-neutral redistribution within the campaign — auto-executes on grace expiry.
          // Total spend unchanged, so risk is capped vs scale_adset which raises total burn.
          // Params were persisted into action.metrics by createPendingAction.
          const toAdSetId = action.metrics?.toAdSetId;
          const shiftPercent = Number(action.metrics?.shiftPercent);
          if (!toAdSetId) {
            this.logger.warn(`shift_budget action missing metrics.toAdSetId — skipping`);
            continue;
          }
          await this.optimizer.shiftBudgetBetweenAdSets(
            campaign,
            company,
            action.targetId,
            toAdSetId,
            shiftPercent,
          );
        } else if (action.type === 'reduce_total_budget') {
          // Throttle without killing — auto-executes on grace expiry. Reduces total spend
          // so it's lower-risk than scale_adset; explicit cap of 50% reduction in optimizer.
          const reductionPct = Number(action.metrics?.reductionPercent);
          if (!Number.isFinite(reductionPct) || reductionPct <= 0) {
            this.logger.warn(`reduce_total_budget missing/invalid reductionPercent — skipping`);
            continue;
          }
          await this.optimizer.reduceTotalBudget(campaign, company, reductionPct);
        } else if (action.type === 'narrow_placement') {
          // Disable bleeding placements — reversible (placements can be re-broadened).
          const publisherPlatforms = action.metrics?.publisherPlatforms;
          if (!Array.isArray(publisherPlatforms) || publisherPlatforms.length === 0) {
            this.logger.warn(`narrow_placement missing publisherPlatforms — skipping`);
            continue;
          }
          await this.optimizer.narrowAdSetPlacement(campaign, company, action.targetId, {
            publisherPlatforms,
            facebookPositions: action.metrics?.facebookPositions,
            instagramPositions: action.metrics?.instagramPositions,
            audienceNetworkPositions: action.metrics?.audienceNetworkPositions,
            messengerPositions: action.metrics?.messengerPositions,
          });
        } else if (action.type === 'dayparting') {
          // Restrict delivery hours — reversible (schedule can be cleared).
          const schedule = action.metrics?.schedule;
          if (!Array.isArray(schedule) || schedule.length === 0) {
            this.logger.warn(`dayparting missing schedule — skipping`);
            continue;
          }
          await this.optimizer.daypartAdSet(campaign, company, action.targetId, schedule);
        } else if (action.type === 'refresh_audience') {
          // Audience swap — requires explicit approval since it pauses the source ad set
          // and creates a new one (Meta API write that can't be cleanly undone).
          if (!manuallyApproved) continue;
          const newAudienceId = action.metrics?.newAudienceId;
          const useAdvantagePlus = action.metrics?.useAdvantagePlus === true;
          const sourceFreq = Number(action.metrics?.sourceFrequency);
          const sourceCtrTrend = action.metrics?.sourceCtrTrend ?? 'insufficient_data';
          if (!newAudienceId && !useAdvantagePlus) {
            this.logger.warn(`refresh_audience missing newAudienceId / useAdvantagePlus — skipping`);
            continue;
          }
          await this.optimizer.refreshAudience(
            campaign, company, action.targetId,
            { newAudienceId, useAdvantagePlus },
            { frequency: sourceFreq, ctrTrend: sourceCtrTrend },
          );
        } else if (action.type === 'scale_adset') {
          // Scale requires explicit approval — only execute if manually approved (not grace-expired)
          if (!manuallyApproved) continue;
          await this.optimizer.scaleAdSet(campaign, company, action.targetId, {
            spend: campaign.spend ?? 0,
            impressions: campaign.impressions ?? 0,
            clicks: campaign.clicks ?? 0,
            conversions: campaign.conversions ?? 0,
            roas: campaign.roas ?? 0,
            ctr: campaign.ctr ?? 0,
            cpc: campaign.cpc ?? 0,
            frequency: 0,
          });
        } else if (action.type === 'replace_creative') {
          // Replace creative requires explicit approval — auto-execute not supported yet
          if (!manuallyApproved) continue;
          // Pause the fatigued ad
          await this.metaAds.pauseAd(action.targetId, company.meta!.accessToken);
          for (const adSet of (campaign as any).adSets ?? []) {
            const ad = adSet.ads.find((a: any) => a.metaAdId === action.targetId);
            if (ad) ad.status = 'paused_for_replacement';
          }
          // Use pre-computed hook from action creation, or recompute if missing
          const replacementHook = action.metrics?.replacementHook
            ?? this.pickReplacementHook(campaign, action.targetId, company);

          // Track replacement lifecycle
          action.replacementStatus = 'queued';

          // Queue creative production job for autonomous replacement
          const sourceAdSetId = (campaign as any).adSets
            ?.find((as: any) => as.ads?.some((a: any) => a.metaAdId === action.targetId))
            ?.metaAdSetId ?? '';
          await this.creativeQueue.add(
            `replace-creative-${action.targetId}`,
            {
              tenantId: company.tenantId,
              campaignId: campaign._id.toString(),
              briefId: campaign.briefId,
              fatiguedAdId: action.targetId,
              fatiguedHook: action.metrics?.fatiguedHook ?? '',
              replacementHook,
              adSetId: sourceAdSetId,
              audienceStage: this.deriveAudienceStageFromAdSet(campaign, sourceAdSetId),
            },
            { attempts: 2, backoff: { type: 'exponential', delay: 60000 } },
          );

          this.logger.log(
            `Ad ${action.targetId} paused — creative replacement queued with hook "${replacementHook}"`,
          );

          // Notify Slack
          const slackWebhook = company.delivery?.slackWebhook;
          if (slackWebhook) {
            await this.slackService.sendMessage(
              slackWebhook,
              company.tenantId,
              `🔄 *Creative Replacement Queued*\n\n*Campaign:* ${campaign.name || campaign.metaCampaignId}\n*Fatigued Ad:* ${action.targetName} (hook: ${action.metrics?.fatiguedHook || 'unknown'})\n*Replacement Hook:* ${replacementHook}\n\nFatigued ad paused. New creative is being produced automatically.`,
            );
          }
        } else if (action.type === 'add_creative') {
          // Add fresh creative to winning ad set — requires approval
          if (!manuallyApproved) continue;
          const hookStyle = action.metrics?.hookStyle
            ?? this.pickReplacementHook(campaign, action.targetId, company);

          action.replacementStatus = 'queued';

          // Queue creative production — same as replace but doesn't pause existing ads
          await this.creativeQueue.add(
            `add-creative-${action.targetId}`,
            {
              tenantId: company.tenantId,
              campaignId: campaign._id.toString(),
              briefId: campaign.briefId,
              fatiguedAdId: '',  // empty = add new, don't replace
              fatiguedHook: '',
              replacementHook: hookStyle,
              adSetId: action.targetId,  // targetId is the ad set ID for add_creative
              audienceStage: this.deriveAudienceStageFromAdSet(campaign, action.targetId),
            },
            { attempts: 2, backoff: { type: 'exponential', delay: 60000 } },
          );

          this.logger.log(`Add creative queued for ad set ${action.targetId} with hook "${hookStyle}"`);
        } else if (action.type === 'add_adset') {
          // Add new ad set (retarget or narrowed) — requires approval
          if (!manuallyApproved) continue;
          let audienceType = action.metrics?.audienceType ?? 'retarget';
          const targeting = action.metrics?.targeting ?? {};

          // For retarget: find an existing retarget/custom audience from the product
          let retargetAudienceId: string | undefined;
          if (audienceType === 'retarget') {
            const product = (company.products ?? []).find((p: any) => p.active);
            const retargetAud = (product?.metaAudiences ?? []).find((a: any) =>
              a.type === 'custom' || a.type === 'retarget',
            );
            if (retargetAud) {
              retargetAudienceId = retargetAud.id;
            } else {
              // No retarget audience available — fall back to advantage_plus
              this.logger.warn('No retarget audience found — falling back to advantage_plus for new ad set');
              audienceType = 'advantage_plus';
            }
          }

          // Find the best-performing ad's copy variant to reuse in the new ad set
          const bestAdSet = (campaign as any).adSets?.find((as: any) =>
            as.ads?.some((a: any) => a.metrics?.conversions > 0),
          );
          const bestVariantIndex = bestAdSet?.ads
            ?.sort((a: any, b: any) => (b.metrics?.conversions ?? 0) - (a.metrics?.conversions ?? 0))[0]
            ?.copyVariantIndex ?? 0;

          // Load creative package for the winning variant's copy + image
          const creativePackage = campaign.creativePackageId
            ? await this.campaignsService.findCreativePackage(campaign.creativePackageId)
            : null;
          const bestVariant = (creativePackage as any)?.copyVariants?.[bestVariantIndex];
          const bestImage = ((creativePackage as any)?.images ?? []).find((img: any) => img.variantIndex === bestVariantIndex);

          if (!bestVariant) {
            this.logger.warn(`No copy variant ${bestVariantIndex} found for add_adset — skipping`);
            continue;
          }

          const adSetName = `${audienceType.toUpperCase()}_${new Date().toISOString().split('T')[0]}`;

          // Steal 20% budget from existing ad sets proportionally (total spend stays the same)
          const newAdSetPercent = 20;
          const existingAdSets = (campaign as any).adSets ?? [];
          const activeAdSets = existingAdSets.filter((as: any) => as.status === 'active');
          const totalExistingPercent = activeAdSets.reduce((s: number, as: any) => s + (as.budgetPercent ?? 0), 0);

          if (totalExistingPercent > 0) {
            const scaleFactor = (totalExistingPercent - newAdSetPercent) / totalExistingPercent;
            for (const as of activeAdSets) {
              const oldPercent = as.budgetPercent ?? 0;
              as.budgetPercent = Math.round(oldPercent * scaleFactor);
              // Update budget on Meta
              const newBudget = campaign.budget * (as.budgetPercent / 100);
              await this.metaAds.updateAdSetBudget(as.metaAdSetId, newBudget, company.meta!.accessToken);
            }
            this.logger.log(`Redistributed budget: existing ad sets scaled to ${Math.round(scaleFactor * 100)}% to make room for ${newAdSetPercent}%`);
          }

          // Inherit the existing campaign's optimization goal — adding a VALUE
          // ad set to an OFFSITE_CONVERSIONS campaign (or vice versa) splits
          // the learning signal and confuses ROAS comparison across ad sets.
          const inheritedOptimizationGoal =
            (campaign as any).campaignConfig?.adSets?.[0]?.optimizationGoal ?? 'OFFSITE_CONVERSIONS';

          // Create new ad set via Meta API
          const newAdSetId = await this.metaAds.createAdSetInCampaign(
            campaign.metaCampaignId,
            company.meta!.accessToken,
            {
              name: adSetName,
              budgetPercent: newAdSetPercent,
              audienceType,
              optimizationGoal: inheritedOptimizationGoal,
              ads: [bestVariantIndex],
              ...(retargetAudienceId ? { metaAudienceId: retargetAudienceId } : {}),
              ...(audienceType !== 'retarget' ? targeting : {}),
            },
            campaign.budget,
            (campaign as any).campaignConfig?.conversionEvent ?? 'Purchase',
            company.meta!.pixelId,
          );

          // Create an ad inside the new ad set using winning variant
          let newAdId = '';
          if (bestImage?.imageUrl) {
            const product = (company.products ?? []).find((p: any) => p.active);
            const newAdName = `${adSetName} — Variant ${bestVariantIndex + 1}`;
            const taggedLandingUrl = withUtmParams(product?.landingUrl ?? '', {
              campaignName: campaign.name ?? String(campaign._id),
              adSetName,
              adName: newAdName,
            });
            try {
              const { adId } = await this.metaAds.createAdInAdSet(
                newAdSetId,
                company.meta!.accessToken,
                newAdName,
                { primaryText: bestVariant.primaryText, headline: bestVariant.headline, cta: bestVariant.cta },
                bestImage.imageUrl,
                company.meta!.pageId ?? '',
                taggedLandingUrl,
                (company.meta as any)?.specialAdCategories ?? [],
              );
              newAdId = adId;
            } catch (adErr: any) {
              this.logger.error(`Failed to create ad in new ad set: ${adErr.message}`);
            }
          }

          // Activate the ad set
          await this.metaAds.updateAdStatus(newAdSetId, 'ACTIVE', company.meta!.accessToken);

          // Track in campaign document
          const adSets = existingAdSets;
          adSets.push({
            metaAdSetId: newAdSetId,
            name: adSetName,
            budgetPercent: newAdSetPercent,
            audienceType,
            status: 'active',
            ads: newAdId ? [{
              metaAdId: newAdId,
              copyVariantIndex: bestVariantIndex,
              hookStyle: bestVariant.hookStyle ?? '',
              status: 'active',
            }] : [],
          });

          await this.campaignModel.updateOne({ _id: campaign._id }, { adSets });
          this.logger.log(`New ${audienceType} ad set created: ${newAdSetId}${newAdId ? ` with ad ${newAdId}` : ' (no ad — image missing)'}`);
        }

        action.status = 'executed';
        action.executedAt = now;
        updated = true;

        await this.actionLogger.log({
          tenantId: company.tenantId,
          agent: AgentType.CAMPAIGN_AUDITOR,
          action: `auto_${action.type}`,
          reason: `Grace period expired — ${action.reason}`,
          outcome: `${action.type} executed on ${action.targetName}`,
          metadata: { actionId: action.actionId, targetId: action.targetId },
        });

        this.logger.log(`Pending action executed: ${action.type} on ${action.targetName}`);
      } catch (err: any) {
        this.logger.error(`Failed to execute pending action: ${err.message}`);
      }
    }

    if (updated) {
      await this.campaignModel.updateOne(
        { _id: campaign._id },
        { pendingActions, adSets: (campaign as any).adSets },
      );
    }
  }

  private async sendAuditDigest(
    campaign: CampaignDocument,
    company: CompanyDocument,
    verdict: AuditVerdict,
    signals: any,
  ): Promise<void> {
    const slackWebhook = company.delivery?.slackWebhook;
    if (!slackWebhook) return;

    const actionsText = verdict.recommendedActions.length > 0
      ? verdict.recommendedActions.map(a => {
          const approvalHint = (a.type === 'scale_adset' || a.type === 'replace_creative')
            ? `\n    _Requires approval:_ \`POST /api/v1/campaigns/${company.tenantId}/${campaign._id}/actions/{actionId}/approve\``
            : '';
          return `  • [${a.priority.toUpperCase()}] ${a.type.replace(/_/g, ' ')}: ${a.targetName}\n    _${a.reason}_${approvalHint}`;
        }).join('\n')
      : '  No specific actions recommended';

    const watchText = verdict.watchSignals.length > 0
      ? verdict.watchSignals.map(s => `  • ${s}`).join('\n')
      : '';

    const urgencyEmoji = verdict.urgency === 'immediate' ? '🚨' : verdict.urgency === '48h' ? '⚠️' : '📊';

    await this.slackService.sendMessage(
      slackWebhook,
      company.tenantId,
      `${urgencyEmoji} *Campaign Audit: Action Required*\n\n*Campaign:* ${campaign.name || campaign.metaCampaignId}\n*Urgency:* ${verdict.urgency ?? 'none'}\n\n*Analysis:*\n${verdict.contextInsight}\n\n*Recommended Actions:*\n${actionsText}${watchText ? `\n\n*Watch Next Audit:*\n${watchText}` : ''}\n\nReview: \`GET /api/v1/campaigns/${company.tenantId}/${campaign._id}\``,
    );
  }

  private async sendWatchNotification(
    campaign: CampaignDocument,
    company: CompanyDocument,
    verdict: AuditVerdict,
  ): Promise<void> {
    const slackWebhook = company.delivery?.slackWebhook;
    if (!slackWebhook) return;

    await this.slackService.sendMessage(
      slackWebhook,
      company.tenantId,
      `👀 *Campaign Watch Signal*\n\n*Campaign:* ${campaign.name || campaign.metaCampaignId}\n\n${verdict.contextInsight}\n\n*Signals to monitor:*\n${verdict.watchSignals.map(s => `  • ${s}`).join('\n')}`,
    );
  }

  private async pauseCampaign(
    campaign: CampaignDocument,
    company: CompanyDocument,
    reason: string,
  ): Promise<void> {
    await this.campaignsService.pause(company.tenantId, campaign._id.toString(), reason);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'campaign_paused',
      reason,
      outcome: `Campaign ${campaign.metaCampaignId} paused (safety rail)`,
      metadata: { metaCampaignId: campaign.metaCampaignId },
    });

    const slackWebhook = company.delivery?.slackWebhook;
    if (slackWebhook) {
      try {
        await this.slackService.sendMessage(
          slackWebhook,
          company.tenantId,
          `🛑 *Campaign Auto-Paused (Safety Rail)*\n\n*Campaign:* ${campaign.name || campaign.metaCampaignId}\n*Reason:* ${reason}`,
        );
      } catch (slackErr: any) {
        this.logger.error(`Slack pause notification failed — campaign still paused: ${slackErr.message}`);
      }
    }

    this.campaignLearning
      .runRootCauseAnalysis(company.tenantId, campaign._id.toString())
      .catch(err => this.logger.error(`Root cause analysis failed: ${err.message}`));
  }

  private async writePerformanceBack(
    campaign: CampaignDocument,
    full: FullCampaignMetrics,
    ageDays: number,
  ): Promise<boolean> {
    const brief = await this.briefModel.findOne({ tenantId: campaign.tenantId, briefId: campaign.briefId }).lean().exec();
    if (!brief) return false;

    // Campaign-level metrics (legacy — kept for back-compat with existing readers)
    const perf = {
      roas: full.campaign.roas,
      ctr: full.campaign.ctr,
      cpc: full.campaign.cpc,
      conversions: full.campaign.conversions,
    };

    // Per-hookStyle breakdown — legacy aggregation across ad sets. Mixed ad
    // sets (cold + retargeting) blend wins and losses under one hookStyle —
    // see adSetPerformance below for the disambiguated breakdown.
    const hookPerformance: Record<string, { spend: number; conversions: number; clicks: number; impressions: number; ctr: number; conversionRate: number }> = {};
    for (const adSet of (campaign as any).adSets ?? []) {
      for (const ad of adSet.ads ?? []) {
        const hook = ad.hookStyle || 'unknown';
        const metrics = ad.metrics;
        if (!metrics) continue;
        if (!hookPerformance[hook]) {
          hookPerformance[hook] = { spend: 0, conversions: 0, clicks: 0, impressions: 0, ctr: 0, conversionRate: 0 };
        }
        hookPerformance[hook].spend += metrics.spend ?? 0;
        hookPerformance[hook].conversions += metrics.conversions ?? 0;
        hookPerformance[hook].clicks += metrics.clicks ?? 0;
        hookPerformance[hook].impressions += metrics.impressions ?? 0;
      }
    }
    for (const hook of Object.keys(hookPerformance)) {
      const h = hookPerformance[hook];
      h.ctr = h.impressions > 0 ? (h.clicks / h.impressions) * 100 : 0;
      h.conversionRate = h.clicks > 0 ? (h.conversions / h.clicks) * 100 : 0;
    }

    // Per-ad-set breakdown — the unit of analysis that actually disentangles
    // hookStyle × audienceType × format. Replaces the misleading blended ROAS
    // that previously got written to brief.day*Performance. Causal layer
    // (campaign-learning.runDeepRun) should read this instead of the blended
    // perf when constructing matched pairs.
    const capturedAtDay: 7 | 14 | 30 = ageDays >= 30 ? 30 : ageDays >= 14 ? 14 : 7;
    const adSetPerformance: NonNullable<typeof brief.adSetPerformance> = [];
    for (const adSet of (campaign as any).adSets ?? []) {
      const m = adSet.metrics;
      if (!m) continue;
      const hookStyles = Array.from(new Set((adSet.ads ?? []).map((a: any) => a.hookStyle).filter(Boolean))) as string[];
      const formats = Array.from(new Set((adSet.ads ?? []).map((a: any) => a.format).filter(Boolean))) as string[];
      adSetPerformance.push({
        adSetId: adSet.metaAdSetId,
        name: adSet.name,
        audienceType: adSet.audienceType,
        hookStyles,
        formats,
        spend: m.spend ?? 0,
        impressions: m.impressions ?? 0,
        clicks: m.clicks ?? 0,
        conversions: m.conversions ?? 0,
        ctr: m.ctr ?? 0,
        cpa: m.cpa ?? 0,
        roas: m.roas ?? 0,
        capturedAt: new Date(),
        capturedAtDay,
      });
    }

    let written = false;

    // Order matters here: do the slow learning trigger BEFORE flipping the
    // performanceWritten flag. Was: flag flipped → quickScan fired → process
    // dies → flag persisted → scan never re-runs (gated by !performanceWritten).
    // Brief silently never contributed to learnings forever. Now: scan runs
    // first; only mark written after scan promise resolves (or rejects — at
    // worst we re-run a scan, which is idempotent on the company.learnings side
    // after L1.1 dot-path writes).
    if (ageDays >= 7 && !brief.performanceWritten?.day7) {
      try {
        await this.creativeLearning.runQuickScan(campaign.tenantId);
      } catch (err: any) {
        this.logger.error(`Quick scan failed (day7) — flag NOT flipped, will retry next audit: ${err.message}`);
        // Don't flip the flag. Don't return — still write metrics so dashboard sees them.
      }
      await this.briefModel.updateOne(
        { tenantId: campaign.tenantId, briefId: campaign.briefId },
        { day7Performance: perf, hookPerformance, adSetPerformance, 'performanceWritten.day7': true },
      );
      written = true;
    }
    if (ageDays >= 14 && !brief.performanceWritten?.day14) {
      await this.briefModel.updateOne(
        { tenantId: campaign.tenantId, briefId: campaign.briefId },
        { day14Performance: perf, hookPerformance, adSetPerformance, 'performanceWritten.day14': true },
      );
      written = true;
    }
    if (ageDays >= 30 && !brief.performanceWritten?.day30) {
      try {
        await this.campaignLearning.runDeepRun(campaign.tenantId);
      } catch (err: any) {
        this.logger.error(`Deep run failed (day30) — flag NOT flipped, will retry next audit: ${err.message}`);
      }
      await this.briefModel.updateOne(
        { tenantId: campaign.tenantId, briefId: campaign.briefId },
        { day30Performance: perf, hookPerformance, adSetPerformance, 'performanceWritten.day30': true },
      );
      written = true;
    }

    return written;
  }

  /**
   * Pick a replacement hookStyle for a fatigued ad.
   * Strategy: exclude the fatigued hook + all hooks already used in this campaign,
   * then pick the best from company learnings. Falls back to a default rotation.
   */
  /**
   * Map a target ad set's audienceType to a CreativeBrief audienceStage. Retarget,
   * custom, and lookalike audiences get 'warm' so regenerated copy is offer-recall-
   * shaped instead of cold-prospect-shaped (which feels weird to someone who already
   * engaged or was modeled on a buyer).
   *
   * Lookalike note: a 1-3% LAL of recent-purchaser source IS functionally warm —
   * the source signal is high-intent. Treating LAL as cold (the previous behavior)
   * meant scaled prospecting always got "Kya aap bhi…" cold hooks even when the
   * audience was modeled on past customers.
   */
  private deriveAudienceStageFromAdSet(
    campaign: any,
    adSetId: string,
  ): 'cold' | 'warm' | 'hot' {
    if (!adSetId) return 'cold';
    const adSet = (campaign?.adSets ?? []).find((as: any) => as.metaAdSetId === adSetId);
    const audienceType = adSet?.audienceType ?? 'unknown';
    if (audienceType === 'retarget' || audienceType === 'custom' || audienceType === 'lookalike') {
      return 'warm';
    }
    return 'cold';
  }

  private pickReplacementHook(
    campaign: CampaignDocument,
    fatiguedAdId: string,
    company: CompanyDocument,
  ): string {
    // Canonical 7-style set — same source of truth used by creative-team and copy-writer.
    // Pre-fix this had 'curiosity' (should be 'curiosity_gap'), 'benefit_led' (off-taxonomy),
    // missing 'before_after' and 'bold_claim' entirely. Drift here meant the auditor would
    // request hooks the generator's enum didn't list → silent fuzzy-match drift in shipped ads.
    const DEFAULT_HOOKS: string[] = [...HOOK_STYLES_DR];

    // Collect all hookStyles already in use on this campaign
    const usedHooks = new Set<string>();
    let fatiguedHook = '';
    for (const adSet of (campaign as any).adSets ?? []) {
      for (const ad of adSet.ads ?? []) {
        if (ad.hookStyle) usedHooks.add(ad.hookStyle);
        if (ad.metaAdId === fatiguedAdId) fatiguedHook = ad.hookStyle ?? '';
      }
    }

    // Winning hooks from learnings, ordered by past performance
    const winningHooks: string[] = company.learnings?.creative?.winningHooks ?? [];

    // First: try winning hooks that aren't already used in this campaign
    const fromLearnings = winningHooks.find(h => h !== fatiguedHook && !usedHooks.has(h));
    if (fromLearnings) return fromLearnings;

    // Second: try any winning hook that isn't the fatigued one (allow reuse across ad sets)
    const anyWinning = winningHooks.find(h => h !== fatiguedHook);
    if (anyWinning) return anyWinning;

    // Third: fallback to default rotation, excluding fatigued hook
    const fallback = DEFAULT_HOOKS.find(h => h !== fatiguedHook && !usedHooks.has(h));
    return fallback ?? DEFAULT_HOOKS.find(h => h !== fatiguedHook) ?? 'benefit_led';
  }
}
