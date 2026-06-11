import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IntelligenceBrief, IntelligenceBriefDocument } from './schemas/intelligence-brief.schema';

/**
 * Grades intelligence sources by what they actually produce.
 *
 * Every brief records its ideaSource + the coordinator signals that inspired
 * it; the auditor writes day7/14/30 performance back onto the same brief.
 * Joining the two answers the question the pipeline never asked: "which
 * intelligence sources and platforms produce briefs that CONVERT?" Without
 * this, scouts run the same playbook every week regardless of whether their
 * signals ever turned into a profitable campaign.
 *
 * The rendered block feeds the idea-pool ranking prompt (and is available to
 * the coordinator), so next week's selection is weighted by last quarter's
 * ground truth.
 */
@Injectable()
export class SignalAccuracyService {
  private readonly logger = new Logger(SignalAccuracyService.name);

  constructor(
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {}

  async getAccuracy(tenantId: string, sinceDaysAgo: number = 90): Promise<{
    briefsWithOutcomes: number;
    bySource: Array<{ source: string; launched: number; converted: number; avgROAS: number }>;
    byPlatform: Array<{ platform: string; launched: number; converted: number; avgROAS: number }>;
  }> {
    const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000);
    const briefs = await this.briefModel
      .find({
        tenantId,
        'performanceWritten.day7': true,
        createdAt: { $gte: since },
      })
      .lean()
      .exec();

    type Bucket = { launched: number; converted: number; roasSum: number };
    const bySource = new Map<string, Bucket>();
    const byPlatform = new Map<string, Bucket>();
    const bump = (map: Map<string, Bucket>, key: string, perf: { roas: number; conversions: number }) => {
      if (!key) return;
      const b = map.get(key) ?? { launched: 0, converted: 0, roasSum: 0 };
      b.launched++;
      if (perf.conversions > 0) b.converted++;
      b.roasSum += perf.roas ?? 0;
      map.set(key, b);
    };

    for (const brief of briefs) {
      // Prefer the latest performance window available — day30 reflects the
      // settled outcome; day7 is the floor every counted brief has.
      const perf = (brief as any).day30Performance
        ?? (brief as any).day14Performance
        ?? (brief as any).day7Performance;
      if (!perf) continue;
      bump(bySource, (brief as any).ideaSource || 'unknown', perf);
      const platforms = new Set<string>([
        ...((brief as any).sourceSignals ?? []).flatMap((s: any) => s.platforms ?? []),
        ...((brief as any).sourcePlatforms ?? []),
      ]);
      for (const p of platforms) bump(byPlatform, p, perf);
    }

    const finish = (map: Map<string, Bucket>) =>
      [...map.entries()]
        .map(([key, b]) => ({
          source: key, platform: key,
          launched: b.launched, converted: b.converted,
          avgROAS: b.launched > 0 ? b.roasSum / b.launched : 0,
        }))
        .sort((a, b) => b.avgROAS - a.avgROAS);

    return {
      briefsWithOutcomes: briefs.length,
      bySource: finish(bySource),
      byPlatform: finish(byPlatform),
    };
  }

  /**
   * Prompt block for idea-pool / coordinator ranking. Empty until ≥3 briefs
   * have measured outcomes — one campaign's ROAS is noise, not a track record.
   * Never throws; ranking must not break because grading is unavailable.
   */
  async buildTrackRecordBlock(tenantId: string): Promise<string> {
    try {
      const acc = await this.getAccuracy(tenantId);
      if (acc.briefsWithOutcomes < 3) return '';

      const sourceLines = acc.bySource.map(s =>
        `  ${s.source}: ${s.launched} launched, ${s.converted} converted, avg ROAS ${s.avgROAS.toFixed(2)}x`,
      ).join('\n');
      const platformLines = acc.byPlatform.map(p =>
        `  ${p.platform}: ${p.launched} launched, ${p.converted} converted, avg ROAS ${p.avgROAS.toFixed(2)}x`,
      ).join('\n');

      return `SIGNAL TRACK RECORD (measured outcomes of past briefs, last 90d, ${acc.briefsWithOutcomes} briefs with day-7+ data):
By idea source:
${sourceLines}
By signal platform:
${platformLines}
RULE: Weight priorityScore by this record — a source/platform that has repeatedly converted deserves benefit of the doubt; one that has repeatedly failed needs a visibly stronger signal to rank high. Do NOT zero out a category on a small sample (<3 launched); diversity of sources still matters for exploration.`;
    } catch (err: any) {
      this.logger.warn(`Signal track record unavailable for ${tenantId}: ${err.message}`);
      return '';
    }
  }
}
