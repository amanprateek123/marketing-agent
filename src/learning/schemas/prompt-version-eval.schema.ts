import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PromptVersionEvalDocument = HydratedDocument<PromptVersionEval>;

/**
 * One eval per (tenant, learning cycle): did campaigns created under the
 * newest prompt version outperform the version before it?
 *
 * This is the missing feedback on the learning loop itself. promptsVersion
 * bumps after every Day-30 deep run and campaigns snapshot it at create time,
 * but nothing ever compared outcomes across versions — a poisoned learning
 * cycle (one bad causal "insight" rewriting every agent prompt) would degrade
 * campaigns indefinitely with no detection. A 'regressed' verdict is the
 * signal to inspect promptsHistory and consider revertPrompts().
 */
@Schema({ collection: 'prompt_version_evals', timestamps: true })
export class PromptVersionEval {
  @Prop({ required: true, index: true })
  tenantId: string;

  // The two versions compared (the two most recent versions WITH campaign data)
  @Prop({ required: true })
  newerVersion: number;

  @Prop({ required: true })
  olderVersion: number;

  @Prop({ type: Object, required: true })
  newer: {
    campaigns: number;
    totalSpend: number;
    totalConversions: number;
    weightedROAS: number;   // sum(roas×spend)/sum(spend) = revenue/spend
    cpa: number;
  };

  @Prop({ type: Object, required: true })
  older: {
    campaigns: number;
    totalSpend: number;
    totalConversions: number;
    weightedROAS: number;
    cpa: number;
  };

  @Prop({ required: true, enum: ['improved', 'regressed', 'neutral', 'inconclusive'] })
  verdict: string;

  @Prop({ default: '' })
  detail: string;
}

export const PromptVersionEvalSchema = SchemaFactory.createForClass(PromptVersionEval);

PromptVersionEvalSchema.index({ tenantId: 1, createdAt: -1 });
