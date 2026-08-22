import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  CampaignCopilotBuildState,
  CampaignCopilotMessage,
  CampaignCopilotPlan,
  CampaignCopilotReadiness,
  CampaignCopilotRecommendations,
  CampaignCopilotSessionStatus,
  emptyCampaignCopilotBuildState,
  emptyCampaignCopilotPlan,
} from '../campaign-copilot.contracts';

export type CampaignCopilotSessionDocument =
  HydratedDocument<CampaignCopilotSession>;

@Schema({ collection: 'campaign_copilot_sessions', timestamps: true })
export class CampaignCopilotSession {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  sessionId: string;

  /** Optional browser idempotency key for the create-session request. */
  @Prop({ type: String, required: false })
  initialClientMessageId?: string;

  @Prop({
    required: true,
    enum: Object.values(CampaignCopilotSessionStatus),
    default: CampaignCopilotSessionStatus.COLLECTING,
    index: true,
  })
  status: CampaignCopilotSessionStatus;

  @Prop({ type: [Object], default: [] })
  messages: CampaignCopilotMessage[];

  @Prop({ type: Object, default: emptyCampaignCopilotPlan })
  plan: CampaignCopilotPlan;

  @Prop({ type: Object, default: null })
  recommendations: CampaignCopilotRecommendations | null;

  @Prop({ type: Object, default: null })
  readiness: CampaignCopilotReadiness | null;

  @Prop({ type: Object, default: emptyCampaignCopilotBuildState })
  build: CampaignCopilotBuildState;

  /** Immutable plan snapshot consumed by the async worker after confirmation. */
  @Prop({ type: Object, default: null })
  confirmedPlan: CampaignCopilotPlan | null;

  @Prop({ type: String, default: null })
  confirmedPlanHash: string | null;

  @Prop({ type: Date, default: null })
  confirmedAt: Date | null;

  /** Serialises user turns so two browser tabs cannot overwrite each other. */
  @Prop({ default: 0 })
  turnNumber: number;

  @Prop({ default: false })
  turnInProgress: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const CampaignCopilotSessionSchema = SchemaFactory.createForClass(
  CampaignCopilotSession,
);

CampaignCopilotSessionSchema.index(
  { tenantId: 1, sessionId: 1 },
  { unique: true },
);

CampaignCopilotSessionSchema.index(
  { tenantId: 1, initialClientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { initialClientMessageId: { $type: 'string' } },
  },
);
