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
  editInstructions?: string[];  // free-text tweaks applied via edit-image, most recent last
  aspectRatio?: string;   // '9:16' | '1:1' | '4:5' — what was requested at generation time
  resolution?: string;    // '1K' | '2K' | '4K'
}

export interface VideoCreative {
  variantIndex: number;   // which copy variant this video was made for (selectedCopyIndex)
  videoPrompt: string;
  videoUrl: string;
  videoThumbnailUrl: string;
  aspectRatio?: string;   // '9:16' | '16:9' | '1:1' | '4:5' — what was requested at generation time
  resolution?: string;    // '720p' | '1080p' | '4k'
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

  // Which product/language this package was generated for — stamped by
  // CreativeProducerService.produce() from the resolved brief, so the
  // creative library can be browsed/filtered without re-reading the brief.
  @Prop({ default: '' })
  productName?: string;

  @Prop({ default: '' })
  targetLanguage?: string;

  // Copy
  @Prop({ type: Array, default: [] })
  copyVariants: CopyVariant[];

  @Prop({ default: 0 })
  selectedCopyIndex: number;

  @Prop({ default: '' })
  copySelectionReason: string;

  // Images — usually one per copy variant (variantIndex matches copyVariants
  // index), but a variant MAY carry more than one entry when tagged with
  // different aspectRatio values — e.g. a human creative team supplying
  // both a 9:16 and a 4:5 size for the same variant. launch() (via
  // MetaAdsService.buildImageAssetFeedSpec) uses Meta's placement asset
  // customization in that case instead of auto-cropping a single image.
  @Prop({ type: Array, default: [] })
  images: ImageCreative[];

  // Video — one, generated for the selected copy variant. Still the only
  // field the Heygen/AI generation path ever writes.
  @Prop({ type: Object, default: null })
  video: VideoCreative | null;

  /**
   * Additive to `video` — multiple pre-made sizes of the SAME video (e.g. a
   * human creative team supplying both a 9:16 and a 1:1 cut). When non-empty,
   * launch() uses these instead of `video` and, if 2+ distinct sizes upload
   * successfully, ships them via Meta's placement asset customization
   * (MetaAdsService.buildVideoAssetFeedSpec) instead of one auto-cropped
   * video. Global to the package, not per-variant — matches how `video`
   * already worked (one video, reused across whichever variants ship as
   * video ads).
   */
  @Prop({ type: Array, default: [] })
  videos: VideoCreative[];

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
