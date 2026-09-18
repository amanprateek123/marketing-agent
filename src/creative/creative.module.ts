import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { S3Service } from '../common/storage/s3.service';
import { ImageResizerService } from '../common/media/image-resizer.service';
import { CreativePackage, CreativePackageSchema } from './schemas/creative-package.schema';
import { CreativeQaFailure, CreativeQaFailureSchema } from './schemas/creative-qa-failure.schema';
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
import { MetaAdsLibraryOutput, MetaAdsLibraryOutputSchema } from '../pipeline/schemas/meta-ads-library-output.schema';
import { CreativeTeamService } from '../teams/creative-team.service';
import { HeygenService } from './video-generator/heygen.service';
import { HiggsfieldService } from './video-generator/higgsfield.service';
import { CartesiaService } from './video-generator/cartesia.service';
import { CreativeQaService } from './creative-qa/creative-qa.service';
import { GalleryModule } from '../gallery/gallery.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CreativePackage.name, schema: CreativePackageSchema },
      { name: CreativeQaFailure.name, schema: CreativeQaFailureSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: UsageLog.name, schema: UsageLogSchema },
      { name: MetaAdsLibraryOutput.name, schema: MetaAdsLibraryOutputSchema },
    ]),
    ClaudeModule,
    forwardRef(()=> CompaniesModule),
    CampaignsModule,
    DeliveryModule,
    GalleryModule,
  ],
  controllers: [CreativeController],
  providers: [
    S3Service,
    ImageResizerService,
    CopyWriterService,
    ImageGeneratorService,
    HeygenService,
    HiggsfieldService,
    CartesiaService,
    VideoGeneratorService,
    CreativeTeamService,
    CreativeQaService,
    CreativeProducerService,
  ],
  exports: [CreativeProducerService],
})
export class CreativeModule {}
