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
      // Run all 3 independently — partial results are always saved
      const [copyResult, imageResult, videoResult] = await Promise.allSettled([
        this.copyWriter.generate(brief, company, runId),
        this.imageGenerator.generate(brief, company, runId),
        this.videoGenerator.generate(brief, company, runId),
      ]);

      const copyPackage = copyResult.status === 'fulfilled' ? copyResult.value : null;
      const image = imageResult.status === 'fulfilled' ? imageResult.value : null;
      const video = videoResult.status === 'fulfilled' ? videoResult.value : null;

      if (copyResult.status === 'rejected') this.logger.error(`CopyWriter failed: ${copyResult.reason}`);
      if (imageResult.status === 'rejected') this.logger.error(`ImageGenerator failed: ${imageResult.reason}`);
      if (videoResult.status === 'rejected') this.logger.error(`VideoGenerator failed: ${videoResult.reason}`);

      const allFailed = !copyPackage && !image && !video;
      const status = allFailed ? 'failed' : 'completed';

      await this.creativePackageModel.updateOne(
        { _id: pkg._id },
        {
          status,
          ...(copyPackage && {
            copyVariants: copyPackage.variants,
            selectedCopyIndex: copyPackage.selectedIndex,
            copySelectionReason: copyPackage.selectionReason,
          }),
          ...(image && {
            imagePrompt: image.imagePrompt,
            imageUrl: image.imageUrl,
          }),
          ...(video && {
            videoPrompt: video.videoPrompt,
            videoUrl: video.videoUrl,
          }),
          completedAt: new Date(),
        },
      );

      this.logger.log(`Creative production ${status}: tenantId=${tenantId} briefId=${briefId} copy=${!!copyPackage} image=${!!image} video=${!!video}`);

      if (!allFailed) {
        const slackWebhook = company.delivery?.slackWebhook;
        if (slackWebhook) {
          const selectedCopy = copyPackage?.variants[copyPackage.selectedIndex];
          const copyLine = selectedCopy
            ? `\n\n*Headline:* ${selectedCopy.headline}\n*Copy:* ${selectedCopy.primaryText}\n*CTA:* ${selectedCopy.cta}`
            : '';
          const imageLine = image?.imageUrl ? '\n✅ Image generated' : '\n⚠️ Image generation failed — retry needed';
          const videoLine = '\n⏳ Video prompt stored — awaiting API key';
          await this.slackService.sendMessage(
            slackWebhook,
            tenantId,
            `🎨 *Creative ready — ${brief.topic}*${copyLine}${imageLine}${videoLine}`,
          );
        }
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
