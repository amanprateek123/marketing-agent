import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Company, CompanySchema } from '../../companies/schemas/company.schema';
import { RevenueEngine } from './revenue-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Company.name, schema: CompanySchema }]),
  ],
  providers: [RevenueEngine],
  exports: [RevenueEngine],
})
export class RevenueModule {}
