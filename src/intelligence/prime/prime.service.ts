import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CampaignSyncService } from '../../campaigns/meta-ads/campaign-sync.service';
import { CompaniesService } from '../../companies/companies.service';
import { Campaign } from '../../campaigns/schemas/campaign.schema';
import { IntelligenceOrchestrator } from '../orchestrator/intelligence-orchestrator.service';
import { SnapshotEngine } from '../snapshot/snapshot-engine.service';
import { DecisionsService } from '../decisions/decisions.service';

export interface PrimeOptions {
  /** Skip Meta sync — data was refreshed recently by the sync scheduler. */
  skipSync?: boolean;
  /** Cap on how many active campaigns to analyze per run. */
  maxCampaigns?: number;
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
  ) {}

  async runFor(tenantId: string, opts: PrimeOptions = {}): Promise<PrimeResult> {
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
    const activeCampaigns = await this.campaignModel
      .find({ tenantId, status: 'active' })
      .sort({ spend: -1 })
      .limit(maxCampaigns)
      .lean()
      .exec();

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

    // ── 3. Reduce products to SnapshotEngine input shape ──────────
    const products = (
      (company as unknown as { products?: Array<Record<string, unknown>> })
        .products ?? []
    )
      .filter((p) => p.active !== false && p.name)
      .map((p) => ({
        name: String(p.name),
        conversionValue: numOrUndef(p.conversionValue),
        contributionMargin: numOrUndef(p.contributionMargin),
        refundRatePercent: numOrUndef(p.refundRatePercent),
      }));

    // ── 4. Fire cascade sequentially per campaign ──────────────────
    const results: CampaignCascadeResult[] = [];
    for (const c of activeCampaigns) {
      const campaignId = String((c as { _id: unknown })._id);
      const metaCampaignId = c.metaCampaignId ?? '';
      const name = c.name ?? c.topic ?? 'campaign';
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

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
