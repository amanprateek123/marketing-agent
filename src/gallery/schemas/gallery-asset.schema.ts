import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GalleryAssetDocument = HydratedDocument<GalleryAsset>;

export type GalleryAssetType = 'image' | 'video' | 'carousel_card';

/**
 * A movable pointer at ONE creative variant (one image, the package's video,
 * or one carousel card) inside a CreativePackage — never the asset's data
 * itself. Deliberately has NO denormalized imageUrl/thumbnail: regenerate/edit
 * endpoints would make a cached URL go stale, and there are too many
 * mutation call-sites to keep in sync reliably. Every read resolves the
 * current URL live off the referenced CreativePackage instead (see
 * GalleryService.resolveAssets) — if the source package or variant is gone,
 * the asset just fails to resolve rather than showing stale data.
 *
 * Moving an asset to a different sheet (even in a different topic) is
 * purely `sheetId` changing here — sourcePackageId/variantIndex/assetType
 * never change after creation, so lineage back to the original generation
 * always holds.
 */
@Schema({ collection: 'gallery_assets', timestamps: true })
export class GalleryAsset {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  sheetId: string;

  @Prop({ required: true, enum: ['image', 'video', 'carousel_card'] })
  assetType: GalleryAssetType;

  @Prop({ required: true, index: true })
  sourcePackageId: string;

  // Index into images[]/carouselCards[] on the source package. Unused (0)
  // for assetType==='video' since a package has only one primary `video`.
  @Prop({ required: true, default: 0 })
  variantIndex: number;
}

export const GalleryAssetSchema = SchemaFactory.createForClass(GalleryAsset);
