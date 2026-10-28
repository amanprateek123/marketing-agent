import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PmLockDocument = HydratedDocument<PmLock>;

/**
 * A lease, so only one Performance Marketeer sync runs at a time across every
 * process (app replicas, the CLI). Expires on its own if a holder dies.
 */
@Schema({ collection: 'pm_locks' })
export class PmLock {
  /** `pm-sync:<tenantId>` */
  @Prop({ required: true }) _id: string;
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) holder: string;
  @Prop({ required: true }) job: string;
  @Prop({ required: true }) until: Date;
}

export const PmLockSchema = SchemaFactory.createForClass(PmLock);
