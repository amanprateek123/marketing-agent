import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ActionLogDocument = HydratedDocument<ActionLog>;

@Schema({ collection: 'action_logs', timestamps: true })
export class ActionLog {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ index: true })
  runId?: string;

  @Prop({ required: true })
  agent: string;

  @Prop({ required: true })
  action: string;

  @Prop({ required: true })
  reason: string;

  @Prop({ required: true })
  outcome: string;

  @Prop({ type: Object })
  metadata?: Record<string, any>;
}

export const ActionLogSchema = SchemaFactory.createForClass(ActionLog);
