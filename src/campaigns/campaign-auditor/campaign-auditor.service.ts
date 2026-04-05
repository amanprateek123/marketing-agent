import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompaniesService } from '../../companies/companies.service';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CampaignOptimizerService, CampaignMetrics } from './campaign-optimizer.service';
import { MetaMetricsService, FullCampaignMetrics } from '../meta-ads/meta-metrics.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { SlackService } from '../../delivery/slack.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';
import { CreativeLearningService } from '../../learning/creative-learning.service';
import { CampaignLearningService } from '../../learning/campaign-learning.service';

export interface AuditResult {
  tenantId: string;
  campaignsAudited: number;
  paused: number;
  scaled: number;
  performanceWritten: number;
}

@Injectable()
export class CampaignAuditorService {
  private readonly logger = new Logger(CampaignAuditorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly campaignsService: CampaignsService,
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
  ) {}

  async audit(tenantId: string): Promise<AuditResult> {
    const company = await this.companiesService.findByTenantId(tenantId);
    const activeCampaigns = await this.campaignsService.findActive(tenantId);

    this.logger.log(
      `Auditing ${activeCampaigns.length} active campaign(s) for tenantId=${tenantId}`,
    );

    const result: AuditResult = {
      tenantId,
      campaignsAudited: activeCampaigns.length,
      paused: 0,
      scaled: 0,
      performanceWritten: 0,
    };

    for (const campaign of activeCampaigns) {
      try {
        // Fetch live metrics from Meta Ads via Claude MCP
        const metrics = await this.fetchMetrics(campaign, company);

        // Update metrics in MongoDB
        await this.campaignsService.updateMetrics(campaign._id.toString(), {
          spend: metrics.spend,
          impressions: metrics.impressions,
          clicks: metrics.clicks,
          conversions: metrics.conversions,
          roas: metrics.roas,
          ctr: metrics.ctr,
          cpc: metrics.cpc,
        });

        const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        const ageDays = ageHours / 24;

        // ── Auto-pause checks (TypeScript — Claude cannot override) ──────────
        let paused = false;

        if (company.pauseIfCTRBelow && metrics.ctr < company.pauseIfCTRBelow && ageHours > 72) {
          await this.pauseCampaign(
            campaign,
            company,
            `CTR ${metrics.ctr.toFixed(2)}% below threshold ${company.pauseIfCTRBelow}% after 72h`,
          );
          paused = true;
        } else if (company.pauseIfFrequencyAbove && metrics.frequency > company.pauseIfFrequencyAbove) {
          await this.pauseCampaign(
            campaign,
            company,
            `Frequency ${metrics.frequency.toFixed(1)} exceeds ${company.pauseIfFrequencyAbove} — audience fatigued`,
          );
          paused = true;
        } else if (company.pauseIfROASBelow && metrics.roas < company.pauseIfROASBelow && ageDays > 5) {
          await this.pauseCampaign(
            campaign,
            company,
            `ROAS ${metrics.roas.toFixed(2)}x below ${company.pauseIfROASBelow}x after 5 days`,
          );
          paused = true;
        } else if (
          company.pauseAfterDaysInLearning &&
          ageDays > company.pauseAfterDaysInLearning &&
          metrics.conversions === 0
        ) {
          await this.pauseCampaign(
            campaign,
            company,
            `Stuck in learning phase for ${Math.round(ageDays)} days with 0 conversions`,
          );
          paused = true;
        }

        if (paused) {
          result.paused++;
          continue;
        }

        // ── Auto-scale check ─────────────────────────────────────────────────
        if (company.scaleIfROASAbove && metrics.roas > company.scaleIfROASAbove) {
          await this.optimizer.scaleBudget(campaign, company, metrics);
          result.scaled++;
        }

        // ── Performance writeback at day 7/14/30 ─────────────────────────────
        const written = await this.writePerformanceBack(campaign, metrics, ageDays);
        if (written) result.performanceWritten++;

      } catch (err: any) {
        this.logger.error(
          `Audit failed for campaign ${campaign.metaCampaignId}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Audit complete: tenantId=${tenantId} audited=${result.campaignsAudited} paused=${result.paused} scaled=${result.scaled} written=${result.performanceWritten}`,
    );

    return result;
  }

  /**
   * Fetch metrics directly from Meta Graph API (no Claude needed).
   * Also runs ad-level analysis: fatigue detection, per-ad-set optimization.
   */
  private async fetchMetrics(
    campaign: CampaignDocument,
    company: CompanyDocument,
  ): Promise<CampaignMetrics> {
    if (!company.meta?.accessToken || !campaign.metaCampaignId) {
      this.logger.warn(`Cannot fetch metrics: missing Meta credentials or campaign ID`);
      return { spend: 0, impressions: 0, clicks: 0, conversions: 0, roas: 0, ctr: 0, cpc: 0, frequency: 0 };
    }

    // Find product for conversion value
    const product = (company.products ?? []).find(p => p.active);
    const conversionValue = product?.conversionValue ?? product?.price ?? 0;

    // Fetch full metrics hierarchy: campaign → ad sets → ads
    const full = await this.metaMetrics.fetchFullMetrics(
      campaign.metaCampaignId,
      company.meta.accessToken,
      conversionValue,
    );

    // Save per-ad-set and per-ad metrics to MongoDB
    await this.saveAdLevelMetrics(campaign, full, company);

    // Run ad-level optimizations
    await this.runAdLevelAudit(campaign, full, company);

    // Execute any expired pending actions
    await this.executePendingActions(campaign, company);

    return {
      spend: full.campaign.spend,
      impressions: full.campaign.impressions,
      clicks: full.campaign.clicks,
      conversions: full.campaign.conversions,
      roas: full.campaign.roas,
      ctr: full.campaign.ctr,
      cpc: full.campaign.cpc,
      frequency: full.campaign.frequency,
    };
  }

  /**
   * Save per-ad-set and per-ad metrics to the campaign document.
   */
  private async saveAdLevelMetrics(
    campaign: CampaignDocument,
    full: FullCampaignMetrics,
    company: CompanyDocument,
  ): Promise<void> {
    const adSets = (campaign as any).adSets ?? [];
    if (adSets.length === 0) return;

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
        const metaAd = metaAdSet.ads.find(a => a.adId === ad.metaAdId);
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
        const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        if (!ad.ctrBaseline && ageHours >= 48 && metaAd.ctr > 0) {
          ad.ctrBaseline = metaAd.ctr;
          ad.baselineSetAt = new Date();
        }
      }
    }

    await this.campaignModel.updateOne(
      { _id: campaign._id },
      { adSets, lastAuditedAt: new Date() },
    );
  }

  /**
   * Run ad-level optimizations: fatigue detection, zero-conversion ads, winning ad sets.
   */
  private async runAdLevelAudit(
    campaign: CampaignDocument,
    full: FullCampaignMetrics,
    company: CompanyDocument,
  ): Promise<void> {
    const gracePeriodHours = company.pipelineConfig?.pauseGracePeriodHours ?? 12;
    const scaleRequiresApproval = company.pipelineConfig?.scaleRequiresApproval ?? true;
    const adSets = (campaign as any).adSets ?? [];

    for (const adSet of adSets) {
      if (adSet.status !== 'active') continue;
      const metaAdSet = full.adSets.find(a => a.adSetId === adSet.metaAdSetId);
      if (!metaAdSet) continue;

      for (const ad of adSet.ads) {
        if (ad.status !== 'active') continue;
        const metaAd = metaAdSet.ads.find(a => a.adId === ad.metaAdId);
        if (!metaAd) continue;

        // Creative fatigue: CTR dropped >40% from baseline
        if (ad.ctrBaseline && ad.ctrBaseline > 0 && metaAd.ctr > 0) {
          const dropPercent = ((ad.ctrBaseline - metaAd.ctr) / ad.ctrBaseline) * 100;
          if (dropPercent > 40) {
            await this.createPendingAction(campaign, company, {
              type: 'pause_ad',
              targetId: ad.metaAdId,
              targetName: `${adSet.name} — Variant ${ad.copyVariantIndex + 1} (${ad.hookStyle})`,
              reason: `Creative fatigue: CTR dropped ${dropPercent.toFixed(0)}% from baseline (${ad.ctrBaseline.toFixed(2)}% → ${metaAd.ctr.toFixed(2)}%)`,
              metrics: { ctrBaseline: ad.ctrBaseline, currentCtr: metaAd.ctr, dropPercent },
              gracePeriodHours,
            });
          }
        }

        // Zero conversions after significant spend
        if (metaAd.conversions === 0 && metaAd.spend > 1500) {
          await this.createPendingAction(campaign, company, {
            type: 'pause_ad',
            targetId: ad.metaAdId,
            targetName: `${adSet.name} — Variant ${ad.copyVariantIndex + 1} (${ad.hookStyle})`,
            reason: `Zero conversions after ₹${metaAd.spend.toFixed(0)} spend`,
            metrics: { spend: metaAd.spend, conversions: 0, ctr: metaAd.ctr },
            gracePeriodHours,
          });
        }
      }

      // Ad set level: high ROAS → recommend scale
      if (metaAdSet.conversions >= 3 && metaAdSet.cpa > 0) {
        const product = (company.products ?? []).find(p => p.active);
        const conversionValue = product?.conversionValue ?? product?.price ?? 0;
        const roas = conversionValue > 0 ? (metaAdSet.conversions * conversionValue) / metaAdSet.spend : 0;

        if (roas > (company.scaleIfROASAbove ?? 2)) {
          const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
          if (ageMs > 48 * 60 * 60 * 1000) { // only after 48h
            await this.createPendingAction(campaign, company, {
              type: 'scale_adset',
              targetId: adSet.metaAdSetId,
              targetName: adSet.name,
              reason: `ROAS ${roas.toFixed(1)}x after 48h+ with ${metaAdSet.conversions} conversions. Recommend +20% budget.`,
              metrics: { roas, conversions: metaAdSet.conversions, cpa: metaAdSet.cpa, spend: metaAdSet.spend },
              gracePeriodHours: scaleRequiresApproval ? 999999 : gracePeriodHours, // never auto-execute if approval required
            });
          }
        }
      }
    }
  }

  /**
   * Create a pending action with grace period. Sends Slack notification.
   */
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
  ): Promise<void> {
    const pendingActions = (campaign as any).pendingActions ?? [];

    // Don't duplicate — check if action already exists for this target
    const existing = pendingActions.find(
      (a: any) => a.targetId === action.targetId && a.type === action.type && a.status === 'pending',
    );
    if (existing) return;

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

    await this.campaignModel.updateOne(
      { _id: campaign._id },
      { pendingActions },
    );

    // Slack notification
    const slackWebhook = company.delivery?.slackWebhook;
    if (slackWebhook) {
      const icon = action.type.includes('pause') ? '⚠️' : '📈';
      const autoMsg = action.gracePeriodHours < 999999
        ? `\nWill auto-execute in ${action.gracePeriodHours}h unless overridden.`
        : '\nRequires manual approval.';

      await this.slackService.sendMessage(
        slackWebhook,
        company.tenantId,
        `${icon} *Audit Recommendation*\n\n*Action:* ${action.type.replace('_', ' ')}\n*Target:* ${action.targetName}\n*Reason:* ${action.reason}\n*Metrics:* ${JSON.stringify(action.metrics)}${autoMsg}\n\nApprove: \`POST /api/v1/campaigns/${company.tenantId}/${(campaign as any)._id}/actions/${actionId}/approve\`\nOverride: \`POST /api/v1/campaigns/${company.tenantId}/${(campaign as any)._id}/actions/${actionId}/override\``,
      );
    }

    this.logger.log(
      `Pending action created: ${action.type} on ${action.targetName} | grace: ${action.gracePeriodHours}h | reason: ${action.reason}`,
    );
  }

  /**
   * Execute pending actions whose grace period has expired.
   */
  private async executePendingActions(
    campaign: CampaignDocument,
    company: CompanyDocument,
  ): Promise<void> {
    const pendingActions = (campaign as any).pendingActions ?? [];
    const now = new Date();
    let updated = false;

    for (const action of pendingActions) {
      if (action.status !== 'pending') continue;
      if (new Date(action.executeAt) > now) continue;

      try {
        if (action.type === 'pause_ad') {
          await this.metaAds.pauseAd(action.targetId, company.meta!.accessToken);
          // Update ad status in campaign document
          for (const adSet of (campaign as any).adSets ?? []) {
            const ad = adSet.ads.find((a: any) => a.metaAdId === action.targetId);
            if (ad) ad.status = 'paused';
          }
        } else if (action.type === 'pause_adset') {
          await this.metaAds.pauseAdSet(action.targetId, company.meta!.accessToken);
          const adSet = ((campaign as any).adSets ?? []).find((a: any) => a.metaAdSetId === action.targetId);
          if (adSet) adSet.status = 'paused';
        } else if (action.type === 'scale_adset') {
          // Scale requires approval — should never auto-execute
          continue;
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
      outcome: `Campaign ${campaign.metaCampaignId} paused`,
      metadata: { metaCampaignId: campaign.metaCampaignId, briefId: campaign.briefId },
    });

    this.logger.log(
      `Campaign paused: tenantId=${company.tenantId} metaCampaignId=${campaign.metaCampaignId} reason="${reason}"`,
    );

    // Trigger root cause analysis async — do not await (non-blocking)
    this.campaignLearning
      .runRootCauseAnalysis(company.tenantId, campaign._id.toString())
      .catch((err) => this.logger.error(`Root cause analysis failed: ${err.message}`));
  }

  private async writePerformanceBack(
    campaign: CampaignDocument,
    metrics: CampaignMetrics,
    ageDays: number,
  ): Promise<boolean> {
    const perf = {
      roas: metrics.roas,
      ctr: metrics.ctr,
      cpc: metrics.cpc,
      conversions: metrics.conversions,
    };

    // Load the brief to check what's already been written
    const brief = await this.briefModel.findOne({ briefId: campaign.briefId }).lean().exec();
    if (!brief) return false;

    let written = false;

    if (ageDays >= 7 && !brief.performanceWritten?.day7) {
      await this.briefModel.updateOne(
        { briefId: campaign.briefId },
        { day7Performance: perf, 'performanceWritten.day7': true },
      );
      written = true;
      this.logger.log(`Day 7 performance written for briefId=${campaign.briefId}`);

      // Trigger creative quick scan after Day 7 — async, non-blocking
      this.creativeLearning
        .runQuickScan(campaign.tenantId)
        .catch((err) => this.logger.error(`Creative quick scan failed: ${err.message}`));
    }

    if (ageDays >= 14 && !brief.performanceWritten?.day14) {
      await this.briefModel.updateOne(
        { briefId: campaign.briefId },
        { day14Performance: perf, 'performanceWritten.day14': true },
      );
      written = true;
      this.logger.log(`Day 14 performance written for briefId=${campaign.briefId}`);
    }

    if (ageDays >= 30 && !brief.performanceWritten?.day30) {
      await this.briefModel.updateOne(
        { briefId: campaign.briefId },
        { day30Performance: perf, 'performanceWritten.day30': true },
      );
      written = true;
      this.logger.log(`Day 30 performance written for briefId=${campaign.briefId}`);

      // Trigger campaign deep run after Day 30 — async, non-blocking
      this.campaignLearning
        .runDeepRun(campaign.tenantId)
        .catch((err) => this.logger.error(`Campaign deep run failed: ${err.message}`));
    }

    return written;
  }
}
