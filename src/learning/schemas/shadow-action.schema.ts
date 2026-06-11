import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShadowActionDocument = HydratedDocument<ShadowAction>;

/**
 * Shadow action — an action the LLM proposed but a TS guard blocked or downgraded.
 * The system later joins each record to campaign metrics at +24h / +72h to label
 * whether the block was correct (the metric improved or stayed flat) or wrong
 * (the underlying problem persisted, suggesting the guard was too conservative).
 *
 * After ~2 weeks of accumulation, query: regret rate per (action_type, blocked_reason)
 * → first quantitative answer to "are our guardrails correctly tuned?"
 *
 * Pure logging today — no behavior change. Behavior changes (e.g. relaxing a
 * guard if regret > 30%) only after ground-truth data exists.
 */
@Schema({ collection: 'shadow_actions', timestamps: true })
export class ShadowAction {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  campaignId: string;

  @Prop({ required: true })
  metaCampaignId: string;

  // The action that was proposed (verbatim from the LLM, before TS dropped it)
  @Prop({ required: true, type: Object })
  proposedAction: {
    type: string;
    targetId: string;
    targetName?: string;
    reason?: string;
    priority?: string;
    params?: Record<string, any>;
  };

  // Why it was blocked
  @Prop({ required: true, enum: [
    'recipient_thin_evidence',          // shift_budget recipient < MIN_RECIPIENT_CONVERSIONS
    'recipient_learned_poor_audience',  // shift_budget recipient audience has learned ROAS < breakeven (n>=3, product scope)
    'timing_guard_day_0_3',             // pause/throttle blocked in first 72h
    'timing_guard_day_3_7_growth',      // growth actions blocked before day 7
    'early_pause_thin_evidence',        // day 0-3 pause on 0 conv with < half the vertical click floor
    'oscillation_cooldown',             // budget-direction reversal against an action executed <72h ago
    'tz_guard_dayparting',              // dayparting on non-IST account
    'donor_floor_shift_budget',         // donor at MIN_DONOR_FLOOR_PCT
    'recipient_cap_shift_budget',       // recipient at MAX_RECIPIENT_PCT
    'parser_validation',                // parser dropped malformed action params
    'bandit_disagreement',              // LLM picked a recipient different from Thompson leader (action still ran)
    'other',
  ] })
  blockedReason: string;

  @Prop({ required: true })
  blockedAt: Date;

  // Campaign metrics at the moment of blocking — anchor for the +24h/+72h comparison
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
  };

  // Filled by the evaluator at +24h
  @Prop({ type: Object, default: null })
  metricsAtT24h: any | null;

  // Filled by the evaluator at +72h
  @Prop({ type: Object, default: null })
  metricsAtT72h: any | null;

  // Evaluator verdict — assigned 72h after the block. Compares the metric the
  // proposed action was meant to address against where it actually went without intervention.
  // - correct_block: the underlying metric improved or held → block was right
  // - missed_signal: the underlying metric got worse → block was wrong, action would have helped
  // - inconclusive: not enough subsequent data (campaign paused, ad set deleted, etc.)
  // Explicit type:String — TS reflection can't pick a single type from
  // ('correct_block' | 'missed_signal' | 'inconclusive' | null), so @Prop()
  // throws CannotDetermineTypeError at decoration time on newer Node + reflect-metadata.
  @Prop({ type: String, enum: ['correct_block', 'missed_signal', 'inconclusive', null], default: null })
  regretLabel: 'correct_block' | 'missed_signal' | 'inconclusive' | null;

  @Prop({ type: Date, default: null })
  evaluatedAt: Date | null;

  // Schedule fields
  @Prop({ required: true, index: true })
  evaluateAt24h: Date;

  @Prop({ required: true, index: true })
  evaluateAt72h: Date;

  @Prop({ type: String, default: 'pending', enum: ['pending', 'evaluated_24h', 'evaluated_72h', 'final'] })
  status: 'pending' | 'evaluated_24h' | 'evaluated_72h' | 'final';
}

export const ShadowActionSchema = SchemaFactory.createForClass(ShadowAction);
