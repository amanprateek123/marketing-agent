import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  IntelligenceSnapshot,
  IntelligenceSnapshotSchema,
} from '../snapshot/snapshot.schema';
import { TrendEngine } from './trend-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntelligenceSnapshot.name, schema: IntelligenceSnapshotSchema },
    ]),
  ],
  providers: [TrendEngine],
  exports: [TrendEngine],
})
export class TrendModule {}
