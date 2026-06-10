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

/**
 * One slide of a Meta carousel ad. Carousel-format briefs produce N (3-5
 * typical, 10 hard max) of these as a coherent sequence. Order matters —
 * carousel-launch keeps Meta's multi_share_optimized=false so step 1 → step 2
 * → step 3 narratives don't get re-sequenced. imageHash is populated at launch
 * time after the carousel images upload to Meta; imageUrl is the S3 URL the
 * Creative Team / image generator produced.
 */
export interface CarouselCard {
  slotIndex: number;            // 0-based position in the carousel
  headline: string;             // card "name" — bold text below the image (~25 char)
  description?: string;         // smaller text under the headline (~30 char), optional
  imagePrompt: string;          // prompt that generated this card's image
  imageUrl: string;             // S3 URL of the generated card image
  imageHash?: string;           // Meta image_hash, populated at upload time
  cardLink?: string;            // optional per-card link override (defaults to package landingUrl)
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

  /**
   * Carousel cards — only populated when brief.format === 'carousel'. Empty
   * array for single-image / video / mixed briefs. When non-empty, the launch
   * path uses these instead of `images[]` to build a multi-slide ad.
   */
  @Prop({ type: Array, default: [] })
  carouselCards: CarouselCard[];

  // Heygen video ID — persisted as soon as rendering starts so polling can resume if it times out
  @Prop({ type: String, default: null })
  heygenVideoId: string | null;

  @Prop()
  error?: string;

  @Prop()
  approvedAt: Date;

  @Prop()
  completedAt?: Date;
}

export const CreativePackageSchema = SchemaFactory.createForClass(CreativePackage);
