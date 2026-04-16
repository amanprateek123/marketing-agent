import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../companies/companies.service';
import { CopyWriterService } from '../copy-writer/copy-writer.service';
import { ImageGeneratorService } from '../image-generator/image-generator.service';
import { VideoGeneratorService } from '../video-generator/video-generator.service';
import { CreativeTeamService } from '../../teams/creative-team.service';
import { CreativePackage, CreativePackageDocument, ImageCreative, VideoCreative } from '../schemas/creative-package.schema';
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

    // Check for existing package — avoid duplicates on resume
    const existing = await this.creativePackageModel.findOne({ tenantId, briefId }).lean().exec();
    if (existing && existing.status === 'completed') {
      this.logger.log(`Creative production skipped — already completed for briefId=${briefId}`);
      return existing as any;
    }
    if (existing) {
      await this.creativePackageModel.deleteOne({ _id: existing._id });
      this.logger.log(`Creative production: removing stale ${existing.status} package for briefId=${briefId}`);
    }

    const pkg = await this.creativePackageModel.create({
      tenantId,
      runId,
      briefId,
      status: 'pending',
      approvedAt: new Date(),
    });

    this.logger.log(`Creative production started: tenantId=${tenantId} briefId=${briefId}`);

    try {
      let copyPackage: { variants: any[]; selectedIndex: number; selectionReason: string } | null = null;
      let images: ImageCreative[] = [];
      let video: VideoCreative | null = null;

      try {
        // ── Creative Team path (primary) ───────────────────────────────────────
        this.logger.log(`Creative Team starting for briefId=${briefId}`);
        const teamResult = await this.creativeTeam.run(brief, company, runId);

        copyPackage = {
          variants: teamResult.variants,
          selectedIndex: teamResult.selectedIndex,
          selectionReason: teamResult.selectionReason,
        };

        // Generate one image per copy variant in parallel
        this.logger.log(`Generating ${teamResult.variants.length} images (one per variant): tenantId=${tenantId}`);
        const imageResults = await Promise.allSettled(
          teamResult.variants.map((variant: any, i: number) =>
            this.imageGenerator.generateForVariant(
              { topic: brief.topic, angle: brief.angle, platform: brief.platform, format: brief.format, audience: brief.audience },
              variant,
              i,
              company,
              runId,
            ),
          ),
        );

        images = teamResult.variants.map((_: any, i: number) => {
          const result = imageResults[i];
          if (result.status === 'fulfilled') {
            return { variantIndex: i, imagePrompt: result.value.imagePrompt, imageUrl: result.value.imageUrl };
          }
          this.logger.error(`Image generation failed for variant ${i}: ${(result as any).reason?.message}`);
          return { variantIndex: i, imagePrompt: '', imageUrl: '' };
        });

        // Generate one video for the selected copy variant
        const selectedIndex = teamResult.selectedIndex ?? 0;
        const heygenPrompt = this.convertVideoPromptForHeygen(teamResult.videoPrompt);
        const videoPromptStr = typeof teamResult.videoPrompt === 'string'
          ? teamResult.videoPrompt
          : JSON.stringify(teamResult.videoPrompt);

        try {
          const videoResult = await this.videoGenerator.generateFromScript(heygenPrompt, tenantId, runId);
          video = {
            variantIndex: selectedIndex,
            videoPrompt: videoPromptStr,
            videoUrl: videoResult.videoUrl,
            videoThumbnailUrl: videoResult.videoThumbnailUrl,
          };
        } catch (videoErr: any) {
          this.logger.error(`Video generation failed (prompt saved): ${videoErr.message}`);
          video = { variantIndex: selectedIndex, videoPrompt: videoPromptStr, videoUrl: '', videoThumbnailUrl: '' };
        }

        this.logger.log(
          `Creative Team done: briefId=${briefId} variants=${teamResult.variants.length} images=${images.length} rounds=${teamResult.debateRounds}`,
        );
      } catch (teamErr: any) {
        // ── Fallback path — single-agent ──────────────────────────────────────
        this.logger.warn(`Creative Team failed, falling back to single-agent: ${teamErr.message}`);

        // Run copy first — images depend on having variants
        try {
          copyPackage = await this.copyWriter.generate(brief, company, runId);
        } catch (copyErr: any) {
          this.logger.error(`CopyWriter failed: ${copyErr.message}`);
        }

        if (copyPackage?.variants?.length) {
          // Generate one image per variant in parallel
          const imageResults = await Promise.allSettled(
            copyPackage.variants.map((variant: any, i: number) =>
              this.imageGenerator.generateForVariant(
                { topic: brief.topic, angle: brief.angle, platform: brief.platform, format: brief.format, audience: brief.audience },
                variant,
                i,
                company,
                runId,
              ),
            ),
          );
          images = copyPackage.variants.map((_: any, i: number) => {
            const result = imageResults[i];
            if (result.status === 'fulfilled') {
              return { variantIndex: i, imagePrompt: result.value.imagePrompt, imageUrl: result.value.imageUrl };
            }
            this.logger.error(`Image generation failed for variant ${i}: ${(result as any).reason?.message}`);
            return { variantIndex: i, imagePrompt: '', imageUrl: '' };
          });
        } else {
          // No variants — generate one image from brief
          try {
            const imgResult = await this.imageGenerator.generate(brief, company, runId);
            images = [{ variantIndex: 0, imagePrompt: imgResult.imagePrompt, imageUrl: imgResult.imageUrl }];
          } catch (imgErr: any) {
            this.logger.error(`Image generation failed: ${imgErr.message}`);
          }
        }

        // No video in fallback path
        video = null;
      }

      const allFailed = !copyPackage && images.length === 0 && !video;
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
          images,
          video,
          completedAt: new Date(),
        },
      );

      const imageCount = images.filter(i => i.imageUrl).length;
      this.logger.log(
        `Creative production ${status}: tenantId=${tenantId} briefId=${briefId} copy=${!!copyPackage} images=${imageCount}/${images.length} video=${!!video?.videoUrl}`,
      );

      if (!allFailed) {
        const slackWebhook = company.delivery?.slackWebhook;
        if (slackWebhook) {
          try {
            const selectedCopy = copyPackage?.variants?.[copyPackage?.selectedIndex ?? 0];
            const copyLine = selectedCopy
              ? `\n\n*Headline:* ${selectedCopy.headline}\n*Copy:* ${selectedCopy.primaryText}\n*CTA:* ${selectedCopy.cta}`
              : '';
            const imagesLine = imageCount > 0
              ? `\n✅ ${imageCount}/${images.length} images generated`
              : '\n⚠️ Image generation failed — retry needed';
            const videoLine = video?.videoUrl
              ? '\n✅ Video generated'
              : video?.videoPrompt
                ? '\n⚠️ Video generation failed — prompt saved, will retry'
                : '\n⚠️ No video';
            await this.slackService.sendMessage(
              slackWebhook,
              tenantId,
              `🎨 *Creative ready — ${brief.topic}*${copyLine}${imagesLine}${videoLine}`,
            );
          } catch (slackErr: any) {
            this.logger.error(`Slack notification failed for creative ${briefId} — package saved: ${slackErr.message}`);
          }
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

  private convertVideoPromptForHeygen(videoPrompt: any): string {
    if (typeof videoPrompt === 'string') {
      try {
        const parsed = JSON.parse(videoPrompt);
        if (Array.isArray(parsed)) {
          return this.scenesToHeygenPrompt(parsed);
        }
      } catch {
        return videoPrompt;
      }
      return videoPrompt;
    }

    if (Array.isArray(videoPrompt)) {
      return this.scenesToHeygenPrompt(videoPrompt);
    }

    return String(videoPrompt);
  }

  private scenesToHeygenPrompt(scenes: any[]): string {
    const sceneDescriptions = scenes
      .map((s: any) => `[${s.duration}] Text on screen: "${s.text}" — Visual: ${s.visual}${s.music ? ` — Music: ${s.music}` : ''}`)
      .join('\n\n');

    return `15-20 second vertical 9:16 Meta ad video. Sharp jump cuts every 2-3 seconds. Bold Hinglish/Hindi text overlays on every scene. Indian aesthetic throughout. IMPORTANT: Do NOT add auto-generated subtitles or captions — only the text overlays specified per scene.

${sceneDescriptions}

Style: fast-paced, high contrast, thumb-stopping. Each scene has bold centered text overlay in white/yellow on a semi-transparent dark band. Sharp cuts between scenes — no smooth transitions. Indian faces, settings, and music throughout.`;
  }
}
