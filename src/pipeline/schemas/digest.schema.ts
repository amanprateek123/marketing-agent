import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DigestDocument = HydratedDocument<Digest>;

@Schema({ collection: 'digests', timestamps: true })
export class Digest {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  // Full formatted digest content
  @Prop({ required: true })
  content: string;

  // Delivered to n8n?
  @Prop({ default: false })
  delivered: boolean;

  @Prop()
  deliveredAt?: Date;
}

export const DigestSchema = SchemaFactory.createForClass(Digest);
