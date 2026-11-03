import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type {
  LaunchCreativeFile,
  LaunchEconomics,
  LaunchInput,
  LaunchPlanOutput,
  LaunchReadiness,
  LaunchResearch,
  LaunchReview,
  LaunchTracking,
} from '../agent/launch/launch.types';

/** One Launch Planner run: the input, what the AI proposed, and what was created in Meta (doc 11). */
@Schema({ collection: 'pm_launch_plans', timestamps: true })
export class PmLaunchPlan {
  @Prop({ required: true, index: true }) tenantId: string;
  @Prop({ type: Object, required: true }) input: LaunchInput;
  @Prop({ required: true, default: 'queued', index: true })
  status: 'queued' | 'running' | 'done' | 'failed';
  @Prop({ default: '' }) step: string;
  @Prop({ default: '' }) error: string;
  @Prop({ default: '' }) createdBy: string;
  @Prop({ default: 0 }) costUsd: number;
  @Prop({ type: Date, default: null }) heartbeatAt: Date | null;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;

  @Prop({ type: Array, default: [] }) creatives: LaunchCreativeFile[];
  @Prop({ type: Object, default: null }) economics: LaunchEconomics | null;
  @Prop({ type: Object, default: null }) tracking: LaunchTracking | null;
  @Prop({ type: Object, default: null }) review: LaunchReview | null;
  @Prop({ type: Object, default: null }) research: LaunchResearch | null;
  @Prop({ type: Object, default: null }) plan: LaunchPlanOutput | null;
  @Prop({ type: Object, default: null }) readiness: LaunchReadiness | null;
  /** Code problems at the end of the plan loop; they count as blocks at every check. */
  @Prop({ type: [String], default: [] }) planProblems: string[];
  @Prop({ type: [String], default: [] }) planWarnings: string[];
  @Prop({ type: [String], default: [] }) openIssues: string[];
  /** Reviewer issues of blocker severity left after the last round; they block creation. */
  @Prop({ type: [String], default: [] }) reviewerBlocks: string[];

  /** '' until the admin creates it; the atomic move to 'creating' stops a double click. */
  @Prop({ default: '' }) createStatus: '' | 'creating' | 'paused' | 'failed';
  @Prop({ default: '' }) createError: string;
  @Prop({ type: Date, default: null }) createStartedAt: Date | null;
  /** Our Campaign document; a retry reuses it instead of making another. */
  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: '' }) metaCampaignId: string;
  /** Exactly what was approved: the request, checklist, who, when, and what Meta reported. */
  @Prop({ type: Object, default: null }) approved: Record<
    string,
    unknown
  > | null;
}
export type PmLaunchPlanDocument = HydratedDocument<PmLaunchPlan>;
export const PmLaunchPlanSchema = SchemaFactory.createForClass(PmLaunchPlan);
