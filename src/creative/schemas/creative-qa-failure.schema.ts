import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CreativeQaFailureDocument = HydratedDocument<CreativeQaFailure>;

/**
 * One record per dropped image (a QA FAIL verdict, not an infra error —
 * infra errors pass open and never reach here). This is the raw material for
 * spotting recurring failure patterns later (e.g. "screen_facing_palm shows
 * up 40 times across 3 products") instead of relying on someone noticing by
 * eye. Deliberately just a log table for now — no dashboard/analysis reads
 * it yet, so keep this schema minimal until a real consumer needs more.
 */
@Schema({ collection: 'creative_qa_failures', timestamps: true })
export class CreativeQaFailure {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  packageId: string;

  @Prop({ required: true })
  runId: string;

  @Prop({ required: true })
  imageUrl: string;

  @Prop()
  hookStyle?: string;

  @Prop({ default: '' })
  productName?: string;

  @Prop({ type: [String], default: [] })
  issues: string[];

  @Prop()
  label?: string;
}

export const CreativeQaFailureSchema = SchemaFactory.createForClass(CreativeQaFailure);
