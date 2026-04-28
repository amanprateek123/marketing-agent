import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ShadowAction, ShadowActionDocument } from './schemas/shadow-action.schema';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { MetaMetricsService } from '../campaigns/meta-ads/meta-metrics.service';
import { CompaniesService } from '../companies/companies.service';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Records actions the LLM proposed but a TS guard blocked, then evaluates each
 * at +24h and +72h to label the block as correct (problem went away) or missed
 * (problem persisted, agent was right). After ~2 weeks of data, regret rates
 * per (action_type, blocked_reason) become the first quantitative answer to
 * "are our guardrails calibrated correctly?"
 *
 * NEVER changes behavior — pure observability. Decisions to relax/tighten a
 * guard happen in code review based on the data, not automatically.
 */
@Injectable()
export class ShadowActionService {
  private readonly logger = new Logger(ShadowActionService.name);

  constructor(
    @InjectModel(ShadowAction.name)
    private readonly shadowModel: Model<ShadowActionDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    private readonly metaMetrics: MetaMetricsService,
    private readonly companiesService: CompaniesService,
  ) {}

  /**
   * Persist a shadow record. Caller passes everything needed to evaluate later;
   * this method does not fail loudly — shadow logging is best-effort and must
   * never break the audit.
   */
  async recordBlocked(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
    proposedAction: ShadowAction['proposedAction'];
    blockedReason: ShadowAction['blockedReason'];
    metricsAtT: ShadowAction['metricsAtT'];
  }): Promise<void> {
    try {
      const now = new Date();
      await this.shadowModel.create({
        ...input,
        blockedAt: now,
        evaluateAt24h: new Date(now.getTime() + 24 * HOUR_MS),
        evaluateAt72h: new Date(now.getTime() + 72 * HOUR_MS),
        status: 'pending',
      });
      this.logger.debug(
        `Shadow action recorded: tenantId=${input.tenantId} campaign=${input.metaCampaignId} type=${input.proposedAction.type} reason=${input.blockedReason}`,
      );
    } catch (err: any) {
      // Never crash the audit on a logging failure.
      this.logger.warn(`Shadow action record failed: ${err.message}`);
    }
  }

  /**
   * Evaluate any shadow records due for 24h or 72h evaluation. Called by a
   * daily scheduled job. Joins each pending record to current campaign metrics
   * and assigns regretLabel when the 72h window has elapsed.
   */
  async evaluatePending(): Promise<{ evaluated24h: number; evaluated72h: number; finalized: number }> {
    const now = new Date();
    const result = { evaluated24h: 0, evaluated72h: 0, finalized: 0 };

    // 24h evaluations: status=pending, evaluateAt24h <= now
    const due24h = await this.shadowModel
      .find({ status: 'pending', evaluateAt24h: { $lte: now } })
      .limit(200)
      .lean()
      .exec();

    for (const shadow of due24h) {
      try {
        const metrics = await this.fetchCurrentMetrics(shadow);
        if (!metrics) continue;
        await this.shadowModel.updateOne(
          { _id: shadow._id },
          { metricsAtT24h: metrics, status: 'evaluated_24h' },
        );
        result.evaluated24h++;
      } catch (err: any) {
        this.logger.warn(`Shadow 24h eval failed for ${shadow._id}: ${err.message}`);
      }
    }

    // 72h evaluations: status=evaluated_24h, evaluateAt72h <= now
    const due72h = await this.shadowModel
      .find({ status: 'evaluated_24h', evaluateAt72h: { $lte: now } })
      .limit(200)
      .lean()
      .exec();

    for (const shadow of due72h) {
      try {
        const metrics = await this.fetchCurrentMetrics(shadow);
        if (!metrics) continue;
        const regretLabel = this.computeRegretLabel(shadow, metrics);
        await this.shadowModel.updateOne(
          { _id: shadow._id },
          {
            metricsAtT72h: metrics,
            regretLabel,
            evaluatedAt: now,
            status: 'final',
          },
        );
        result.evaluated72h++;
        result.finalized++;
      } catch (err: any) {
        this.logger.warn(`Shadow 72h eval failed for ${shadow._id}: ${err.message}`);
      }
    }

    if (result.evaluated24h + result.evaluated72h > 0) {
      this.logger.log(
        `Shadow evaluator: 24h=${result.evaluated24h} 72h=${result.evaluated72h} finalized=${result.finalized}`,
      );
    }
    return result;
  }

  /**
   * Aggregate regret stats. Used for review / reporting; not for runtime decisions.
   */
  async getRegretSummary(tenantId: string, sinceDaysAgo: number = 30): Promise<{
    total: number;
    byActionAndReason: Array<{
      actionType: string;
      blockedReason: string;
      total: number;
      correct: number;
      missed: number;
      inconclusive: number;
      regretRatePct: number;
    }>;
  }> {
    const since = new Date(Date.now() - sinceDaysAgo * 24 * HOUR_MS);
    const finalized = await this.shadowModel
      .find({ tenantId, status: 'final', blockedAt: { $gte: since } })
      .lean()
      .exec();

    const buckets = new Map<string, { actionType: string; blockedReason: string; total: number; correct: number; missed: number; inconclusive: number }>();
    for (const s of finalized) {
      const key = `${s.proposedAction.type}|${s.blockedReason}`;
      const b = buckets.get(key) ?? {
        actionType: s.proposedAction.type,
        blockedReason: s.blockedReason,
        total: 0, correct: 0, missed: 0, inconclusive: 0,
      };
      b.total++;
      if (s.regretLabel === 'correct_block') b.correct++;
      else if (s.regretLabel === 'missed_signal') b.missed++;
      else b.inconclusive++;
      buckets.set(key, b);
    }

    return {
      total: finalized.length,
      byActionAndReason: [...buckets.values()]
        .map(b => ({ ...b, regretRatePct: b.total > 0 ? (b.missed / b.total) * 100 : 0 }))
        .sort((a, b) => b.regretRatePct - a.regretRatePct),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────

  private async fetchCurrentMetrics(shadow: ShadowActionDocument | any): Promise<ShadowAction['metricsAtT'] | null> {
    try {
      const campaign = await this.campaignModel.findOne({ _id: shadow.campaignId }).lean().exec();
      if (!campaign) return null;
      const company = await this.companiesService.findByTenantId(shadow.tenantId);
      if (!company?.meta?.accessToken) return null;
      const product = (company.products ?? []).find((p: any) => p.active);
      const conversionValue = product?.conversionValue ?? product?.price ?? 0;
      const conversionEvent = product?.conversionEvent ?? 'Purchase';
      const full = await this.metaMetrics.fetchFullMetrics(
        shadow.metaCampaignId,
        company.meta.accessToken,
        conversionValue,
        conversionEvent,
      );
      const c = full.campaign;
      return {
        spend: c.spend, impressions: c.impressions, clicks: c.clicks, conversions: c.conversions,
        ctr: c.ctr, cpc: c.cpc, cpa: c.cpa, roas: c.roas, frequency: c.frequency,
      };
    } catch (err: any) {
      this.logger.warn(`Shadow fetchCurrentMetrics failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Compute the regret label by comparing the metric the proposed action was
   * meant to address against where it actually went without intervention.
   *
   * Rules of thumb (intentionally simple — refine as data accumulates):
   *   - pause_*           → if metricsAtT72h.cpa got worse (>20% vs T) AND conversions still 0 → missed_signal (we should have paused)
   *                          if cpa improved or conversions arrived → correct_block
   *   - scale_*           → if t+72h ROAS held above threshold AND volume rose naturally → correct_block; else inconclusive
   *   - replace_creative  → if CTR recovered without intervention → correct_block; if degraded further → missed_signal
   *   - shift_budget_*    → if recipient eventually crossed conversion threshold → missed_signal (we should have moved budget); else correct_block
   *   - reduce/narrow/dayparting → similar to pause but milder; default to inconclusive when ambiguous
   */
  private computeRegretLabel(shadow: any, metricsAtT72h: ShadowAction['metricsAtT']): 'correct_block' | 'missed_signal' | 'inconclusive' {
    const t = shadow.metricsAtT;
    const t72 = metricsAtT72h;
    const type = shadow.proposedAction.type;

    // Insufficient delta — campaign barely ran or is paused
    if (t72.spend - t.spend < 100) return 'inconclusive';

    const cpaWorsePct = t.cpa > 0 ? ((t72.cpa - t.cpa) / t.cpa) * 100 : 0;
    const ctrChangePct = t.ctr > 0 ? ((t72.ctr - t.ctr) / t.ctr) * 100 : 0;
    const conversionsAdded = t72.conversions - t.conversions;

    if (type === 'pause_ad' || type === 'pause_adset') {
      // We blocked a pause. Did the underlying problem (zero conv / high CPA) persist?
      if (conversionsAdded === 0 && cpaWorsePct > 20) return 'missed_signal';
      if (conversionsAdded > 0 || cpaWorsePct < 0) return 'correct_block';
      return 'inconclusive';
    }
    if (type === 'replace_creative') {
      // We blocked a creative swap. Did CTR recover?
      if (ctrChangePct > 10) return 'correct_block';
      if (ctrChangePct < -15) return 'missed_signal';
      return 'inconclusive';
    }
    if (type === 'scale_adset') {
      // We blocked a scale. Did the ad set continue to win?
      if (t72.roas > 1.5 && conversionsAdded > 0) return 'correct_block';
      return 'inconclusive';
    }
    if (type === 'shift_budget_between_adsets') {
      // We blocked a budget shift to thin recipient. Did recipient eventually accumulate conversions?
      // We'd need ad-set-level metrics to truly evaluate; fall back to "inconclusive" if recipient unknown.
      const recipientConvAtT72 = shadow.proposedAction.params?.toAdSetId; // we'd need to fetch ad-set-level metrics
      if (!recipientConvAtT72) return 'inconclusive';
      return 'inconclusive';
    }
    if (type === 'reduce_total_budget' || type === 'narrow_placement' || type === 'dayparting') {
      if (cpaWorsePct > 15) return 'missed_signal';
      if (cpaWorsePct < 0) return 'correct_block';
      return 'inconclusive';
    }
    return 'inconclusive';
  }
}
