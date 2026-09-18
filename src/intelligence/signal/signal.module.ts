import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../campaigns/schemas/campaign.schema';
import { BreakdownSnapshot, BreakdownSnapshotSchema } from '../../campaigns/schemas/breakdown-snapshot.schema';
import { SignalEngine } from './signal-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: BreakdownSnapshot.name, schema: BreakdownSnapshotSchema },
    ]),
  ],
  providers: [SignalEngine],
  exports: [SignalEngine],
})
export class SignalModule {}
