import { Controller, Get, Post, Patch, Param, Body, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreativeProducerService, BriefData } from './creative-producer/creative-producer.service';
import { ImageGeneratorService } from './image-generator/image-generator.service';
import { VideoGeneratorService } from './video-generator/video-generator.service';
import { CompaniesService } from '../companies/companies.service';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { CreativePackage, CreativePackageDocument } from './schemas/creative-package.schema';

@Controller('creative')
export class CreativeController {
  private readonly logger = new Logger(CreativeController.name);

  constructor(
    private readonly creativeProducer: CreativeProducerService,
    private readonly imageGenerator: ImageGeneratorService,
    private readonly videoGenerator: VideoGeneratorService,
    private readonly companiesService: CompaniesService,
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
  ) {}

  /**
   * GET /api/v1/creative/:tenantId/packages/:creativePackageId
   * Returns creative package by its ID (stored on campaign.creativePackageId).
   */
  @Get(':tenantId/packages/:creativePackageId')
  async getPackage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel
      .findOne({ _id: creativePackageId, tenantId })
      .lean()
      .exec();

    if (!pkg) {
      throw new NotFoundException(`Creative package ${creativePackageId} not found for tenant ${tenantId}`);
    }

    return pkg;
  }

  /**
   * PATCH /api/v1/creative/:tenantId/packages/:creativePackageId
   * Manually update imageUrl and/or videoUrl on a creative package.
   */
  @Patch(':tenantId/packages/:creativePackageId')
  async updatePackage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { imageUrl?: string; videoUrl?: string },
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const update: any = {};
    if (body.imageUrl) update.imageUrl = body.imageUrl;
    if (body.videoUrl) update.videoUrl = body.videoUrl;

    await this.creativePackageModel.updateOne({ _id: creativePackageId, tenantId }, { $set: update });
    return { status: 'updated', creativePackageId, ...update };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-video-prompt
   * Re-generate the video prompt using Claude (with fixed rules: no "link in bio", no logo).
   * Saves new videoPrompt to the package. Call regenerate-video after this to generate the video.
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-video-prompt')
  async regenerateVideoPrompt(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const company = await this.companiesService.findByTenantId(tenantId);
    const liveContext = this.liveContextBuilder.build(company);

    const result = await this.claudeService.runAgent({
      tenantId,
      runId: (pkg as any).runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext,
      userMessage: `
Rewrite this video prompt for a Heygen Video Agent API. Fix it to follow these strict rules:

ORIGINAL PROMPT:
${(pkg as any).videoPrompt}

RULES:
- NEVER say "link in bio" — this is a paid Meta ad. Users tap a CTA button. Use "tap the button below" or "order now" instead.
- NEVER mention the brand logo — Heygen doesn't know what it looks like. Logo is added separately in post-processing.
- Keep it under 150 words.
- Keep the same product, audience, visual style, and Hinglish voiceover tone.
- Plain text only, no JSON.

Return ONLY the rewritten video prompt, nothing else.
      `.trim(),
      maxTurns: 2,
    });

    const newVideoPrompt = result.content.trim();

    await this.creativePackageModel.updateOne(
      { _id: creativePackageId, tenantId },
      { $set: { videoPrompt: newVideoPrompt } },
    );

    this.logger.log(`Video prompt regenerated: tenantId=${tenantId} packageId=${creativePackageId}`);
    return { status: 'done', creativePackageId, videoPrompt: newVideoPrompt };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-image
   * Retry image generation using the saved imagePrompt from the Creative Team.
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-image')
  async regenerateImage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const imagePrompt = (pkg as any).imagePrompt;
    if (!imagePrompt) return { error: 'No imagePrompt saved — run full creative production first' };

    const company = await this.companiesService.findByTenantId(tenantId);

    this.logger.log(`Regenerating image: tenantId=${tenantId} packageId=${creativePackageId}`);

    // Fire and forget
    this.imageGenerator.generateFromPrompt(imagePrompt, company, (pkg as any).runId)
      .then(async (result) => {
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { imageUrl: result.imageUrl } },
        );
        this.logger.log(`Image regenerated: tenantId=${tenantId} packageId=${creativePackageId}`);
      })
      .catch((err) => this.logger.error(`Image regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, message: 'Image generation started. Poll GET /packages/:id for result.' };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-video
   * Retry video generation using the saved videoPrompt from the Creative Team.
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-video')
  async regenerateVideo(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const videoPrompt = (pkg as any).videoPrompt;
    if (!videoPrompt) return { error: 'No videoPrompt saved — run full creative production first' };

    this.logger.log(`Regenerating video: tenantId=${tenantId} packageId=${creativePackageId}`);

    // Fire and forget
    this.videoGenerator.generateFromScript(videoPrompt, tenantId, (pkg as any).runId)
      .then(async (result) => {
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { videoUrl: result.videoUrl } },
        );
        this.logger.log(`Video regenerated: tenantId=${tenantId} packageId=${creativePackageId}`);
      })
      .catch((err) => this.logger.error(`Video regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, message: 'Video generation started. Poll GET /packages/:id for result.' };
  }

  /**
   * POST /api/v1/creative/:tenantId/briefs/:briefId/approve
   * Approve any idea (recommended or runner-up) and trigger creative production.
   */
  @Post(':tenantId/briefs/:briefId/approve')
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('briefId') briefId: string,
  ) {
    const brief = await this.intelligenceBriefModel
      .findOne({ tenantId, briefId })
      .lean()
      .exec();

    if (!brief) {
      throw new NotFoundException(`Brief ${briefId} not found for tenant ${tenantId}`);
    }

    const briefData: BriefData = {
      topic: brief.topic,
      angle: brief.angle,
      platform: brief.platform,
      format: brief.format,
      audience: brief.audience,
      hook: (brief as any).hook ?? '',
      keyMessage: (brief as any).keyMessage ?? '',
      conversionBridge: (brief as any).conversionBridge ?? '',
    };

    // Fire and forget — returns immediately, production runs in background
    this.creativeProducer.produce(tenantId, briefId, brief.runId, briefData)
      .catch(() => {});

    return { status: 'started', briefId, topic: brief.topic };
  }
}
