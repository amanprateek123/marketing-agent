import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../campaigns/schemas/campaign.schema';
import { LifecycleEngine } from './lifecycle-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Campaign.name, schema: CampaignSchema }]),
  ],
  providers: [LifecycleEngine],
  exports: [LifecycleEngine],
})
export class LifecycleModule {}
