import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import {
  SliceIdentity,
  SliceRepository,
} from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import {
  META_SNAPSHOT_FETCHER,
  MetaSnapshotFetcher,
} from './meta-snapshot-fetcher.interface';
import {
  IntelligenceSnapshot,
  IntelligenceSnapshotDocument,
} from './snapshot.schema';
import { SnapshotBuilder } from './snapshot-builder.service';
import { SnapshotValidator } from './snapshot-validator.service';
import { ProductForRevenue, SnapshotData } from './snapshot.types';

/**
 * The truth-layer engine.
 *
 * Two paths fire this engine:
 *  1. The 15-min `INTELLIGENCE_SNAPSHOT` BullMQ tick — writes a snapshot
 *     doc to intelligence_snapshots without seeding a cycle.
 *  2. The hourly `INTELLIGENCE_CYCLE` boot — orchestrator opens a
 *     cycle then calls captureForCycle() which reuses (or fetches) the
 *     newest snapshot and writes the SnapshotData slice to the slice
 *     store so downstream engines can subscribe to
 *     intelligence.snapshot.completed.
 *
 * PR-04 will wire the BullMQ triggers. PR-03 exposes the two entry
 * methods (capture / captureForCycle) that the queues + controllers
 * will call.
 */
@Injectable()
export class SnapshotEngine extends BaseEngine<'snapshot', SnapshotData> {
  readonly name = 'snapshot' as const;
  readonly step = 1;
  readonly version = '1.0.0';
  readonly dependsOn = [] as const;

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    @Inject(META_SNAPSHOT_FETCHER)
    private readonly fetcher: MetaSnapshotFetcher,
    @InjectModel(IntelligenceSnapshot.name)
    private readonly snapshotModel: Model<IntelligenceSnapshotDocument>,
    private readonly builder: SnapshotBuilder,
    private readonly validator: SnapshotValidator,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  protected isDeterministic(): boolean {
    return false; // Snapshot Engine is the boundary; every other engine is deterministic
  }

  /**
   * Standalone capture — 15-min tick path. Persists an
   * intelligence_snapshots doc but does NOT touch the slice store or
   * emit a cycle-scoped event.
   */
  async capture(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
    products: ProductForRevenue[];
  }): Promise<{ snapshotId: string; confidence: number }> {
    const bundle = await this.fetcher.fetch({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      metaCampaignId: input.metaCampaignId,
    });
    const data = this.builder.build({ bundle, products: input.products });
    const validation = this.validator.validate(data);
    await this.snapshotModel.create({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      metaCampaignId: input.metaCampaignId,
      snapshotId: data.snapshotId,
      collectedAt: data.collectedAt,
      metaWindowStart: bundle.metaWindowStart,
      metaWindowEnd: bundle.metaWindowEnd,
      metrics: data.metrics,
      entities: data.entities,
      meta: data.meta,
      missingFields: data.missingFields,
      freshnessSec: data.freshnessSec,
      rawCampaign: bundle.campaign as Record<string, unknown>,
      rawAdSets: bundle.adSets as Record<string, unknown>,
      rawAds: bundle.ads as Record<string, unknown>,
    });
    const confidence = this.validator.confidence(validation);
    return { snapshotId: data.snapshotId, confidence };
  }

  /**
   * Cycle-scoped path — reads the newest snapshot for this campaign
   * (fetches fresh if none exists in the last 15 min) and writes the
   * slice to intelligence_engine_outputs so downstream engines cascade.
   */
  async captureForCycle(input: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
    products: ProductForRevenue[];
  }): Promise<void> {
    // Snapshot has no persisted dependency from which BaseEngine can recover
    // identity. Pass this invocation's complete immutable input directly so
    // duplicate same-cycle listeners cannot overwrite or delete shared state.
    const invocation = {
      ...input,
      products: [...input.products],
    };
    await this.execute(input.cycleId, invocation);
  }

  /**
   * OrchestratorHook — invoked directly when the orchestrator emits
   * `intelligence.cycle.snapshot-requested` with the identity payload.
   * Kept alongside `captureForCycle` so a controller or BullMQ handler
   * can call this engine through the event bus if preferred.
   */
  @OnEvent('intelligence.cycle.snapshot-requested')
  async onSnapshotRequested(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
    products: ProductForRevenue[];
  }): Promise<void> {
    await this.captureForCycle(payload);
  }

  protected async compute(
    _deps: unknown,
    cycleId: string,
    resolvedIdentity: SliceIdentity,
  ): Promise<SnapshotData> {
    const identity = resolvedIdentity as SliceIdentity & {
      metaCampaignId?: unknown;
      products?: unknown;
    };
    if (
      typeof identity.metaCampaignId !== 'string' ||
      identity.metaCampaignId.trim().length === 0 ||
      !Array.isArray(identity.products)
    ) {
      throw new Error('SnapshotEngine.compute called without complete input');
    }
    const anyCycle = {
      cycleId,
      tenantId: identity.tenantId,
      campaignId: identity.campaignId,
      metaCampaignId: identity.metaCampaignId,
      products: identity.products as ProductForRevenue[],
    };
    const bundle = await this.fetcher.fetch({
      tenantId: anyCycle.tenantId,
      campaignId: anyCycle.campaignId,
      metaCampaignId: anyCycle.metaCampaignId,
    });
    const data = this.builder.build({ bundle, products: anyCycle.products });
    await this.snapshotModel.create({
      tenantId: anyCycle.tenantId,
      campaignId: anyCycle.campaignId,
      metaCampaignId: anyCycle.metaCampaignId,
      snapshotId: data.snapshotId,
      cycleId: anyCycle.cycleId,
      collectedAt: data.collectedAt,
      metaWindowStart: bundle.metaWindowStart,
      metaWindowEnd: bundle.metaWindowEnd,
      metrics: data.metrics,
      entities: data.entities,
      meta: data.meta,
      missingFields: data.missingFields,
      freshnessSec: data.freshnessSec,
      rawCampaign: bundle.campaign as Record<string, unknown>,
      rawAdSets: bundle.adSets as Record<string, unknown>,
      rawAds: bundle.ads as Record<string, unknown>,
    });
    return data;
  }

  protected computeConfidence(_deps: unknown, data: SnapshotData): number {
    return this.validator.confidence(this.validator.validate(data));
  }

  protected buildEvidence(_deps: unknown, data: SnapshotData): Evidence[] {
    return [
      {
        kind: 'external_api',
        ref: `meta://campaign/${data.meta.accountId}`,
        weight: 1,
        note: `freshness=${data.freshnessSec}s`,
      },
    ];
  }

  /**
   * Read helper for Trend / Memory / Learning engines. Returns snapshots
   * ordered newest-first.
   */
  async getHistory(
    tenantId: string,
    campaignId: string,
    limit = 30,
  ): Promise<IntelligenceSnapshot[]> {
    return this.snapshotModel
      .find({ tenantId, campaignId })
      .sort({ collectedAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }
}
