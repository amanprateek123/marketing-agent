import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Company, CompanySchema } from '../../companies/schemas/company.schema';
import {
  Campaign,
  CampaignSchema,
} from '../../campaigns/schemas/campaign.schema';
import { RevenueEngine } from './revenue-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Company.name, schema: CompanySchema },
      { name: Campaign.name, schema: CampaignSchema },
    ]),
  ],
  providers: [RevenueEngine],
  exports: [RevenueEngine],
})
export class RevenueModule {}
