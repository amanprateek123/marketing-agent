import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../companies/companies.service';
import { CopyWriterService } from '../copy-writer/copy-writer.service';
import { ImageGeneratorService } from '../image-generator/image-generator.service';
import { VideoGeneratorService } from '../video-generator/video-generator.service';
import { CreativePackage, CreativePackageDocument } from '../schemas/creative-package.schema';
import { SlackService } from '../../delivery/slack.service';

export interface BriefData {
  topic: string;
  angle: string;
  platform: string;
  format: string;
  audience: string;
  hook: string;
  keyMessage: string;
  conversionBridge: string;
}

@Injectable()
export class CreativeProducerService {
  private readonly logger = new Logger(CreativeProducerService.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly copyWriter: CopyWriterService,
    private readonly imageGenerator: ImageGeneratorService,
    private readonly videoGenerator: VideoGeneratorService,
    private readonly slackService: SlackService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
  ) {}

  async produce(
    tenantId: string,
    briefId: string,
    runId: string,
    brief: BriefData,
  ): Promise<CreativePackageDocument> {
    const company = await this.companiesService.findByTenantId(tenantId);

    const pkg = await this.creativePackageModel.create({
      tenantId,
      runId,
      briefId,
      status: 'pending',
      approvedAt: new Date(),
    });

    this.logger.log(`Creative production started: tenantId=${tenantId} briefId=${briefId}`);

    try {
      const [copyPackage, imageResult, videoResult] = await Promise.all([
        this.copyWriter.generate(brief, company, runId),
        this.imageGenerator.generate(brief, company, runId),
        this.videoGenerator.generate(brief, company, runId),
      ]);

      await this.creativePackageModel.updateOne(
        { _id: pkg._id },
        {
          status: 'completed',
          copyVariants: copyPackage.variants,
          selectedCopyIndex: copyPackage.selectedIndex,
          copySelectionReason: copyPackage.selectionReason,
          imagePrompt: imageResult.imagePrompt,
          imageUrl: imageResult.imageUrl,
          videoPrompt: videoResult.videoPrompt,
          videoUrl: videoResult.videoUrl,
          completedAt: new Date(),
        },
      );

      this.logger.log(`Creative production complete: tenantId=${tenantId} briefId=${briefId}`);

      const slackWebhook = company.delivery?.slackWebhook;
      if (slackWebhook) {
        const selectedCopy = copyPackage.variants[copyPackage.selectedIndex];
        await this.slackService.sendMessage(
          slackWebhook,
          tenantId,
          `✅ *Creative ready — ${brief.topic}*\n\n*Headline:* ${selectedCopy.headline}\n*Copy:* ${selectedCopy.primaryText}\n*CTA:* ${selectedCopy.cta}\n*Hook style:* ${selectedCopy.hookStyle}\n\nImage + video prompts stored in DB. Reply to approve for campaign launch.`,
        );
      }

      return (await this.creativePackageModel.findById(pkg._id).lean().exec()) as any;
    } catch (err: any) {
      await this.creativePackageModel.updateOne(
        { _id: pkg._id },
        { status: 'failed', error: err.message },
      );
      this.logger.error(`Creative production failed: tenantId=${tenantId} briefId=${briefId} | ${err.message}`);
      throw err;
    }
  }
}
