import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type {
  PmDecisionRecord as Decision,
  PmDiagnosisCheck as Diagnosis,
  PmOutcomeRecord as Outcome,
  PmOutcomeVerdict,
  PmSituation,
} from '../agent/lessons/lessons.types';

/**
 * Lesson records (docs/performance-marketeer/10-lessons.md, "Records"):
 * written by code only (agent/lessons/records.service.ts), append-only —
 * a decision's taken status may still be filled in while its match window
 * is open; outcomes and diagnosis checks are never rewritten.
 */

/** One change, ours (`recommended`) or not (`outside`), with its context snapshot. */
@Schema({ collection: 'pm_decisions', timestamps: true })
export class PmDecisionRecord implements Decision {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) decisionId: string;
  @Prop({ type: String, required: true }) source: Decision['source'];
  /** YYYY-MM-DD (IST): change day if taken / outside, else run date. */
  @Prop({ required: true }) date: string;
  @Prop() runDate?: string;
  @Prop() actionId?: string;
  @Prop({ required: true }) campaignId: string;
  @Prop({ type: String, required: true }) entityLevel: Decision['entityLevel'];
  @Prop({ required: true }) entityId: string;
  @Prop({ default: '' }) entityName: string;
  @Prop({ required: true }) type: string;
  @Prop({ default: '' }) field: string;
  @Prop({ type: Object, default: null }) from: string | number | null;
  @Prop({ type: Object, default: null }) to: string | number | null;
  @Prop({ type: String }) direction?: 'up' | 'down';
  @Prop() step?: number;
  @Prop({ type: String, required: true }) taken: Decision['taken'];
  @Prop() changedAt?: string;
  @Prop() userNote?: string;
  @Prop({ type: Object, required: true }) context: PmSituation;
  @Prop({ type: [Object], default: [] }) causes: Decision['causes'];
  @Prop({ type: [String], default: [] }) lessonIds: string[];
  @Prop({ type: Object }) expected?: Decision['expected'];
}
export type PmDecisionRecordDocument = HydratedDocument<PmDecisionRecord>;
export const PmDecisionRecordSchema =
  SchemaFactory.createForClass(PmDecisionRecord);
PmDecisionRecordSchema.index({ tenantId: 1, decisionId: 1 }, { unique: true });
PmDecisionRecordSchema.index({ tenantId: 1, campaignId: 1, date: -1 });
PmDecisionRecordSchema.index({ tenantId: 1, date: -1, type: 1 });

/** A graded read of one decision: early (day 3) or settled (day 7). */
@Schema({ collection: 'pm_outcomes', timestamps: true })
export class PmOutcomeRecord implements Outcome {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) decisionId: string;
  @Prop({ type: String, required: true }) read: Outcome['read'];
  @Prop({ type: Object, required: true }) before: Outcome['before'];
  @Prop({ type: Object, required: true }) after: Outcome['after'];
  @Prop({ type: Object, required: true }) baseline: Outcome['baseline'];
  @Prop({ type: Object, required: true }) diffInDiff: Outcome['diffInDiff'];
  @Prop({ type: String, required: true }) verdict: PmOutcomeVerdict;
  @Prop({ type: [String], default: [] }) confounders: string[];
  @Prop({ type: Boolean, default: null }) insidePredictedRange: boolean | null;
  @Prop({ type: String, default: 'unknown' }) decisionQuality: Outcome['decisionQuality'];
  @Prop({ default: false }) weak: boolean;
  @Prop({ required: true }) gradedAt: string;
}
export type PmOutcomeRecordDocument = HydratedDocument<PmOutcomeRecord>;
export const PmOutcomeRecordSchema =
  SchemaFactory.createForClass(PmOutcomeRecord);
PmOutcomeRecordSchema.index(
  { tenantId: 1, decisionId: 1, read: 1 },
  { unique: true },
);
PmOutcomeRecordSchema.index({ tenantId: 1, gradedAt: -1 });
PmOutcomeRecordSchema.index({ tenantId: 1, verdict: 1, gradedAt: -1 });

/** Did a cause the analyst named hold up a week later? */
@Schema({ collection: 'pm_diagnosis_checks', timestamps: true })
export class PmDiagnosisCheck implements Diagnosis {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) checkId: string;
  @Prop({ required: true }) runDate: string;
  @Prop({ required: true }) campaignId: string;
  @Prop({ required: true }) causeId: string;
  @Prop({ required: true }) category: string;
  @Prop({ default: 0 }) confidence: number;
  @Prop({ type: String, required: true }) result: Diagnosis['result'];
  @Prop({ default: '' }) note: string;
  @Prop({ type: [String], default: [] }) lessonIds: string[];
  @Prop({ required: true }) checkedAt: string;
}
export type PmDiagnosisCheckDocument = HydratedDocument<PmDiagnosisCheck>;
export const PmDiagnosisCheckSchema =
  SchemaFactory.createForClass(PmDiagnosisCheck);
PmDiagnosisCheckSchema.index({ tenantId: 1, checkId: 1 }, { unique: true });
PmDiagnosisCheckSchema.index({ tenantId: 1, checkedAt: -1 });
PmDiagnosisCheckSchema.index({ tenantId: 1, category: 1, runDate: -1 });
