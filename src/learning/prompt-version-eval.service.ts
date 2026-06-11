import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { PromptVersionEval, PromptVersionEvalDocument } from './schemas/prompt-version-eval.schema';
import { SlackService } from '../delivery/slack.service';

/**
 * Evals the learning loop itself: compares campaign outcomes across prompt
 * versions. Run by the Day-30 deep run BEFORE it regenerates prompts, so each
 * cycle answers "did the LAST cycle's regeneration actually help?" before
 * producing the next one. 'regressed' fires an ops alert — that's the cue to
 * inspect promptsHistory and consider companiesService.revertPrompts().
 *
 * Thresholds are deliberately coarse (±10% on spend-weighted ROAS, minimum
 * 3 campaigns + ₹5K spend per side). With weekly pipeline cadence the per-
 * version sample is small — this catches poisoning, not subtle drift.
 */
@Injectable()
export class PromptVersionEvalService {
  private readonly logger = new Logger(PromptVersionEvalService.name);

  private static readonly MIN_CAMPAIGNS_PER_SIDE = 3;
  private static readonly MIN_SPEND_PER_SIDE = 5000;
  private static readonly LOOKBACK_DAYS = 180;

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(PromptVersionEval.name)
    private readonly evalModel: Model<PromptVersionEvalDocument>,
    private readonly slackService: SlackService,
  ) {}

  /**
   * Compare the two most recent prompt versions that have campaign data.
   * Persists the eval and ops-alerts on regression. Never throws — the deep
   * run must not fail because its own report card couldn't be computed.
   */
  async evaluate(tenantId: string): Promise<PromptVersionEval | null> {
    try {
      const since = new Date(Date.now() - PromptVersionEvalService.LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const campaigns = await this.campaignModel
        .find({
          tenantId,
          source: 'agent',
          promptsVersion: { $gte: 1 },
          spend: { $gte: 500 },
          createdAt: { $gte: since },
        })
        .select('promptsVersion spend conversions roas')
        .lean()
        .exec();

      type Bucket = { campaigns: number; totalSpend: number; totalConversions: number; revenue: number };
      const byVersion = new Map<number, Bucket>();
      for (const c of campaigns) {
        const v = (c as any).promptsVersion as number;
        const b = byVersion.get(v) ?? { campaigns: 0, totalSpend: 0, totalConversions: 0, revenue: 0 };
        b.campaigns++;
        b.totalSpend += c.spend ?? 0;
        b.totalConversions += c.conversions ?? 0;
        b.revenue += (c.roas ?? 0) * (c.spend ?? 0);
        byVersion.set(v, b);
      }

      const versions = [...byVersion.keys()].sort((a, b) => b - a);
      if (versions.length < 2) {
        this.logger.log(`Prompt-version eval skipped for ${tenantId}: only ${versions.length} version(s) with campaign data`);
        return null;
      }
      const [newerV, olderV] = versions;
      const toStats = (b: Bucket) => ({
        campaigns: b.campaigns,
        totalSpend: Math.round(b.totalSpend),
        totalConversions: b.totalConversions,
        weightedROAS: b.totalSpend > 0 ? b.revenue / b.totalSpend : 0,
        cpa: b.totalConversions > 0 ? b.totalSpend / b.totalConversions : 0,
      });
      const newer = toStats(byVersion.get(newerV)!);
      const older = toStats(byVersion.get(olderV)!);

      const underpowered =
        newer.campaigns < PromptVersionEvalService.MIN_CAMPAIGNS_PER_SIDE
        || older.campaigns < PromptVersionEvalService.MIN_CAMPAIGNS_PER_SIDE
        || newer.totalSpend < PromptVersionEvalService.MIN_SPEND_PER_SIDE
        || older.totalSpend < PromptVersionEvalService.MIN_SPEND_PER_SIDE;

      let verdict: string;
      let detail: string;
      if (underpowered) {
        verdict = 'inconclusive';
        detail = `Insufficient sample (need ≥${PromptVersionEvalService.MIN_CAMPAIGNS_PER_SIDE} campaigns and ₹${PromptVersionEvalService.MIN_SPEND_PER_SIDE} spend per side).`;
      } else if (older.weightedROAS <= 0) {
        verdict = newer.weightedROAS > 0 ? 'improved' : 'inconclusive';
        detail = `Older version had zero measured revenue.`;
      } else {
        const ratio = newer.weightedROAS / older.weightedROAS;
        verdict = ratio >= 1.1 ? 'improved' : ratio <= 0.9 ? 'regressed' : 'neutral';
        detail = `v${newerV} weighted ROAS ${newer.weightedROAS.toFixed(2)}x vs v${olderV} ${older.weightedROAS.toFixed(2)}x (${((ratio - 1) * 100).toFixed(0)}%) on ${newer.campaigns}/${older.campaigns} campaigns, ₹${newer.totalSpend}/₹${older.totalSpend} spend.`;
      }

      const evalDoc = await this.evalModel.create({
        tenantId, newerVersion: newerV, olderVersion: olderV, newer, older, verdict, detail,
      });
      this.logger.log(`Prompt-version eval for ${tenantId}: ${verdict} — ${detail}`);

      if (verdict === 'regressed') {
        void this.slackService.sendOpsAlert(
          `Prompt version v${newerV} REGRESSED vs v${olderV} (tenant=${tenantId}): ${detail} The last learning cycle may have poisoned the prompts — inspect promptsHistory and consider reverting before the next regeneration compounds it.`,
          { tenantId, newerVersion: newerV, olderVersion: olderV },
        );
      }
      return evalDoc.toObject() as PromptVersionEval;
    } catch (err: any) {
      this.logger.warn(`Prompt-version eval failed for ${tenantId}: ${err.message}`);
      return null;
    }
  }
}
