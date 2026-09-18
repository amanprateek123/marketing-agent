import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  GalleryTopic,
  GalleryTopicSchema,
} from './schemas/gallery-topic.schema';
import {
  GallerySheet,
  GallerySheetSchema,
} from './schemas/gallery-sheet.schema';
import {
  GalleryAsset,
  GalleryAssetSchema,
} from './schemas/gallery-asset.schema';
import {
  CreativePackage,
  CreativePackageSchema,
} from '../creative/schemas/creative-package.schema';
import { GalleryService } from './gallery.service';
import { GalleryController } from './gallery.controller';

/**
 * Own leaf module (no dependency on CreativeModule/CampaignsModule) so both
 * can import GalleryService without a circular dependency — CreativeModule
 * already imports CampaignsModule directly (no forwardRef), so CampaignsModule
 * importing CreativeModule back for GalleryService would need forwardRef() on
 * both sides. GalleryService only ever needed these 4 Mongoose models.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GalleryTopic.name, schema: GalleryTopicSchema },
      { name: GallerySheet.name, schema: GallerySheetSchema },
      { name: GalleryAsset.name, schema: GalleryAssetSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
    ]),
  ],
  controllers: [GalleryController],
  providers: [GalleryService],
  exports: [GalleryService],
})
export class GalleryModule {}
