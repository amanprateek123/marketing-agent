import { Global, Module } from '@nestjs/common';
import { CompaniesModule } from '../../companies/companies.module';
import { BusinessEngine } from './business-engine.service';

@Global()
@Module({
  imports: [CompaniesModule],
  providers: [BusinessEngine],
  exports: [BusinessEngine],
})
export class BusinessModule {}
