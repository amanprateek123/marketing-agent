import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type {
  Action,
  Cause,
  LessonContradiction,
  PmJournalEntry,
} from '../agent/pm-agent.types';
import type { PmSituation } from '../agent/lessons/lessons.types';

/**
 * One campaign's pipeline run for one day (docs/performance-marketeer/09).
 * The .md files live on disk while the run works; their final text is copied
 * here so the dashboard and the next day's journal never depend on the disk.
 */
@Schema({ collection: 'pm_agent_runs', timestamps: true })
export class PmAgentRun {
  @Prop({ required: true }) tenantId: string;
  /** Run date YYYY-MM-DD (IST). Data runs to the day before. */
  @Prop({ required: true }) date: string;
  @Prop({ required: true }) campaignId: string;
  @Prop({ default: '' }) campaignName: string;
  @Prop({ default: '' }) accountId: string;
  @Prop({ default: 'other' }) product: string;
  @Prop({ default: 'queued' }) status: 'queued' | 'running' | 'done' | 'failed';
  /** Which phase/round is running or failed, e.g. "verify v2". */
  @Prop({ default: '' }) step: string;
  @Prop({ default: '' }) error: string;
  @Prop({ default: 0 }) investigateRounds: number;
  @Prop({ default: 0 }) planRounds: number;
  /** Loops that hit the send-back cap: their open issues are listed as unresolved. */
  @Prop({ type: [String], default: [] }) unresolved: string[];
  /** Final approved actions (from the last plan, minus rejected ones). The journal matches these. */
  @Prop({ type: [Object], default: [] }) actions: (Action & {
    verdict: 'approve' | 'change' | 'unresolved';
    rank: number;
    /** A cause behind it where investigator and verifier are two bins apart. */
    disputed?: boolean;
    /** Names of code checks (05-checks.md) this action failed. */
    checksFailed?: string[];
    /** Action-type track record factor used in the rank (1 = no record). */
    hitRateFactor?: number;
  })[];
  /** Final merged causes (after verify): merged confidence, verdict, disputed, lessonIds. */
  @Prop({ type: [Object], default: [] }) causes: (Cause & {
    investigatorConfidence: number | null;
    verifierConfidence: number | null;
    verdict: 'confirmed' | 'weakened' | 'rejected' | 'added' | 'unverified';
    disputed: boolean;
    rank: number;
    capNote?: string;
  })[];
  /** The campaign's situation computed once at run start (picks lessons; decision context). */
  @Prop({ type: Object, default: null }) situation: PmSituation | null;
  /** Lesson ids cited by the final causes and actions. */
  @Prop({ type: [String], default: [] }) lessonsUsed: string[];
  /** Lessons contradicted in any final phase output, merged by id. */
  @Prop({ type: [Object], default: [] })
  lessonsContradicted: LessonContradiction[];
  /** ₹/day of all final actions, for the roll-up ordering. */
  @Prop({ default: 0 }) impactRupeesPerDay: number;
  /** File name → final text (00-brief.md … 05-actions.md, evidence.jsonl). */
  @Prop({ type: Object, default: {} }) files: Record<string, string>;
  /** The journal as built for this run. */
  @Prop({ type: [Object], default: [] }) journal: PmJournalEntry[];
  /** Optional note from the user about this run's actions ("did A2, skipped A3 because …"). */
  @Prop({ default: '' }) userNote: string;
  @Prop({ default: 0 }) costUsd: number;
  /** Cost of earlier attempts wiped by a rerun; still counts toward the daily cap. */
  @Prop({ default: 0 }) priorCostUsd: number;
  /** Queue (agent/pipeline/pm-agent-queue.service.ts): when and by whom it was queued. */
  @Prop({ type: Date, default: null }) queuedAt: Date | null;
  @Prop({ default: '' }) queuedBy: string;
  /** Bumped every step and every few minutes while running; stale → requeued. */
  @Prop({ type: Date, default: null }) heartbeatAt: Date | null;
  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
}
export type PmAgentRunDocument = HydratedDocument<PmAgentRun>;
export const PmAgentRunSchema = SchemaFactory.createForClass(PmAgentRun);
PmAgentRunSchema.index(
  { tenantId: 1, campaignId: 1, date: 1 },
  { unique: true },
);
PmAgentRunSchema.index({ tenantId: 1, date: 1, impactRupeesPerDay: -1 });
PmAgentRunSchema.index({ tenantId: 1, status: 1, queuedAt: 1 });
