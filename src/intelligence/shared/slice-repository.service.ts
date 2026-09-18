import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DecisionContext,
  EngineSliceKey,
} from '../orchestrator/decision-context';
import { EngineOutputDoc } from '../orchestrator/engine-output.schema';
import { EngineContext } from './engine-context';

export interface SliceIdentity {
  readonly tenantId: string;
  readonly campaignId: string;
}

export function isValidSliceIdentity(
  identity: SliceIdentity | null | undefined,
): identity is SliceIdentity {
  return Boolean(
    identity &&
    typeof identity.tenantId === 'string' &&
    identity.tenantId.trim().length > 0 &&
    typeof identity.campaignId === 'string' &&
    identity.campaignId.trim().length > 0,
  );
}

/**
 * Reads and writes engine slices to intelligence_engine_outputs.
 * The only way engines exchange data — no engine holds another engine's
 * output in memory across compute() calls.
 */
@Injectable()
export class SliceRepository {
  constructor(
    @InjectModel(EngineOutputDoc.name)
    private readonly model: Model<EngineOutputDoc>,
  ) {}

  async write<T>(
    ctx: { cycleId: string; tenantId: string; campaignId: string },
    engine: EngineSliceKey,
    slice: EngineContext<T>,
  ): Promise<void> {
    if (
      typeof ctx.cycleId !== 'string' ||
      ctx.cycleId.trim().length === 0 ||
      !isValidSliceIdentity(ctx)
    ) {
      throw new Error(
        `Refusing to persist ${engine} slice without a complete cycle identity`,
      );
    }

    await this.model.updateOne(
      { cycleId: ctx.cycleId, engine },
      {
        $setOnInsert: {
          cycleId: ctx.cycleId,
          tenantId: ctx.tenantId,
          campaignId: ctx.campaignId,
          engine,
          slice,
          writtenAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async load<K extends EngineSliceKey>(
    cycleId: string,
    engine: K,
  ): Promise<DecisionContext[K] | undefined> {
    const doc = await this.model.findOne({ cycleId, engine }).lean().exec();
    if (!doc) return undefined;
    return doc.slice as unknown as DecisionContext[K];
  }

  async loadMany(
    cycleId: string,
    engines: readonly EngineSliceKey[],
  ): Promise<Partial<DecisionContext>> {
    const loaded = await this.loadManyWithIdentity(cycleId, engines);
    return loaded.slices;
  }

  /**
   * Load dependency slices and their persisted identity in one query. The
   * identity is kept separate from slice payloads so engines cannot infer it
   * from mutable in-memory event state.
   */
  async loadManyWithIdentity(
    cycleId: string,
    engines: readonly EngineSliceKey[],
  ): Promise<{
    slices: Partial<DecisionContext>;
    identity: SliceIdentity | null;
  }> {
    if (engines.length === 0) return { slices: {}, identity: null };
    const docs = await this.model
      .find({ cycleId, engine: { $in: engines as EngineSliceKey[] } })
      .lean()
      .exec();
    const out: Partial<DecisionContext> = {};
    for (const doc of docs) {
      (out as Record<string, unknown>)[doc.engine] = doc.slice;
    }
    return {
      slices: out,
      identity: this.resolveConsistentIdentity(docs),
    };
  }

  async loadFull(
    cycleId: string,
    tenantId?: string,
  ): Promise<Partial<DecisionContext>> {
    const query: Record<string, unknown> = { cycleId };
    if (tenantId) query.tenantId = tenantId;
    const docs = await this.model.find(query).lean().exec();
    const out: Partial<DecisionContext> = {};
    for (const doc of docs) {
      (out as Record<string, unknown>)[doc.engine] = doc.slice;
    }
    return out;
  }

  /**
   * Resolve the immutable tenant/campaign identity stored beside every slice.
   * Useful for cycle-level views that have no decision document (a healthy or
   * fully-gated cycle still needs a campaign name in the UI).
   */
  async identityForCycle(
    cycleId: string,
    tenantId?: string,
  ): Promise<SliceIdentity | null> {
    if (typeof cycleId !== 'string' || cycleId.trim().length === 0) return null;
    if (
      tenantId !== undefined &&
      (typeof tenantId !== 'string' || tenantId.trim().length === 0)
    ) {
      return null;
    }

    const query: Record<string, unknown> = {
      cycleId,
      campaignId: { $type: 'string', $ne: '' },
    };
    query.tenantId = tenantId ?? { $type: 'string', $ne: '' };
    const docs = await this.model
      .find(query)
      .select({ tenantId: 1, campaignId: 1 })
      .sort({ writtenAt: 1, _id: 1 })
      .lean()
      .exec();
    return this.resolveConsistentIdentity(docs);
  }

  private resolveConsistentIdentity(
    docs: Array<{ tenantId?: unknown; campaignId?: unknown }>,
  ): SliceIdentity | null {
    let resolved: SliceIdentity | null = null;

    for (const doc of docs) {
      const candidate = {
        tenantId: doc.tenantId,
        campaignId: doc.campaignId,
      } as SliceIdentity;
      if (!isValidSliceIdentity(candidate)) continue;

      if (
        resolved &&
        (resolved.tenantId !== candidate.tenantId ||
          resolved.campaignId !== candidate.campaignId)
      ) {
        throw new Error(
          'Conflicting persisted identities for intelligence cycle',
        );
      }
      resolved = candidate;
    }

    return resolved;
  }

  async hasSlices(
    cycleId: string,
    engines: readonly EngineSliceKey[],
  ): Promise<boolean> {
    if (engines.length === 0) return true;
    const count = await this.model.countDocuments({
      cycleId,
      engine: { $in: engines as EngineSliceKey[] },
    });
    return count === engines.length;
  }
}
