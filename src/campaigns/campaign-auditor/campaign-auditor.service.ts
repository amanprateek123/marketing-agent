import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AgentType } from '../../claude/claude.types';
import { CompaniesService } from '../../companies/companies.service';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { AuditSnapshot, AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';
import { SignalDetectorService } from './signal-detector.service';
import { AuditAgentService, AuditVerdict } from './audit-agent.service';
import { MetaMetricsService, FullCampaignMetrics } from '../meta-ads/meta-metrics.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { SlackService } from '../../delivery/slack.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';
import { CreativeLearningService } from '../../learning/creative-learning.service';
import { CampaignLearningService } from '../../learning/campaign-learning.service';
import { CampaignOptimizerService } from './campaign-optimizer.service';

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
    private readonly metaMetrics: MetaMetricsService,
    private readonly metaAds: MetaAdsService,
    private readonly slackService: SlackService,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(AuditSnapshot.name)
    private readonly snapshotModel: Model<AuditSnapshotDocument>,
  ) {}

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

    for (const campaign of activeCampaigns) {
      try {
        await this.auditCampaign(campaign, company, result);
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
  ): Promise<void> {
    if (!company.meta?.accessToken || !campaign.metaCampaignId) {
      this.logger.warn(`Skipping campaign ${campaign._id}: no Meta credentials or campaignId`);
      return;
    }

    // ── Fetch live metrics from Meta ──────────────────────────────────────────
    const product = (company.products ?? []).find(p => p.active);
    const conversionValue = product?.conversionValue ?? product?.price ?? 0;

    const full = await this.metaMetrics.fetchFullMetrics(
      campaign.metaCampaignId,
      company.meta.accessToken,
      conversionValue,
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

    // Execute any expired pending actions
    await this.executePendingActions(campaign, company);

    // ── Layer 1: Safety rails (TypeScript — cannot be overridden) ─────────────
    const safetyPaused = await this.runSafetyRails(campaign, full, company);
    if (safetyPaused) {
      result.paused++;
      return;
    }

    // ── Layer 2: Signal detection ─────────────────────────────────────────────
    const snapshots = await this.snapshotModel
      .find({ tenantId: company.tenantId, campaignId: campaign._id.toString() })
      .sort({ auditedAt: -1 })
      .limit(10)
      .lean()
      .exec() as AuditSnapshotDocument[];

    const signals = this.signalDetector.detect(campaign, full, snapshots, company);

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
        as.ads.map(ad => ({
          metaAdId: ad.adId,
          name: ad.adId,
          hookStyle: '',
          copyVariantIndex: 0,
          adSetId: as.adSetId,
          spend: ad.spend,
          conversions: ad.conversions,
          ctr: ad.ctr,
          cpc: ad.cpc,
        })),
      ),
      verdict: null,
    };

    // ── Layer 3: Intelligent audit agent ──────────────────────────────────────
    const freshCampaign = await this.campaignModel.findOne({ _id: campaign._id }).lean().exec();
    const verdict = await this.auditAgent.analyze(freshCampaign ?? campaign, signals, snapshots, company);

    // Save verdict to snapshot
    snapshotData.verdict = verdict as any;
    await this.snapshotModel.create(snapshotData);

    // ── Layer 4: Human-in-the-loop actions based on verdict ───────────────────
    if (verdict.verdict === 'act') {
      const gracePeriodHours = company.pipelineConfig?.pauseGracePeriodHours ?? 12;

      for (const action of verdict.recommendedActions) {
        const created = await this.createPendingAction(campaign, company, {
          type: action.type,
          targetId: action.targetId,
          targetName: action.targetName,
          reason: action.reason,
          metrics: {},
          gracePeriodHours: action.priority === 'high' ? gracePeriodHours : gracePeriodHours * 2,
        });
        if (created) result.actionsCreated++;
      }

      // Send Slack digest for "act" verdict
      await this.sendAuditDigest(campaign, company, verdict, signals);
    } else if (verdict.verdict === 'watch') {
      // Only notify Slack if there are specific watch signals
      if (verdict.watchSignals.length > 0) {
        await this.sendWatchNotification(campaign, company, verdict);
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
    const weeklySpend = await this.campaignsService.getWeeklySpend(company.tenantId);
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
      type: 'pause_ad' | 'pause_adset' | 'scale_adset' | 'replace_creative';
      targetId: string;
      targetName: string;
      reason: string;
      metrics: Record<string, number>;
      gracePeriodHours: number;
    },
  ): Promise<boolean> {
    const pendingActions = (campaign as any).pendingActions ?? [];

    const existing = pendingActions.find(
      (a: any) => a.targetId === action.targetId && a.type === action.type && a.status === 'pending',
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
        } else if (action.type === 'scale_adset') {
          continue; // scale always requires explicit approval
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
      ? verdict.recommendedActions.map(a =>
          `  • [${a.priority.toUpperCase()}] ${a.type.replace(/_/g, ' ')}: ${a.targetName}\n    _${a.reason}_`,
        ).join('\n')
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
      await this.slackService.sendMessage(
        slackWebhook,
        company.tenantId,
        `🛑 *Campaign Auto-Paused (Safety Rail)*\n\n*Campaign:* ${campaign.name || campaign.metaCampaignId}\n*Reason:* ${reason}`,
      );
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

    const perf = {
      roas: full.campaign.roas,
      ctr: full.campaign.ctr,
      cpc: full.campaign.cpc,
      conversions: full.campaign.conversions,
    };

    let written = false;

    if (ageDays >= 7 && !brief.performanceWritten?.day7) {
      await this.briefModel.updateOne({ briefId: campaign.briefId }, { day7Performance: perf, 'performanceWritten.day7': true });
      written = true;
      this.creativeLearning.runQuickScan(campaign.tenantId).catch(err => this.logger.error(`Quick scan failed: ${err.message}`));
    }
    if (ageDays >= 14 && !brief.performanceWritten?.day14) {
      await this.briefModel.updateOne({ briefId: campaign.briefId }, { day14Performance: perf, 'performanceWritten.day14': true });
      written = true;
    }
    if (ageDays >= 30 && !brief.performanceWritten?.day30) {
      await this.briefModel.updateOne({ briefId: campaign.briefId }, { day30Performance: perf, 'performanceWritten.day30': true });
      written = true;
      this.campaignLearning.runDeepRun(campaign.tenantId).catch(err => this.logger.error(`Deep run failed: ${err.message}`));
    }

    return written;
  }
}
