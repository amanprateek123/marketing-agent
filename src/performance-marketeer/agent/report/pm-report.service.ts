import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PmAnalysisService } from '../../analysis/pm-analysis.service';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { istDay } from '../../pm.logic';
import { PmAgentRun } from '../../schemas/pm-agent-run.schema';
import { PmMetaEntity } from '../../schemas/pm-meta.schema';
import type { CreativeIdea, PmToolCtx } from '../pm-agent.types';
import { PmPipelineService } from '../pipeline/pm-pipeline.service';
import { PmDataTools } from '../tools/data.tools';
import {
  creativeVerdict,
  latestFile,
  mdSections,
  sectionBody,
} from './report.logic';

const r2 = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? null
    : Math.round(n * 100) / 100;

/**
 * The owner-facing report for one campaign run: what the AI concluded (from
 * the run's saved files) next to the numbers behind it, computed by code with
 * the same data tools the AI used, for the 7 days before the run.
 */
@Injectable()
export class PmReportService {
  constructor(
    @InjectModel(PmAgentRun.name) private readonly runs: Model<PmAgentRun>,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    private readonly analysis: PmAnalysisService,
    private readonly tools: PmDataTools,
    private readonly pipeline: PmPipelineService,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  async report(campaignId: string, date?: string) {
    const t = this.env.tenantId;
    const run = await this.runs
      .findOne({ tenantId: t, campaignId, ...(date ? { date } : {}) })
      .sort({ date: -1 })
      .lean();
    if (!run) throw new NotFoundException('No run for this campaign and date');
    const camp = await this.entities
      .findOne({ tenantId: t, level: 'campaign', entityId: campaignId })
      .lean();
    if (!camp) throw new NotFoundException('Campaign not found');

    const d = run.date;
    const to = addDays(d, -1);
    const q = { from: addDays(d, -7), to };
    const launched = camp.createdTime
      ? istDay(new Date(camp.createdTime))
      : null;
    const life = launched && launched <= to ? { from: launched, to } : null;

    const ctx: PmToolCtx = {
      tenantId: t,
      campaignId,
      date: d,
      dir: '',
      phase: 'plan',
      round: 0,
      record: async () => '',
    };
    const defs = new Map(this.tools.defs().map((x) => [x.name, x]));
    const tool = (name: string, args: Record<string, unknown> = {}) =>
      defs
        .get(name)!
        .run({ ...q, ...args }, ctx)
        .catch(() => null) as Promise<any>;

    const [
      m7,
      mLife,
      account,
      ads,
      adEnts,
      trend,
      funnel,
      payments,
      ageGender,
      placement,
      region,
      goal,
      basis,
    ] = await Promise.all([
      this.analysis.scopeMetrics(q, 'campaign', campaignId),
      life ? this.analysis.scopeMetrics(life, 'campaign', campaignId) : null,
      this.analysis.scopeMetrics(q, 'account'),
      this.analysis.entities(q, 'ad', campaignId),
      this.entities
        .find(
          { tenantId: t, level: 'ad', campaignId },
          { entityId: 1, creative: 1, adsetId: 1 },
        )
        .lean(),
      this.analysis.trend(
        { from: addDays(d, -14), to },
        'campaign',
        campaignId,
      ),
      tool('funnel'),
      tool('payment_health'),
      tool('breakdowns', { breakdown: 'age_gender' }),
      tool('breakdowns', { breakdown: 'placement' }),
      tool('breakdowns', { breakdown: 'region' }),
      this.pipeline.goal(d, camp).catch(() => null),
      this.pipeline.metaBasis(d, camp).catch(() => null),
    ]);

    // What the AI wrote: latest round of each phase.
    const files = run.files ?? {};
    const invMd = mdSections(latestFile(files, '01-investigate'));
    const invJson = safeJson(latestFile(files, '01-investigate', '.md.json'));
    const planJson = safeJson(latestFile(files, '03-plan', '.md.json'));

    const creative = new Map(adEnts.map((e) => [e.entityId, e]));
    const campStats = {
      spend: m7.spend,
      impressions: m7.impressions,
      ctr: m7.ctr,
      metaPurchases: m7.metaPurchases,
      metaRoas: m7.metaRoas,
    };
    const creatives = ads.rows
      .filter((a) => a.metrics.spend > 0)
      .sort((a, b) => b.metrics.spend - a.metrics.spend)
      .map((a) => {
        const c = creative.get(a.id)?.creative;
        const m = a.metrics;
        return {
          id: a.id,
          name: a.name,
          status: a.effectiveStatus,
          thumbnailUrl: c?.thumbnailUrl || c?.imageUrl || null,
          format: c?.videoId ? 'video' : c?.objectType || null,
          title: c?.title ?? '',
          body: c?.body ?? '',
          cta: c?.cta ?? '',
          spend: Math.round(m.spend),
          spendSharePct: m7.spend ? r2((m.spend / m7.spend) * 100) : null,
          impressions: m.impressions,
          ctrPct: m.ctr === null ? null : r2(m.ctr * 100),
          cpm: r2(m.cpm),
          metaPurchases: m.metaPurchases,
          costPerPurchase: m.metaPurchases
            ? Math.round(m.spend / m.metaPurchases)
            : null,
          metaRoas: r2(m.metaRoas),
          firstPartyOrders: m.firstPartyOrders,
          verdict: creativeVerdict(
            {
              spend: m.spend,
              impressions: m.impressions,
              ctr: m.ctr,
              metaPurchases: m.metaPurchases,
              metaRoas: m.metaRoas,
            },
            campStats,
          ),
        };
      });

    const headline = (m: typeof m7 | null) =>
      m && {
        spend: Math.round(m.spend),
        impressions: m.impressions,
        linkClicks: m.linkClicks,
        landingPageViews: m.landingPageViews,
        ctrPct: m.ctr === null ? null : r2(m.ctr * 100),
        cpm: r2(m.cpm),
        cpc: r2(m.cpc),
        metaPurchases: m.metaPurchases,
        metaPurchaseValue: Math.round(m.metaPurchaseValue),
        metaRoas: r2(m.metaRoas),
        costPerPurchase: m.metaPurchases
          ? Math.round(m.spend / m.metaPurchases)
          : null,
        siteVisitors: m.siteVisitors,
        firstPartyOrders: m.firstPartyOrders,
        firstPartyRevenue: Math.round(m.firstPartyRevenue),
        firstPartyRoas: r2(m.firstPartyRoas),
      };

    const bd = (x: any) =>
      x && {
        rows: (x.rows ?? []).slice(0, 12),
        missingDays: x.missingDays ?? [],
        daysWithData: x.daysWithData ?? 0,
      };

    return {
      run: {
        campaignId,
        campaignName: camp.name,
        date: d,
        status: run.status,
        finishedAt: run.finishedAt,
        costUsd: run.costUsd,
        product: camp.product,
      },
      window: q,
      launched,
      settings: {
        objective: camp.objective || null,
        status: camp.effectiveStatus || camp.status || null,
        budgetLevel: camp.budgetLevel || null,
        dailyBudget: camp.dailyBudget ?? null,
        currentDailyBudget: goal?.currentDailyBudget ?? null,
      },
      /** 'app' / 'untracked' = judged on Meta's numbers (see metaBasis). */
      basis,
      goal,
      last7: headline(m7),
      sinceLaunch: life ? { ...life, ...headline(mLife) } : null,
      account: {
        ctrPct: account.ctr === null ? null : r2(account.ctr * 100),
        cpm: r2(account.cpm),
        cpc: r2(account.cpc),
      },
      verdict: sectionBody(invMd, 'Verdict') || invJson?.summary || '',
      planSummary: planJson?.summary ?? '',
      pathToTarget: planJson?.pathToTarget ?? null,
      funnel: {
        meta: {
          impressions: m7.impressions,
          linkClicks: m7.linkClicks,
          landingPageViews: m7.landingPageViews,
          metaPurchases: m7.metaPurchases,
        },
        site: funnel?.steps ?? [],
        payments: payments?.people ?? null,
      },
      causes: (run.causes ?? []).map((c) => ({
        ...c,
        narrative: sectionBody(invMd, c.id),
      })),
      creatives,
      creativeIdeas: (planJson?.creativeIdeas ?? []) as CreativeIdea[],
      breakdowns: {
        ageGender: bd(ageGender),
        placement: bd(placement),
        region: bd(region),
      },
      trend: trend.points.map((p) => ({
        date: p.date,
        spend: Math.round(p.spend),
        cpm: r2(p.cpm),
        ctrPct: p.ctr === null ? null : r2(p.ctr * 100),
        metaPurchases: p.metaPurchases,
        firstPartyOrders: p.firstPartyOrders,
      })),
      actions: run.actions ?? [],
      ruledOut: (invJson?.ruledOut ?? []).map(
        (x: { title: string }) => x.title,
      ),
      dataGaps: (invJson?.dataGaps ?? []) as string[],
      unresolved: run.unresolved ?? [],
    };
  }
}

function safeJson(s: string): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
