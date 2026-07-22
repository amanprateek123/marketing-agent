import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GalleryTopicDocument = HydratedDocument<GalleryTopic>;

/**
 * Top-level grouping for the creative gallery — one per distinct topic a
 * creative was generated under (auto-created by GalleryService.autoPopulate,
 * find-or-create on brief.topic). Mirrors a Google Sheets "workbook": holds
 * GallerySheets, which hold GalleryAssets.
 */
@Schema({ collection: 'gallery_topics', timestamps: true })
export class GalleryTopic {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true })
  name: string;
}

export const GalleryTopicSchema = SchemaFactory.createForClass(GalleryTopic);
