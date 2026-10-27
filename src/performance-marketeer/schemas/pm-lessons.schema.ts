import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type {
  PmLesson,
  PmLessonCase,
  PmLessonClaim,
  PmLessonDeltaOp,
  PmLessonProposal,
  PmLessonScope,
  PmLessonStatus,
  PmLessonType,
  PmOwnerRule,
} from '../agent/lessons/lessons.types';

/**
 * Lessons storage (docs/performance-marketeer/10-lessons.md). Class names end
 * in "Doc" because the plain names are the shared interfaces in lessons.types.
 */
@Schema({ collection: 'pm_lessons', timestamps: true })
export class PmLessonDoc implements Omit<PmLesson, 'createdAt'> {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) lessonId: string;
  @Prop({ required: true }) type: PmLessonType;
  @Prop({ required: true }) statement: string;
  @Prop() because?: string;
  @Prop({ type: Object, default: {} }) scope: PmLessonScope;
  @Prop({ type: Object, required: true }) claim: PmLessonClaim;
  @Prop({ required: true, default: 'candidate' }) status: PmLessonStatus;
  @Prop({ type: [Object], default: [] }) cases: PmLessonCase[];
  @Prop({ default: 0.2 }) confidence: 0.2 | 0.5 | 0.8;
  /** Graded uses (a later clean outcome said hit or miss). */
  @Prop({ default: 0 }) uses: number;
  @Prop({ default: 0 }) hits: number;
  @Prop({ default: 1 }) version: number;
  @Prop() approvedAt?: string;
  @Prop() reviewBy?: string;
  /** YYYY-MM-DD the lesson was created (candidate expiry counts from here). */
  @Prop() createdAt?: string;
}
export const PmLessonSchema = SchemaFactory.createForClass(PmLessonDoc);
PmLessonSchema.index({ tenantId: 1, lessonId: 1 }, { unique: true });
PmLessonSchema.index({ tenantId: 1, status: 1, type: 1 });

export type PmLessonEventKind =
  | 'proposed'
  | 'applied'
  | 'approved'
  | 'rejected'
  | 'used'
  | 'hit'
  | 'miss'
  | 'attached'
  | 'status_change'
  | 'edited'
  | 'merged'
  | 'retired';

/** Append-only audit log of everything that happens to a lesson. */
@Schema({ collection: 'pm_lesson_events' })
export class PmLessonEventDoc {
  @Prop({ required: true }) tenantId: string;
  /** '' for events about a proposal that has no lesson yet. */
  @Prop({ default: '' }) lessonId: string;
  @Prop({ required: true }) kind: PmLessonEventKind;
  @Prop({ required: true }) by: 'code' | 'curator' | 'user';
  @Prop({ type: Object, default: {} }) payload: Record<string, unknown>;
  @Prop({ type: Date, default: () => new Date() }) at: Date;
}
export const PmLessonEventSchema =
  SchemaFactory.createForClass(PmLessonEventDoc);
PmLessonEventSchema.index({ tenantId: 1, lessonId: 1, at: -1 });
PmLessonEventSchema.index({ tenantId: 1, kind: 1, at: -1 });

@Schema({ collection: 'pm_lesson_proposals', timestamps: true })
export class PmLessonProposalDoc implements PmLessonProposal {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) proposalId: string;
  @Prop({ required: true }) week: string;
  @Prop({ required: true }) op: PmLessonDeltaOp | 'PROMOTE';
  @Prop({ type: Object }) lesson?: Partial<PmLesson>;
  @Prop() lessonId?: string;
  @Prop({ type: [String] }) mergeIds?: string[];
  @Prop({ type: [Object] }) cases?: PmLessonCase[];
  @Prop({ default: '' }) why: string;
  @Prop({ type: Object, default: { ok: true, problems: [] } })
  validation: { ok: boolean; problems: string[] };
  @Prop({ type: String, required: true }) status: PmLessonProposal['status'];
  @Prop() decidedAt?: string;
  @Prop() decidedNote?: string;
}
export const PmLessonProposalSchema =
  SchemaFactory.createForClass(PmLessonProposalDoc);
PmLessonProposalSchema.index({ tenantId: 1, proposalId: 1 }, { unique: true });
PmLessonProposalSchema.index({ tenantId: 1, status: 1, week: -1 });

@Schema({ collection: 'pm_owner_rules', timestamps: true })
export class PmOwnerRuleDoc implements PmOwnerRule {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) ruleId: string;
  @Prop({ required: true }) text: string;
  @Prop({ default: true }) active: boolean;
  @Prop({ type: Object }) check?: PmOwnerRule['check'];
}
export const PmOwnerRuleSchema = SchemaFactory.createForClass(PmOwnerRuleDoc);
PmOwnerRuleSchema.index({ tenantId: 1, ruleId: 1 }, { unique: true });
