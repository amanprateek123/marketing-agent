import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GallerySheetDocument = HydratedDocument<GallerySheet>;

/**
 * One tab within a GalleryTopic (mirrors a Google Sheets tab, e.g.
 * "Marriage", "Career", or the default "Unsorted" sheet every topic gets
 * auto-created with). Holds GalleryAssets — moving an asset between sheets
 * (even across topics) is just updating GalleryAsset.sheetId.
 */
@Schema({ collection: 'gallery_sheets', timestamps: true })
export class GallerySheet {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  topicId: string;

  @Prop({ required: true })
  name: string;
}

export const GallerySheetSchema = SchemaFactory.createForClass(GallerySheet);
