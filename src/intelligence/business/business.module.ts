import { Global, Module } from '@nestjs/common';
import { CompaniesModule } from '../../companies/companies.module';
import { CampaignsModule } from '../../campaigns/campaigns.module';
import { BusinessEngine } from './business-engine.service';

@Global()
@Module({
  imports: [CompaniesModule, CampaignsModule],
  providers: [BusinessEngine],
  exports: [BusinessEngine],
})
export class BusinessModule {}
