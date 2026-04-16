import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CreativePackageDocument = HydratedDocument<CreativePackage>;

export interface CopyVariant {
  primaryText: string;
  headline: string;
  cta: string;
  hookStyle: string;
}

@Schema({ collection: 'creative_packages', timestamps: true })
export class CreativePackage {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, index: true })
  briefId: string;

  @Prop({ required: true, enum: ['pending', 'completed', 'failed'], default: 'pending' })
  status: string;

  // Copy
  @Prop({ type: Array, default: [] })
  copyVariants: CopyVariant[];

  @Prop({ default: 0 })
  selectedCopyIndex: number;

  @Prop({ default: '' })
  copySelectionReason: string;

  // Image
  @Prop({ default: '' })
  imagePrompt: string;

  @Prop({ default: '' })
  imageUrl: string;

  // Video (deferred — prompt stored now, URL added when fal.ai key available)
  @Prop({ default: '' })
  videoPrompt: string;

  @Prop({ default: '' })
  videoUrl: string;

  @Prop({ default: '' })
  videoThumbnailUrl: string;

  @Prop()
  error?: string;

  @Prop()
  approvedAt: Date;

  @Prop()
  completedAt?: Date;
}

export const CreativePackageSchema = SchemaFactory.createForClass(CreativePackage);
