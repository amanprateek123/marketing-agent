import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ExecutedAction, ExecutedActionDocument } from './schemas/executed-action.schema';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { MetaMetricsService } from '../campaigns/meta-ads/meta-metrics.service';
import { CompaniesService } from '../companies/companies.service';
import { getEffectiveConversionValue } from '../common/conversion-value.util';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Measures the consequence of every optimizer action that actually ran.
 *
 * ShadowActionService answers "were our guards right to BLOCK this?" — this
 * service answers the complementary question the system never asked before:
 * "was the action we EXECUTED actually a good idea?" Each executed action is
 * anchored to metrics at execution time, re-measured at +24h and +72h by the
 * same shadow-eval job, and labeled improved / worsened / neutral.
 *
 * Finalized labels feed two places:
 *   1. getTrackRecord() — per-(actionType) outcome rates, rendered into the
 *      audit agent's prompt so the next verdict is weighted by what the same
 *      action type actually did on this tenant ("scale_adset worsened CPA in
 *      4 of 5 runs on day<3 campaigns — be skeptical of early scales").
 *   2. Manual review — same role as shadow regret stats.
 *
 * Recording and evaluation are best-effort and must never break the audit.
 */
@Injectable()
export class ActionOutcomeService {
  private readonly logger = new Logger(ActionOutcomeService.name);

  constructor(
    @InjectModel(ExecutedAction.name)
    private readonly executedModel: Model<ExecutedActionDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    private readonly metaMetrics: MetaMetricsService,
    private readonly companiesService: CompaniesService,
  ) {}

  /**
   * Persist an executed-action record with a fresh metrics anchor.
   *
   * Fetches live metrics itself (rather than trusting caller-passed campaign
   * doc fields) because execution can happen hours after the audit fetched
   * metrics — a human-approved scale runs on whatever stale numbers the doc
   * holds, and the +72h delta would be measured against the wrong baseline.
   * Falls back to campaign-doc fields if the Meta fetch fails.
   */
  async recordExecuted(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
    action: ExecutedAction['action'];
    trigger: ExecutedAction['trigger'];
    context?: ExecutedAction['context'];
    fallbackMetrics?: Partial<ExecutedAction['metricsAtT']>;
  }): Promise<void> {
    try {
      const now = new Date();
      const metricsAtT =
        (await this.fetchCurrentMetrics(input.tenantId, input.campaignId, input.metaCampaignId))
        ?? {
          spend: input.fallbackMetrics?.spend ?? 0,
          impressions: input.fallbackMetrics?.impressions ?? 0,
          clicks: input.fallbackMetrics?.clicks ?? 0,
          conversions: input.fallbackMetrics?.conversions ?? 0,
          ctr: input.fallbackMetrics?.ctr ?? 0,
          cpc: input.fallbackMetrics?.cpc ?? 0,
          cpa: input.fallbackMetrics?.cpa ?? 0,
          roas: input.fallbackMetrics?.roas ?? 0,
          frequency: input.fallbackMetrics?.frequency ?? 0,
        };

      await this.executedModel.create({
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        metaCampaignId: input.metaCampaignId,
        action: input.action,
        trigger: input.trigger,
        context: input.context ?? {},
        executedAt: now,
        metricsAtT,
        evaluateAt24h: new Date(now.getTime() + 24 * HOUR_MS),
        evaluateAt72h: new Date(now.getTime() + 72 * HOUR_MS),
        status: 'pending',
      });
      this.logger.debug(
        `Executed action recorded: tenantId=${input.tenantId} campaign=${input.metaCampaignId} type=${input.action.type} trigger=${input.trigger}`,
      );
    } catch (err: any) {
      // Never crash action execution on a logging failure.
      this.logger.warn(`Executed action record failed: ${err.message}`);
    }
  }

  /**
   * Evaluate records due for 24h or 72h measurement. Called by the same daily
   * shadow-eval job that evaluates blocked actions.
   */
  async evaluatePending(): Promise<{ evaluated24h: number; evaluated72h: number; finalized: number }> {
    const now = new Date();
    const result = { evaluated24h: 0, evaluated72h: 0, finalized: 0 };

    const due24h = await this.executedModel
      .find({ status: 'pending', evaluateAt24h: { $lte: now } })
      .limit(200)
      .lean()
      .exec();

    for (const rec of due24h) {
      try {
        const metrics = await this.fetchCurrentMetrics(rec.tenantId, rec.campaignId, rec.metaCampaignId);
        if (!metrics) continue;
        await this.executedModel.updateOne(
          { _id: rec._id },
          { metricsAtT24h: metrics, status: 'evaluated_24h' },
        );
        result.evaluated24h++;
      } catch (err: any) {
        this.logger.warn(`Executed-action 24h eval failed for ${rec._id}: ${err.message}`);
      }
    }

    const due72h = await this.executedModel
      .find({ status: 'evaluated_24h', evaluateAt72h: { $lte: now } })
      .limit(200)
      .lean()
      .exec();

    for (const rec of due72h) {
      try {
        const metrics = await this.fetchCurrentMetrics(rec.tenantId, rec.campaignId, rec.metaCampaignId);
        if (!metrics) continue;
        const outcomeLabel = this.computeOutcomeLabel(rec, metrics);
        await this.executedModel.updateOne(
          { _id: rec._id },
          { metricsAtT72h: metrics, outcomeLabel, evaluatedAt: now, status: 'final' },
        );
        result.evaluated72h++;
        result.finalized++;
      } catch (err: any) {
        this.logger.warn(`Executed-action 72h eval failed for ${rec._id}: ${err.message}`);
      }
    }

    if (result.evaluated24h + result.evaluated72h > 0) {
      this.logger.log(
        `Action-outcome evaluator: 24h=${result.evaluated24h} 72h=${result.evaluated72h} finalized=${result.finalized}`,
      );
    }
    return result;
  }

  /**
   * Per-(actionType) outcome rates over finalized records. Worsened examples
   * carry enough context (age, audience) for the auditor to pattern-match.
   */
  async getTrackRecord(tenantId: string, sinceDaysAgo: number = 60): Promise<{
    total: number;
    byActionType: Array<{
      actionType: string;
      total: number;
      improved: number;
      worsened: number;
      neutral: number;
      inconclusive: number;
      worsenedRatePct: number;
    }>;
    recentWorsened: Array<{
      actionType: string;
      targetName: string;
      ageDays: number | null;
      audienceType: string | null;
      cpaAtT: number;
      cpaAtT72h: number;
      executedAt: Date;
    }>;
  }> {
    const since = new Date(Date.now() - sinceDaysAgo * 24 * HOUR_MS);
    const finalized = await this.executedModel
      .find({ tenantId, status: 'final', executedAt: { $gte: since } })
      .sort({ executedAt: -1 })
      .lean()
      .exec();

    const buckets = new Map<string, { actionType: string; total: number; improved: number; worsened: number; neutral: number; inconclusive: number }>();
    for (const r of finalized) {
      const b = buckets.get(r.action.type) ?? {
        actionType: r.action.type, total: 0, improved: 0, worsened: 0, neutral: 0, inconclusive: 0,
      };
      b.total++;
      if (r.outcomeLabel === 'improved') b.improved++;
      else if (r.outcomeLabel === 'worsened') b.worsened++;
      else if (r.outcomeLabel === 'neutral') b.neutral++;
      else b.inconclusive++;
      buckets.set(r.action.type, b);
    }

    const recentWorsened = finalized
      .filter(r => r.outcomeLabel === 'worsened')
      .slice(0, 5)
      .map(r => ({
        actionType: r.action.type,
        targetName: r.action.targetName ?? r.action.targetId,
        ageDays: r.context?.ageDays ?? null,
        audienceType: r.context?.audienceType ?? null,
        cpaAtT: r.metricsAtT?.cpa ?? 0,
        cpaAtT72h: r.metricsAtT72h?.cpa ?? 0,
        executedAt: r.executedAt,
      }));

    return {
      total: finalized.length,
      byActionType: [...buckets.values()]
        // Judge worsened-rate on conclusive outcomes only — a type with 1
        // improved and 9 inconclusive shouldn't read as "90% safe".
        .map(b => {
          const conclusive = b.improved + b.worsened + b.neutral;
          return { ...b, worsenedRatePct: conclusive > 0 ? (b.worsened / conclusive) * 100 : 0 };
        })
        .sort((a, b) => b.worsenedRatePct - a.worsenedRatePct),
      recentWorsened,
    };
  }

  /**
   * Prompt block for the audit agent. Empty string until ≥3 finalized
   * outcomes exist — a track record of 1 would anchor the model on noise.
   */
  async renderTrackRecord(tenantId: string): Promise<string> {
    try {
      const tr = await this.getTrackRecord(tenantId);
      if (tr.total < 3) return '';

      const typeLines = tr.byActionType.map(b =>
        `  ${b.actionType}: ${b.total} executed → ${b.improved} improved, ${b.worsened} worsened, ${b.neutral} neutral, ${b.inconclusive} inconclusive` +
        (b.worsened > 0 ? ` (worsened ${b.worsenedRatePct.toFixed(0)}% of conclusive runs)` : ''),
      ).join('\n');

      const worsenedLines = tr.recentWorsened.map(w => {
        const ctx = [
          w.ageDays !== null ? `day ${w.ageDays}` : null,
          w.audienceType,
        ].filter(Boolean).join(', ');
        return `  ⚠ ${w.actionType} on "${w.targetName}"${ctx ? ` (${ctx})` : ''}: CPA ₹${w.cpaAtT.toFixed(0)} → ₹${w.cpaAtT72h.toFixed(0)} at +72h`;
      }).join('\n');

      return `━━━ ACTION TRACK RECORD (measured +72h outcomes of past executed actions, last 60d) ━━━
${typeLines}
${worsenedLines ? `Recent actions that backfired:\n${worsenedLines}\n` : ''}  RULE: This is ground truth on this tenant, not theory. Before recommending an action type with a high worsened rate, the current evidence must be clearly stronger than it was in the runs that backfired (more conversions, bigger metric gap, older campaign). If it isn't, prefer watch/no_action and say so in contextInsight.
`;
    } catch (err: any) {
      this.logger.warn(`renderTrackRecord failed: ${err.message}`);
      return '';
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  private async fetchCurrentMetrics(
    tenantId: string,
    campaignId: string,
    metaCampaignId: string,
  ): Promise<ExecutedAction['metricsAtT'] | null> {
    try {
      const campaign = await this.campaignModel.findOne({ _id: campaignId }).lean().exec();
      if (!campaign) return null;
      const company = await this.companiesService.findByTenantId(tenantId);
      if (!company?.meta?.accessToken) return null;
      const product = (company.products ?? []).find((p: any) => p.active);
      // Net of refunds — outcome labels compare CPA/ROAS deltas, so the anchor
      // and the +72h read must use the same refund-adjusted basis as the audit.
      const conversionValue = getEffectiveConversionValue(product);
      const conversionEvent = product?.conversionEvent ?? 'Purchase';
      const full = await this.metaMetrics.fetchFullMetrics(
        metaCampaignId,
        company.meta.accessToken,
        conversionValue,
        conversionEvent,
        // Custom Conversion ID required or custom-conversion products read 0
        // conversions and every outcome label goes 'inconclusive'.
        product?.customConversionId,
        product?.refundRatePercent,
      );
      const c = full.campaign;
      return {
        spend: c.spend, impressions: c.impressions, clicks: c.clicks, conversions: c.conversions,
        ctr: c.ctr, cpc: c.cpc, cpa: c.cpa, roas: c.roas, frequency: c.frequency,
        adSets: full.adSets.map(as => ({
          adSetId: as.adSetId,
          spend: as.spend,
          clicks: as.clicks,
          conversions: as.conversions,
          ctr: as.ctr,
          cpa: as.cpa,
        })),
      };
    } catch (err: any) {
      this.logger.warn(`Action-outcome fetchCurrentMetrics failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Label the +72h consequence of an executed action against the metric the
   * action was meant to move. Thresholds intentionally simple and symmetric —
   * refine once a few weeks of labels exist.
   *
   *   - pause_* / reduce / narrow / dayparting / refresh_audience → corrective:
   *     did campaign CPA improve after we cut the alleged bleed?
   *   - scale_adset / shift_budget → allocation: did the target ad set's
   *     INCREMENTAL spend convert at or better than its pre-action CPA?
   *   - replace_creative / add_creative / add_adset → additive: did the target
   *     ad set's CTR (proxy for creative health) recover?
   */
  private computeOutcomeLabel(
    rec: any,
    t72: ExecutedAction['metricsAtT'],
  ): 'improved' | 'worsened' | 'neutral' | 'inconclusive' {
    const t = rec.metricsAtT as ExecutedAction['metricsAtT'];
    const type = rec.action.type as string;

    // Campaign barely ran after the action — nothing to judge.
    if ((t72.spend ?? 0) - (t.spend ?? 0) < 100) return 'inconclusive';

    const findAdSet = (m: any, id: string) =>
      (Array.isArray(m?.adSets) ? m.adSets : []).find((as: any) => String(as.adSetId) === String(id));
    const targetAdSetId = String(rec.context?.targetAdSetId ?? rec.action.params?.toAdSetId ?? rec.action.targetId ?? '');

    const correctiveTypes = ['pause_ad', 'pause_adset', 'reduce_total_budget', 'narrow_placement', 'dayparting', 'refresh_audience'];
    if (correctiveTypes.includes(type)) {
      // No conversions at either anchor → CPA undefined both sides; the action
      // may have been right but the campaign's root problem is elsewhere.
      if ((t.conversions ?? 0) === 0 && (t72.conversions ?? 0) === 0) return 'inconclusive';
      // Conversions appeared (CPA went from ∞ to finite) → improvement.
      if ((t.cpa ?? 0) <= 0 && (t72.cpa ?? 0) > 0) return 'improved';
      // Conversions stopped entirely after the cut → we likely cut the converter.
      if ((t.cpa ?? 0) > 0 && (t72.conversions ?? 0) <= (t.conversions ?? 0)) return 'worsened';
      const cpaChangePct = ((t72.cpa - t.cpa) / t.cpa) * 100;
      if (cpaChangePct < -10) return 'improved';
      if (cpaChangePct > 20) return 'worsened';
      return 'neutral';
    }

    if (type === 'scale_adset' || type === 'shift_budget_between_adsets') {
      const asT = findAdSet(t, targetAdSetId);
      const asT72 = findAdSet(t72, targetAdSetId);
      if (!asT || !asT72) return 'inconclusive';
      const incrSpend = (asT72.spend ?? 0) - (asT.spend ?? 0);
      const incrConv = (asT72.conversions ?? 0) - (asT.conversions ?? 0);
      if (incrSpend < 200) return 'inconclusive';
      // Baseline: the ad set's own pre-action CPA, else campaign CPA at T.
      const baselineCPA = (asT.cpa ?? 0) > 0 ? asT.cpa : (t.cpa ?? 0);
      if (incrConv === 0) {
        // Scaled-into spend bought nothing — worsened once it exceeds what one
        // conversion should have cost (or a hard ₹500 floor when CPA unknown).
        return incrSpend > Math.max(baselineCPA, 500) ? 'worsened' : 'inconclusive';
      }
      const incrCPA = incrSpend / incrConv;
      if (baselineCPA <= 0) return 'neutral';
      if (incrCPA <= baselineCPA * 1.1) return 'improved';
      if (incrCPA >= baselineCPA * 1.3) return 'worsened';
      return 'neutral';
    }

    if (type === 'replace_creative' || type === 'add_creative' || type === 'add_adset') {
      const asT = findAdSet(t, targetAdSetId);
      const asT72 = findAdSet(t72, targetAdSetId);
      // Fall back to campaign CTR when the ad set row is missing (add_adset
      // creates a new ad set that has no row at T).
      const ctrT = (asT?.ctr ?? 0) > 0 ? asT.ctr : (t.ctr ?? 0);
      const ctrT72 = (asT72?.ctr ?? 0) > 0 ? asT72.ctr : (t72.ctr ?? 0);
      if (ctrT <= 0) return 'inconclusive';
      const ctrChangePct = ((ctrT72 - ctrT) / ctrT) * 100;
      if (ctrChangePct > 10) return 'improved';
      if (ctrChangePct < -10) return 'worsened';
      return 'neutral';
    }

    return 'inconclusive';
  }
}
