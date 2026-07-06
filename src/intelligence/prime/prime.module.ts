import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CampaignsModule } from '../../campaigns/campaigns.module';
import { CompaniesModule } from '../../companies/companies.module';
import { Campaign, CampaignSchema } from '../../campaigns/schemas/campaign.schema';
import { PrimeController } from './prime.controller';
import { PrimeService } from './prime.service';
import { IntelligenceCascadeScheduler } from './intelligence-cascade.scheduler';

@Module({
  imports: [
    forwardRef(() => CampaignsModule),
    forwardRef(() => CompaniesModule),
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
    ]),
  ],
  controllers: [PrimeController],
  providers: [PrimeService, IntelligenceCascadeScheduler],
})
export class PrimeModule {}
