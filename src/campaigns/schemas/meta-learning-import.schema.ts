import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MetaLearningImportDocument = HydratedDocument<MetaLearningImport>;

@Schema({ collection: 'meta_learning_imports', timestamps: true })
export class MetaLearningImport {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({
    required: true,
    enum: ['pending', 'enriching', 'finalizing', 'completed', 'failed'],
    default: 'pending',
  })
  status: string;

  @Prop({ default: 0 })
  totalCampaigns: number;

  @Prop({ default: 0 })
  totalBatches: number;

  @Prop({ default: 0 })
  completedBatches: number;

  @Prop({ default: 0 })
  enrichedCount: number;

  @Prop({ default: 0 })
  caseStudyCount: number;

  @Prop({ type: [String], default: [] })
  conversionTypes: string[];

  /** Custom conversions fetched from Meta: [{id, name}] — used for product detection */
  @Prop({ type: [Object], default: [] })
  customConversions: { id: string; name: string }[];

  /** Raw campaign objects from Meta (lightweight — id, name, status, dates, budget) */
  @Prop({ type: [Object], default: [] })
  rawCampaigns: any[];

  @Prop()
  error?: string;

  @Prop()
  startedAt: Date;

  @Prop()
  completedAt?: Date;
}

export const MetaLearningImportSchema = SchemaFactory.createForClass(MetaLearningImport);

MetaLearningImportSchema.index({ tenantId: 1, status: 1 });
