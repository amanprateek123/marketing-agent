import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DecisionContext,
  EngineSliceKey,
} from '../orchestrator/decision-context';
import { EngineOutputDoc } from '../orchestrator/engine-output.schema';
import { EngineContext } from './engine-context';

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
    if (engines.length === 0) return {};
    const docs = await this.model
      .find({ cycleId, engine: { $in: engines as EngineSliceKey[] } })
      .lean()
      .exec();
    const out: Partial<DecisionContext> = {};
    for (const doc of docs) {
      (out as Record<string, unknown>)[doc.engine] = doc.slice;
    }
    return out;
  }

  async loadFull(cycleId: string): Promise<Partial<DecisionContext>> {
    const docs = await this.model.find({ cycleId }).lean().exec();
    const out: Partial<DecisionContext> = {};
    for (const doc of docs) {
      (out as Record<string, unknown>)[doc.engine] = doc.slice;
    }
    return out;
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
