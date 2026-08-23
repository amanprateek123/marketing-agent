import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CampaignSyncService } from '../../campaigns/meta-ads/campaign-sync.service';
import { buildProductResolver } from '../../campaigns/meta-ads/product-resolver.util';
import { CompaniesService } from '../../companies/companies.service';
import {
  Campaign,
  CampaignSource,
  isManagedCampaignSource,
} from '../../campaigns/schemas/campaign.schema';
import {
  IntelligenceBrief,
  IntelligenceBriefDocument,
} from '../../pipeline/schemas/intelligence-brief.schema';
import { IntelligenceOrchestrator } from '../orchestrator/intelligence-orchestrator.service';
import { SnapshotEngine } from '../snapshot/snapshot-engine.service';
import { ProductForRevenue } from '../snapshot/snapshot.types';
import { DecisionsService } from '../decisions/decisions.service';

export interface PrimeOptions {
  /** Skip Meta sync — data was refreshed recently by the sync scheduler. */
  skipSync?: boolean;
  /** Cap on how many active campaigns to analyze per run. */
  maxCampaigns?: number;
  /**
   * Analyze EVERY eligible campaign instead of the top-N by spend.
   *
   * The default top-N exists to bound a single tick's Meta API cost. On the
   * scheduled sweep that bound is the wrong trade: a campaign outside the top
   * N is never looked at by anything, so a small campaign quietly burning
   * money is invisible to the optimiser forever.
   */
  analyzeAll?: boolean;
  /**
   * Run the cascade on these campaigns specifically (Mongo _id or
   * metaCampaignId), instead of the top-N-by-spend active selection.
   *
   * Explicit targeting deliberately bypasses BOTH the `status: 'active'` and
   * the managed-source filters. Those exist to stop the automatic scheduler
   * burning cycles on campaigns nobody here controls — but when an operator
   * names a campaign, they have already made that judgement, and silently
   * returning "0 analyzed" because the campaign's source is 'manual' is the
   * kind of no-op that reads as a broken feature.
   */
  campaignIds?: string[];
}

export interface CampaignCascadeResult {
  campaignId: string;
  metaCampaignId: string;
  name: string;
  cycleId?: string;
  status: 'ok' | 'timeout' | 'failed';
  error?: string;
  decisionsWritten?: number;
}

export interface PrimeResult {
  ok: boolean;
  message: string;
  totalDecisions: number;
  campaignsAnalyzed: number;
  results: CampaignCascadeResult[];
  sync?: { synced: number };
}

/**
 * PrimeService — runs the 16-engine intelligence cascade for a tenant.
 *
 * Called both by:
 *   - `POST /api/v1/intelligence/:tenantId/prime` (manual "Look again now")
 *   - `IntelligenceCascadeScheduler` (automatic every 30 min per active tenant)
 *
 * Meta is NOT mutated. Every recommendation lands in `intelligence_decisions`
 * with `shadowModeOnly=true`.
 */
@Injectable()
export class PrimeService {
  private readonly log = new Logger(PrimeService.name);

  constructor(
    private readonly campaignSync: CampaignSyncService,
    private readonly companies: CompaniesService,
    private readonly orchestrator: IntelligenceOrchestrator,
    private readonly snapshotEngine: SnapshotEngine,
    private readonly decisions: DecisionsService,
    private readonly emitter: EventEmitter2,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign>,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {}

  async runFor(
    tenantId: string,
    opts: PrimeOptions = {},
  ): Promise<PrimeResult> {
    const skipSync = !!opts.skipSync;
    const maxCampaigns = Math.min(20, Math.max(1, opts.maxCampaigns ?? 5));

    const company = await this.companies.findByTenantId(tenantId);
    if (!company) {
      return {
        ok: false,
        message: `tenant not found: ${tenantId}`,
        totalDecisions: 0,
        campaignsAnalyzed: 0,
        results: [],
      };
    }
    const accessToken = (company as { meta?: { accessToken?: string } }).meta
      ?.accessToken;
    if (!accessToken) {
      return {
        ok: false,
        message: `tenant ${tenantId} has no meta.accessToken`,
        totalDecisions: 0,
        campaignsAnalyzed: 0,
        results: [],
      };
    }

    // ── 1. Sync live campaigns (optional) ─────────────────────────
    let syncResult: { synced: number } = { synced: 0 };
    if (!skipSync) {
      try {
        syncResult = await this.campaignSync.syncActiveCampaigns(
          company as unknown as Parameters<
            typeof this.campaignSync.syncActiveCampaigns
          >[0],
        );
        this.log.log(`[${tenantId}] synced ${syncResult.synced} campaigns`);
      } catch (e) {
        this.log.warn(
          `[${tenantId}] sync failed: ${(e as Error).message}. Continuing with local data.`,
        );
      }
    }
    // ── 2. Pull active campaigns ──────────────────────────────────
    // Only run intelligence on campaigns this tool actually manages
    // (source 'agent' = fully autonomous, 'human' = launched via this
    // dashboard's manual-create form). Excludes 'manual' — campaigns a
    // tenant created directly in Meta Ads Manager, synced in for visibility
    // only — see isManagedCampaignSource() in campaign.schema.ts.
    const explicitIds = (opts.campaignIds ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const managedSources = (
      ['agent', 'manual', 'human'] as CampaignSource[]
    ).filter(isManagedCampaignSource);

    const activeCampaigns = explicitIds.length
      ? await this.campaignModel
          .find({
            tenantId,
            $or: [
              { metaCampaignId: { $in: explicitIds } },
              ...(explicitIds.every((id) => /^[a-f0-9]{24}$/i.test(id))
                ? [{ _id: { $in: explicitIds } }]
                : explicitIds
                    .filter((id) => /^[a-f0-9]{24}$/i.test(id))
                    .map((id) => ({ _id: id }))),
            ],
          })
          .lean()
          .exec()
      : await (() => {
          const q = this.campaignModel
            .find({
              tenantId,
              status: 'active',
              source: { $in: managedSources },
            })
            .sort({ spend: -1 });
          return opts.analyzeAll
            ? q.lean().exec()
            : q.limit(maxCampaigns).lean().exec();
        })();

    if (explicitIds.length && activeCampaigns.length < explicitIds.length) {
      const found = new Set(
        activeCampaigns.flatMap((c) => [
          String((c as { _id: unknown })._id),
          c.metaCampaignId ?? '',
        ]),
      );
      const missing = explicitIds.filter((id) => !found.has(id));
      if (missing.length) {
        this.log.warn(
          `[${tenantId}] requested campaigns not found: ${missing.join(', ')}`,
        );
      }
    }

    if (activeCampaigns.length === 0) {
      return {
        ok: true,
        message:
          syncResult.synced === 0
            ? 'Sync ran but found no active campaigns. Nothing to analyze.'
            : 'Synced campaigns but none active locally.',
        totalDecisions: 0,
        campaignsAnalyzed: 0,
        sync: syncResult,
        results: [],
      };
    }

    // ── 3. Resolve one product per campaign ──────────────────────
    // SnapshotBuilder reads products[0], so passing the tenant's entire
    // catalogue makes the manual prime path silently use whichever product
    // happens to be first. Use the same resolver as scheduled cycles and
    // pass exactly one product, or none when the mapping is ambiguous.
    const companyProducts =
      (company as unknown as { products?: Array<Record<string, unknown>> })
        .products ?? [];
    const resolveProduct = await buildProductResolver(
      this.campaignModel as unknown as Parameters<
        typeof buildProductResolver
      >[0],
      this.briefModel,
      tenantId,
      activeCampaigns
        .map((campaign) => campaign.metaCampaignId)
        .filter((id): id is string => Boolean(id)),
      companyProducts,
    );

    // ── 4. Fire cascade sequentially per campaign ──────────────────
    const results: CampaignCascadeResult[] = [];
    for (const c of activeCampaigns) {
      const campaignId = String((c as { _id: unknown })._id);
      const metaCampaignId = c.metaCampaignId ?? '';
      const name = c.name ?? c.topic ?? 'campaign';
      const resolvedProduct = resolveProduct(metaCampaignId);
      const products = resolvedProduct
        ? toSnapshotProducts([resolvedProduct])
        : [];
      try {
        const dc = await this.orchestrator.openCycle({
          tenantId,
          campaignId,
          metaCampaignId,
        });

        const done = new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 45_000);
          const handler = (p: { cycleId: string }) => {
            if (p.cycleId === dc.cycleId) {
              clearTimeout(t);
              this.emitter.off('intelligence.cycle.completed', handler);
              resolve(true);
            }
          };
          this.emitter.on('intelligence.cycle.completed', handler);
        });

        await this.snapshotEngine.captureForCycle({
          cycleId: dc.cycleId,
          tenantId,
          campaignId,
          metaCampaignId,
          products,
        });

        const finished = await done;
        await new Promise((r) => setTimeout(r, 500));
        const listed = await this.decisions.list({
          tenantId,
          campaignId,
          limit: 100,
        });
        const forThisCycle = listed.filter((d) => d.cycleId === dc.cycleId);

        results.push({
          campaignId,
          metaCampaignId,
          name,
          cycleId: dc.cycleId,
          status: finished ? 'ok' : 'timeout',
          decisionsWritten: forThisCycle.length,
        });
      } catch (err) {
        this.log.warn(
          `[${tenantId}] ${name.substring(0, 40)} failed: ${(err as Error).message}`,
        );
        results.push({
          campaignId,
          metaCampaignId,
          name,
          status: 'failed',
          error: (err as Error).message,
        });
      }
    }

    const totalDecisions = results.reduce(
      (s, r) => s + (r.decisionsWritten ?? 0),
      0,
    );
    return {
      ok: true,
      message:
        totalDecisions === 0
          ? 'Cascade ran. No decisions proposed — campaigns look stable OR data is too thin.'
          : `Cascade ran. ${totalDecisions} proposed decisions waiting for your review. Nothing has been sent to Meta.`,
      totalDecisions,
      campaignsAnalyzed: activeCampaigns.length,
      sync: syncResult,
      results,
    };
  }
}

function toSnapshotProducts(
  products: Array<Record<string, unknown>>,
): ProductForRevenue[] {
  return (
    products
      // Product activation is a launch-selection gate, not a measurement gate.
      // Historical campaigns retain their resolved product's value/economics.
      .filter((product) => product.name)
      .map((product) => ({
        name: String(product.name),
        conversionValue: numOrUndef(product.conversionValue),
        contributionMargin: numOrUndef(product.contributionMargin),
        refundRatePercent: numOrUndef(product.refundRatePercent),
      }))
  );
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
