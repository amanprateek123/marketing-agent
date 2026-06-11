import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ExecutedActionDocument = HydratedDocument<ExecutedAction>;

/**
 * Executed action — an optimizer action that actually ran (auto-applied,
 * grace-expired, or human-approved). Counterpart to ShadowAction, which only
 * covers actions a TS guard BLOCKED. Without this record the system measures
 * the counterfactual of things it didn't do but never the consequence of
 * things it did — executed scale/pause/shift decisions were write-only.
 *
 * Each record is joined to campaign metrics at +24h / +72h and labeled:
 *   - improved:     the metric the action targeted moved the right way
 *   - worsened:     it moved the wrong way — this action hurt in this context
 *   - neutral:      enough subsequent spend, no meaningful move either way
 *   - inconclusive: not enough subsequent data to judge
 *
 * Finalized labels aggregate into the per-tenant ACTION TRACK RECORD that the
 * audit agent reads before recommending the same action types again.
 */
@Schema({ collection: 'executed_actions', timestamps: true })
export class ExecutedAction {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  campaignId: string;

  @Prop({ required: true })
  metaCampaignId: string;

  // The action as it ran (verbatim from pendingActions)
  @Prop({ required: true, type: Object })
  action: {
    type: string;
    targetId: string;
    targetName?: string;
    reason?: string;
    priority?: string;
    params?: Record<string, any>;
  };

  // How the action came to run
  @Prop({ required: true, enum: ['auto_applied', 'grace_expired', 'human_approved'] })
  trigger: string;

  // Decision context captured at execution time — used to bucket outcomes
  // ("scale_adset on day-2 campaigns worsens CPA" needs ageDays, not just type)
  @Prop({ type: Object, default: {} })
  context: {
    ageDays?: number;
    productName?: string;
    audienceType?: string;
    // Ad set the action's effect should be measured on (targetId is an AD id
    // for replace_creative, so the evaluator can't always derive this itself)
    targetAdSetId?: string;
  };

  @Prop({ required: true })
  executedAt: Date;

  // Campaign metrics at the moment of execution — anchor for the +24h/+72h delta.
  // Loose Object: includes per-ad-set rows (adSets[]) like ShadowAction.metricsAtT.
  @Prop({ type: Object, required: true })
  metricsAtT: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpc: number;
    cpa: number;
    roas: number;
    frequency: number;
    adSets?: Array<{
      adSetId: string;
      spend: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cpa: number;
    }>;
  };

  @Prop({ type: Object, default: null })
  metricsAtT24h: any | null;

  @Prop({ type: Object, default: null })
  metricsAtT72h: any | null;

  // Explicit type:String — same CannotDetermineTypeError workaround as
  // ShadowAction.regretLabel (union-with-null defeats TS reflection).
  @Prop({ type: String, enum: ['improved', 'worsened', 'neutral', 'inconclusive', null], default: null })
  outcomeLabel: 'improved' | 'worsened' | 'neutral' | 'inconclusive' | null;

  @Prop({ type: Date, default: null })
  evaluatedAt: Date | null;

  @Prop({ required: true, index: true })
  evaluateAt24h: Date;

  @Prop({ required: true, index: true })
  evaluateAt72h: Date;

  @Prop({ type: String, default: 'pending', enum: ['pending', 'evaluated_24h', 'final'] })
  status: 'pending' | 'evaluated_24h' | 'final';
}

export const ExecutedActionSchema = SchemaFactory.createForClass(ExecutedAction);
