import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CreativePackageDocument = HydratedDocument<CreativePackage>;

export interface CopyVariant {
  primaryText: string;
  headline: string;
  cta: string;
  hookStyle: string;
}

export interface ImageCreative {
  variantIndex: number;
  imagePrompt: string;
  imageUrl: string;
}

export interface VideoCreative {
  variantIndex: number;   // which copy variant this video was made for (selectedCopyIndex)
  videoPrompt: string;
  videoUrl: string;
  videoThumbnailUrl: string;
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

  // Images — one per copy variant (variantIndex matches copyVariants index)
  @Prop({ type: Array, default: [] })
  images: ImageCreative[];

  // Video — one, generated for the selected copy variant
  @Prop({ type: Object, default: null })
  video: VideoCreative | null;

  @Prop()
  error?: string;

  @Prop()
  approvedAt: Date;

  @Prop()
  completedAt?: Date;
}

export const CreativePackageSchema = SchemaFactory.createForClass(CreativePackage);
