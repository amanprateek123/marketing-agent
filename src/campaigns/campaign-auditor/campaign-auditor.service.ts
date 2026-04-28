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
import { SlackService } from '../../delivery/slack.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';
import { CreativeLearningService } from '../../learning/creative-learning.service';
import { CampaignLearningService } from '../../learning/campaign-learning.service';
import { ShadowActionService } from '../../learning/shadow-action.service';
import { CampaignOptimizerService } from './campaign-optimizer.service';
import { QUEUES } from '../../scheduler/queue.constants';

export interface AuditResult {
  tenantId: string;
  campaignsAudited: number;
  paused: number;
  actionsCreated: number;
  performanceWritten: number;
}

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

    const full = await this.metaMetrics.fetchFullMetrics(
      campaign.metaCampaignId,
      company.meta.accessToken,
      conversionValue,
      conversionEvent,
    );

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

    const signals = this.signalDetector.detect(campaign, full, snapshots, company, weeklySpend, marketEnvironment);

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
      !signals.safetyBreaches.weeklyCapExceeded &&
      !signals.safetyBreaches.campaignCapExceeded &&
      signals.trends.ctrTrend !== 'declining' &&
      signals.trends.roasTrend !== 'declining' &&
      !hasOpportunities;

    // Cooldown: if last Claude verdict was watch/no_action and < 6h ago, skip unless signals changed materially
    const lastSnapshot = snapshots[0];
    const lastVerdict = lastSnapshot?.verdict?.verdict;
    const lastAuditAge = lastSnapshot ? (Date.now() - new Date(lastSnapshot.auditedAt).getTime()) / (1000 * 60 * 60) : Infinity;
    const lastConversions = lastSnapshot?.metrics?.conversions ?? 0;
    const conversionsChanged = full.campaign.conversions !== lastConversions;
    const hadSafetyBreach = signals.safetyBreaches.weeklyCapExceeded || signals.safetyBreaches.campaignCapExceeded;

    if (!isAllGreen && !conversionsChanged && !hadSafetyBreach &&
        (lastVerdict === 'watch' || lastVerdict === 'no_action') && lastAuditAge < 6) {
      const age = signals.campaignAge;
      const conv = full.campaign.conversions;
      const cooldownVerdict = {
        verdict: 'no_action' as const,
        urgency: null,
        contextInsight: `Day ${age.days.toFixed(0)} | ₹${full.campaign.spend.toFixed(0)} spent | ${conv} conversions | Cooldown — last verdict "${lastVerdict}" ${lastAuditAge.toFixed(1)}h ago, no material change`,
        watchSignals: lastSnapshot?.verdict?.watchSignals ?? [] as string[],
        recommendedActions: [] as any[],
      };
      snapshotData.verdict = cooldownVerdict as any;
      await this.snapshotModel.create(snapshotData);
      this.logger.debug(`Cooldown skip for campaign ${campaign.metaCampaignId} — last verdict ${lastAuditAge.toFixed(1)}h ago`);

      if (campaign.launchedAt) {
        const ageMs = Date.now() - new Date(campaign.launchedAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const written = await this.writePerformanceBack(campaign, full, ageDays);
        if (written) result.performanceWritten++;
      }
      return;
    }

    if (isAllGreen) {
      const age = signals.campaignAge;
      const conv = full.campaign.conversions;
      const skipVerdict = {
        verdict: 'no_action' as const,
        urgency: null,
        contextInsight: `Day ${age.days.toFixed(0)} | ₹${full.campaign.spend.toFixed(0)} spent | ${conv} conversions | CTR ${full.campaign.ctr.toFixed(2)}% | No anomalies — agent skipped`,
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

        if (ageDays < 3) {
          // Day 0-3: only allow pauses if safety-related (overspending, frequency breach)
          if (isPause && action.priority === 'high') {
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
        | 'dayparting';
      targetId: string;
      targetName: string;
      reason: string;
      metrics: Record<string, any>;
      gracePeriodHours: number;
    },
  ): Promise<boolean> {
    const pendingActions = (campaign as any).pendingActions ?? [];

    // Deduplicate: skip if same action already exists (pending OR executed)
    const existing = pendingActions.find(
      (a: any) => a.targetId === action.targetId && a.type === action.type &&
        (a.status === 'pending' || a.status === 'executed'),
    );
    if (existing) return false;

    const actionId = uuidv4();
    const now = new Date();
    const executeAt = new Date(now.getTime() + action.gracePeriodHours * 60 * 60 * 1000);

    pendingActions.push({
      actionId,
      type: action.type,
      targetId: action.targetId,
      targetName: action.targetName,
      reason: action.reason,
      metrics: action.metrics,
      recommendedAt: now,
      executeAt,
      status: 'pending',
    });

    await this.campaignModel.updateOne({ _id: campaign._id }, { pendingActions });
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
          await this.creativeQueue.add(
            `replace-creative-${action.targetId}`,
            {
              tenantId: company.tenantId,
              campaignId: campaign._id.toString(),
              briefId: campaign.briefId,
              fatiguedAdId: action.targetId,
              fatiguedHook: action.metrics?.fatiguedHook ?? '',
              replacementHook,
              adSetId: (campaign as any).adSets
                ?.find((as: any) => as.ads?.some((a: any) => a.metaAdId === action.targetId))
                ?.metaAdSetId ?? '',
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

          // Create new ad set via Meta API
          const newAdSetId = await this.metaAds.createAdSetInCampaign(
            campaign.metaCampaignId,
            company.meta!.accessToken,
            {
              name: adSetName,
              budgetPercent: newAdSetPercent,
              audienceType,
              optimizationGoal: 'OFFSITE_CONVERSIONS',
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
            try {
              const { adId } = await this.metaAds.createAdInAdSet(
                newAdSetId,
                company.meta!.accessToken,
                `${adSetName} — Variant ${bestVariantIndex + 1}`,
                { primaryText: bestVariant.primaryText, headline: bestVariant.headline, cta: bestVariant.cta },
                bestImage.imageUrl,
                company.meta!.pageId ?? '',
                product?.landingUrl ?? '',
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

    // Campaign-level metrics
    const perf = {
      roas: full.campaign.roas,
      ctr: full.campaign.ctr,
      cpc: full.campaign.cpc,
      conversions: full.campaign.conversions,
    };

    // Per-hookStyle breakdown from ad-level metrics
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
    // Calculate blended CTR and conversion rate per hook
    for (const hook of Object.keys(hookPerformance)) {
      const h = hookPerformance[hook];
      h.ctr = h.impressions > 0 ? (h.clicks / h.impressions) * 100 : 0;
      h.conversionRate = h.clicks > 0 ? (h.conversions / h.clicks) * 100 : 0;
    }

    let written = false;

    if (ageDays >= 7 && !brief.performanceWritten?.day7) {
      await this.briefModel.updateOne(
        { tenantId: campaign.tenantId, briefId: campaign.briefId },
        { day7Performance: perf, hookPerformance, 'performanceWritten.day7': true },
      );
      written = true;
      this.creativeLearning.runQuickScan(campaign.tenantId).catch(err => this.logger.error(`Quick scan failed: ${err.message}`));
    }
    if (ageDays >= 14 && !brief.performanceWritten?.day14) {
      await this.briefModel.updateOne(
        { tenantId: campaign.tenantId, briefId: campaign.briefId },
        { day14Performance: perf, hookPerformance, 'performanceWritten.day14': true },
      );
      written = true;
    }
    if (ageDays >= 30 && !brief.performanceWritten?.day30) {
      await this.briefModel.updateOne(
        { tenantId: campaign.tenantId, briefId: campaign.briefId },
        { day30Performance: perf, hookPerformance, 'performanceWritten.day30': true },
      );
      written = true;
      this.campaignLearning.runDeepRun(campaign.tenantId).catch(err => this.logger.error(`Deep run failed: ${err.message}`));
    }

    return written;
  }

  /**
   * Pick a replacement hookStyle for a fatigued ad.
   * Strategy: exclude the fatigued hook + all hooks already used in this campaign,
   * then pick the best from company learnings. Falls back to a default rotation.
   */
  private pickReplacementHook(
    campaign: CampaignDocument,
    fatiguedAdId: string,
    company: CompanyDocument,
  ): string {
    const DEFAULT_HOOKS = ['pain_point', 'social_proof', 'price_shock', 'curiosity', 'urgency', 'benefit_led'];

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
