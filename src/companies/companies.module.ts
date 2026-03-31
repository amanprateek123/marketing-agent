import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { Company, CompanySchema } from './schemas/company.schema';
import { ClaudeModule } from '../claude/claude.module';
import { PromptGeneratorService } from './prompt-generator/prompt-generator.service';
import { LiveContextBuilder } from './prompt-generator/live-context.builder';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Company.name, schema: CompanySchema },
    ]),
    ClaudeModule,
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService, PromptGeneratorService, LiveContextBuilder],
  exports: [CompaniesService, LiveContextBuilder],
})
export class CompaniesModule {}
