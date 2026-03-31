import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { AgentType, ClaudeModel } from '../claude.types';

export type UsageLogDocument = HydratedDocument<UsageLog>;

@Schema({ collection: 'usage_logs', timestamps: false })
export class UsageLog {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ index: true })
  runId?: string;

  @Prop({ required: true, enum: AgentType })
  agent: AgentType;

  @Prop({ required: true })
  claudeModel: ClaudeModel;

  @Prop({ default: 0 })
  inputTokens: number;

  @Prop({ default: 0 })
  outputTokens: number;

  @Prop({ default: 0 })
  costUSD: number;

  @Prop({ required: true, default: () => new Date() })
  timestamp: Date;
}

export const UsageLogSchema = SchemaFactory.createForClass(UsageLog);
