import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EngineSliceKey } from './decision-context';

export type EngineOutputDocument = HydratedDocument<EngineOutputDoc>;

/**
 * intelligence_engine_outputs — one doc per (cycleId, engine).
 * The slice payload (EngineContext<T>) is written here by BaseEngine
 * after compute() succeeds. Never edited in place; replays create new
 * (cycleId, engine) tuples.
 */
@Schema({ collection: 'intelligence_engine_outputs', timestamps: true })
export class EngineOutputDoc {
  @Prop({ required: true, index: true })
  cycleId!: string;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  campaignId!: string;

  @Prop({ required: true })
  engine!: EngineSliceKey;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  slice!: Record<string, unknown>;

  @Prop({ required: true })
  writtenAt!: Date;
}

export const EngineOutputSchema = SchemaFactory.createForClass(EngineOutputDoc);

// Unique per cycle × engine — the atomic-write guarantee.
EngineOutputSchema.index({ cycleId: 1, engine: 1 }, { unique: true });

// History queries: latest slice per campaign per engine.
EngineOutputSchema.index({ tenantId: 1, campaignId: 1, engine: 1, writtenAt: -1 });
