import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../companies/companies.service';
import { CopyWriterService } from '../copy-writer/copy-writer.service';
import { ImageGeneratorService } from '../image-generator/image-generator.service';
import { VideoGeneratorService } from '../video-generator/video-generator.service';
import { CreativeTeamService } from '../../teams/creative-team.service';
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
  product?: string;
  targetSegment?: string;
}

@Injectable()
export class CreativeProducerService {
  private readonly logger = new Logger(CreativeProducerService.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly copyWriter: CopyWriterService,
    private readonly imageGenerator: ImageGeneratorService,
    private readonly videoGenerator: VideoGeneratorService,
    private readonly creativeTeam: CreativeTeamService,
    private readonly slackService: SlackService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
  ) {}

  async findByBriefId(tenantId: string, briefId: string): Promise<CreativePackageDocument | null> {
    return this.creativePackageModel
      .findOne({ tenantId, briefId, status: 'completed' })
      .lean()
      .exec() as any;
  }

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
      // Try Creative Team first (peer-to-peer debate: Creative Director + Brand Compliance)
      // Produces copy + image prompt + video prompt in one reviewed package
      // Falls back to single-agent approach if team fails
      let copyPackage: { variants: any[]; selectedIndex: number; selectionReason: string } | null = null;
      let image: { imagePrompt: string; imageUrl: string } | null = null;
      let video: { videoPrompt: string; videoUrl: string } | null = null;

      try {
        this.logger.log(`Creative Team starting for briefId=${briefId}`);
        const teamResult = await this.creativeTeam.run(brief, company, runId);

        copyPackage = {
          variants: teamResult.variants,
          selectedIndex: teamResult.selectedIndex,
          selectionReason: teamResult.selectionReason,
        };

        // Use team's reviewed image prompt → generate actual image
        const imageResult = await this.imageGenerator.generateFromPrompt(
          teamResult.imagePrompt, company, runId,
        );
        image = imageResult;

        // Generate actual video from Heygen-compatible script
        try {
          video = await this.videoGenerator.generateFromScript(
            teamResult.videoPrompt, tenantId, runId,
          );
        } catch (videoErr: any) {
          this.logger.error(`Video generation failed (prompt saved): ${videoErr.message}`);
          video = { videoPrompt: teamResult.videoPrompt, videoUrl: '' };
        }

        this.logger.log(
          `Creative Team done: briefId=${briefId} variants=${teamResult.variants.length} rounds=${teamResult.debateRounds}`,
        );
      } catch (teamErr: any) {
        this.logger.warn(`Creative Team failed, falling back to single-agent: ${teamErr.message}`);

        // Fallback: run all 3 independently
        const [copyResult, imageResult, videoResult] = await Promise.allSettled([
          this.copyWriter.generate(brief, company, runId),
          this.imageGenerator.generate(brief, company, runId),
          Promise.resolve({ videoPrompt: '', videoUrl: '' }), // video deferred to team path
        ]);

        copyPackage = copyResult.status === 'fulfilled' ? copyResult.value : null;
        image = imageResult.status === 'fulfilled' ? imageResult.value : null;
        video = videoResult.status === 'fulfilled' ? videoResult.value : null;

        if (copyResult.status === 'rejected') this.logger.error(`CopyWriter failed: ${copyResult.reason}`);
        if (imageResult.status === 'rejected') this.logger.error(`ImageGenerator failed: ${imageResult.reason}`);
        if (videoResult.status === 'rejected') this.logger.error(`VideoGenerator failed: ${videoResult.reason}`);
      }

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
          const selectedCopy = copyPackage?.variants?.[copyPackage?.selectedIndex ?? 0];
          const copyLine = selectedCopy
            ? `\n\n*Headline:* ${selectedCopy.headline}\n*Copy:* ${selectedCopy.primaryText}\n*CTA:* ${selectedCopy.cta}`
            : '';
          const imageLine = image?.imageUrl ? '\n✅ Image generated' : '\n⚠️ Image generation failed — retry needed';
          const videoLine = video?.videoUrl
            ? '\n✅ Video generated'
            : video?.videoPrompt
              ? '\n⚠️ Video generation failed — prompt saved, will retry'
              : '\n⚠️ No video';
          await this.slackService.sendMessage(
            slackWebhook,
            tenantId,
            `🎨 *Creative ready — ${brief.topic}*${copyLine}${imageLine}${videoLine}`,
          );
        }
      }

      return (await this.creativePackageModel.findOne({ tenantId, _id: pkg._id }).lean().exec()) as any;
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
