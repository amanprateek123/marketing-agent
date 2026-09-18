import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../campaigns/schemas/campaign.schema';
import { PortfolioEngine } from './portfolio-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Campaign.name, schema: CampaignSchema }]),
  ],
  providers: [PortfolioEngine],
  exports: [PortfolioEngine],
})
export class PortfolioModule {}
