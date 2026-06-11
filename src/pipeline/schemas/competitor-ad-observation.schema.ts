import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CompetitorAdObservationDocument = HydratedDocument<CompetitorAdObservation>;

/**
 * Cross-run persistence tracking for competitor hooks/offers.
 *
 * The Ads Library agent observes each competitor's hero hook fresh every run
 * and (honestly) reports estimatedDaysRunning=0 — it can't see longevity from
 * one visit. But WE can: a hook observed in run N and again in run N+2 has
 * survived weeks of the competitor's own optimization, which is the strongest
 * proof-of-performance available without their ad account. Each run upserts
 * its observations here; longevity = lastSeenAt − firstSeenAt when the hook
 * has been seen in ≥2 distinct runs.
 *
 * One doc per (tenantId, hookKey). hookKey is a normalized competitor+hook
 * string so minor punctuation/casing drift between fetches still matches.
 */
@Schema({ collection: 'competitor_ad_observations', timestamps: true })
export class CompetitorAdObservation {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true })
  hookKey: string;

  @Prop({ required: true })
  competitor: string;

  // Latest observed values (hooks evolve slightly between fetches — keep current)
  @Prop({ required: true })
  hook: string;

  @Prop({ default: '' })
  angle: string;

  @Prop({ default: 'unknown' })
  format: string;

  @Prop({ default: '' })
  cta: string;

  @Prop({ required: true })
  firstSeenAt: Date;

  @Prop({ required: true })
  lastSeenAt: Date;

  // Distinct pipeline runs that observed this hook
  @Prop({ default: 1 })
  timesSeen: number;

  @Prop({ default: '' })
  lastRunId: string;
}

export const CompetitorAdObservationSchema = SchemaFactory.createForClass(CompetitorAdObservation);

CompetitorAdObservationSchema.index({ tenantId: 1, hookKey: 1 }, { unique: true });
// Observations not re-seen in 120 days are stale — the competitor moved on.
CompetitorAdObservationSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });
