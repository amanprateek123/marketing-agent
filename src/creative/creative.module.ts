import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CreativePackage, CreativePackageSchema } from './schemas/creative-package.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';
import { CopyWriterService } from './copy-writer/copy-writer.service';
import { ImageGeneratorService } from './image-generator/image-generator.service';
import { VideoGeneratorService } from './video-generator/video-generator.service';
import { CreativeProducerService } from './creative-producer/creative-producer.service';
import { CreativeController } from './creative.controller';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { UsageLog, UsageLogSchema } from '../claude/schemas/usage-log.schema';
import { CreativeTeamService } from '../teams/creative-team.service';
import { HeygenService } from './video-generator/heygen.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CreativePackage.name, schema: CreativePackageSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: UsageLog.name, schema: UsageLogSchema },
    ]),
    ClaudeModule,
    CompaniesModule,
    CampaignsModule,
    DeliveryModule,
  ],
  controllers: [CreativeController],
  providers: [
    CopyWriterService,
    ImageGeneratorService,
    HeygenService,
    VideoGeneratorService,
    CreativeTeamService,
    CreativeProducerService,
  ],
  exports: [CreativeProducerService],
})
export class CreativeModule {}
