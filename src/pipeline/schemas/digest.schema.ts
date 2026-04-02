import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DigestDocument = HydratedDocument<Digest>;

@Schema({ collection: 'digests', timestamps: true })
export class Digest {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  // 'signals' = market signals summary, 'idea' = content idea brief, 'cta' = next step
  @Prop({ required: true, enum: ['signals', 'idea', 'cta'], index: true })
  type: string;

  // For idea type: the briefId this digest entry belongs to
  @Prop()
  briefId?: string;

  // For idea type: position (1-N) among all ideas this run
  @Prop()
  ideaIndex?: number;

  // Whether this idea is the system-recommended one
  @Prop({ default: false })
  recommended: boolean;

  // Full formatted content for this digest entry
  @Prop({ required: true })
  content: string;

  @Prop({ default: false })
  delivered: boolean;

  @Prop()
  deliveredAt?: Date;
}

export const DigestSchema = SchemaFactory.createForClass(Digest);
