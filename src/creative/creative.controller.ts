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
  /**
   * PATCH /api/v1/creative/:tenantId/packages/:creativePackageId
   * Manually update a specific variant's imageUrl or the video's videoUrl.
   * Body: { variantIndex?: number, imageUrl?: string, videoUrl?: string }
   */
  @Patch(':tenantId/packages/:creativePackageId')
  async updatePackage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { variantIndex?: number; imageUrl?: string; videoUrl?: string },
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const update: any = {};

    if (body.imageUrl !== undefined) {
      const variantIndex = body.variantIndex ?? 0;
      // Update or push the image entry for this variant
      const images: any[] = (pkg as any).images ?? [];
      const existing = images.find((img: any) => img.variantIndex === variantIndex);
      if (existing) {
        existing.imageUrl = body.imageUrl;
      } else {
        images.push({ variantIndex, imagePrompt: '', imageUrl: body.imageUrl });
      }
      update.images = images;
    }

    if (body.videoUrl !== undefined) {
      const currentVideo = (pkg as any).video ?? { variantIndex: 0, videoPrompt: '', videoThumbnailUrl: '' };
      update.video = { ...currentVideo, videoUrl: body.videoUrl };
    }

    await this.creativePackageModel.updateOne({ _id: creativePackageId, tenantId }, { $set: update });
    return { status: 'updated', creativePackageId };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-video-prompt
   * Rewrites the video prompt from scratch using brief + winning copy hook + product + learnings.
   * Saves new videoPrompt AND generates the video. Fire-and-forget — poll GET for result.
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-video-prompt')
  async regenerateVideoPrompt(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const company = await this.companiesService.findByTenantId(tenantId);

    const brief = await this.intelligenceBriefModel
      .findOne({ tenantId, briefId: (pkg as any).briefId })
      .lean()
      .exec();

    if (!brief) return { error: 'No brief found for this package — cannot regenerate prompt' };

    const product = (company.products ?? []).find(p => p.name === (brief as any).product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0];

    const selectedCopy = (pkg as any).copyVariants?.[(pkg as any).selectedCopyIndex ?? 0];
    const hookText = selectedCopy?.primaryText?.split('\n')[0] ?? (brief as any).hook ?? '';
    const headline = selectedCopy?.headline ?? '';
    const cta = selectedCopy?.cta ?? 'Order Now';
    const creative = company.learnings?.creative;
    const visualInsights = creative?.visualInsights?.length
      ? `Visual patterns that work: ${creative.visualInsights.join('; ')}`
      : '';
    const ctaInsights = creative?.ctaInsights?.length
      ? `CTA insights: ${creative.ctaInsights.join('; ')}`
      : '';

    this.logger.log(`Regenerating video prompt from scratch: tenantId=${tenantId} packageId=${creativePackageId}`);

    // Fire and forget — rewrite prompt then generate video
    (async () => {
      const hidePrice = !!product?.hidePriceInCreative;
      const productLine = hidePrice
        ? `Product: ${product?.name ?? 'unknown'} (PRICE SUPPRESSED — do NOT mention any price, no ₹, no rupees, no booking-fee amounts)`
        : `Product: ${product?.name ?? 'unknown'} — ₹${product?.price ?? '???'}`;
      const ctaOverlayLine = hidePrice
        ? `   - 12-15s CTA: [product name + CTA action] — urgent and bold. DO NOT include any price (no ₹, no rupees).`
        : `   - 12-15s CTA: ₹${product?.price ?? '???'} | [CTA action] — make it urgent and bold`;
      const result = await this.claudeService.runAgent({
        tenantId,
        runId: (pkg as any).runId,
        agentType: AgentType.CREATIVE_PRODUCER,
        systemPrompt: '',
        liveContext: this.liveContextBuilder.build(company),
        userMessage: `
Write a detailed Heygen Video Agent prompt that will be submitted directly to Heygen's API to generate a 15-second 9:16 vertical Meta conversion ad video.

The video format: cinematic b-roll visuals with text overlays + off-screen Hindi voiceover narration + Indian instrumental background music. No avatar/talking head visible on screen — voice is heard but no person is shown speaking.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Audience: ${brief.audience}
${productLine}
Winning hook: "${hookText}"
Headline: "${headline}"
CTA: "${cta}"

${visualInsights}
${ctaInsights}
${hidePrice ? '\nPRICE SUPPRESSION ACTIVE: Do NOT include any price (no ₹, no rupees, no booking-fee amounts) in the script, text overlays, or voiceover. Lead with trust signals, lineage, and discovery framing instead.\n' : ''}
Write the Heygen prompt (180-220 words) covering ALL of these elements:

1. VIDEO CONCEPT: 15-second 9:16 vertical Meta ad for ${company.name}, cinematic b-roll with text overlays and off-screen Hindi voiceover narration. No visible person speaking.

2. TEXT OVERLAYS (exact Hindi/Hinglish words for each moment):
   - 0-3s HOOK: [exact words from the winning hook — make the viewer say "yeh toh mere baare mein hai"]
   - 3-7s PAIN/DESIRE: [specific fear or desire, 1 short sentence]
   - 7-12s PRODUCT: [product name + one-line benefit]
${ctaOverlayLine}

3. BACKGROUND VISUAL: Culturally relevant Indian scene that matches the hook's emotion. Be specific — not generic. Warm, high-contrast, not stock-photo.

4. TEXT STYLE: Bold white text with dark shadow, large enough to read in 3 seconds on mobile. Each overlay stays on screen minimum 3 seconds.

5. MUSIC: Indian classical instrumental — specify the instrument (tanpura/sitar/tabla), mood (meditative/uplifting/urgent), volume progression (builds gently to 40% at CTA). No vocals.

6. CONVERSION GOAL: One sentence — what emotion the viewer feels and what action they take.

Return ONLY the Heygen prompt text. No explanation, no JSON, no labels.
        `.trim(),
        maxTurns: 2,
      });

      const newVideoPrompt = result.content.trim();
      const currentVideo = (pkg as any).video ?? { variantIndex: (pkg as any).selectedCopyIndex ?? 0, videoUrl: '', videoThumbnailUrl: '' };

      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        { $set: { video: { ...currentVideo, videoPrompt: newVideoPrompt } } },
      );

      // Generate video
      try {
        const videoResult = await this.videoGenerator.generateFromScript(
          newVideoPrompt,
          tenantId,
          (pkg as any).runId,
          async (videoId: string) => {
            await this.creativePackageModel.updateOne(
              { _id: creativePackageId, tenantId },
              { $set: { heygenVideoId: videoId } },
            );
            this.logger.log(`Heygen videoId persisted on prompt regenerate: ${videoId} packageId=${creativePackageId}`);
          },
        );
        const currentVideo = (pkg as any).video ?? { variantIndex: (pkg as any).selectedCopyIndex ?? 0, videoThumbnailUrl: '' };
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { video: { ...currentVideo, videoPrompt: newVideoPrompt, videoUrl: videoResult.videoUrl, videoThumbnailUrl: videoResult.videoThumbnailUrl } } },
        );
        this.logger.log(`Video prompt regenerated + video generated: tenantId=${tenantId} packageId=${creativePackageId}`);
      } catch (videoErr: any) {
        this.logger.error(`Video generation failed after prompt rewrite (prompt saved): ${videoErr.message}`);
      }
    })().catch((err) => this.logger.error(`Video prompt regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, message: 'Video prompt regeneration started. Poll GET /packages/:id for result.' };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-image-prompt
   * Re-generate the image prompt from scratch using the brief data + new direct response specs.
   * Saves new imagePrompt AND generates the image. Fire-and-forget — poll GET for result.
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-image-prompt')
  async regenerateImagePrompt(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { variantIndex?: number } = {},
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const company = await this.companiesService.findByTenantId(tenantId);

    // Find the brief for this package
    const brief = await this.intelligenceBriefModel
      .findOne({ tenantId, briefId: (pkg as any).briefId })
      .lean()
      .exec();

    if (!brief) return { error: 'No brief found for this package — cannot regenerate prompt' };

    const product = (company.products ?? []).find(p => p.name === (brief as any).product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0];

    const copyVariants: any[] = (pkg as any).copyVariants ?? [];

    // If variantIndex specified — regenerate only that one. Otherwise regenerate all.
    const targetIndices = body.variantIndex !== undefined
      ? [body.variantIndex]
      : copyVariants.map((_, i) => i);

    const creative = company.learnings?.creative;
    const visualInsights = creative?.visualInsights?.length
      ? `Visual patterns that work: ${creative.visualInsights.join('; ')}`
      : '';

    this.logger.log(`Regenerating image prompt for variant(s) [${targetIndices.join(',')}]: tenantId=${tenantId} packageId=${creativePackageId}`);

    const hidePrice = !!product?.hidePriceInCreative;
    const productLine = hidePrice
      ? `Product: ${product?.name ?? 'unknown'} (PRICE SUPPRESSED — do NOT mention any price, no ₹, no rupees)`
      : `Product: ${product?.name ?? 'unknown'} — ₹${product?.price ?? '???'}`;
    const bottomOverlayLine = hidePrice
      ? `- TEXT OVERLAY — BOTTOM: "${product?.name ?? 'Product'}" + CTA in large text. DO NOT include any price (no ₹, no rupees).`
      : `- TEXT OVERLAY — BOTTOM: "${product?.name ?? 'Product'} — ₹${product?.price ?? '???'}" + CTA in large text`;
    const buildImagePrompt = (hook: string) => `
Write an image generation prompt for a Meta direct response ad. This image must make someone STOP scrolling and TAP the ad.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
${productLine}
Hook (winning copy): "${hook}"
${hidePrice ? '\nPRICE SUPPRESSION ACTIVE: Do NOT include any price (no ₹, no rupees, no booking-fee amounts) anywhere in the image — text overlays, captions, product labels. Lead with the hook and a trust signal (lineage, ratings, social proof) instead.\n' : ''}
STEP 1 — VISUAL CENTERPIECE: Read the hook and topic above. What is the ONE visual concept that makes THIS ad unique?
If the hook mentions a DATE/EVENT → centerpiece is that date (calendar, countdown, highlighted date — LARGE, dominating the frame)
If the hook mentions a FEAR/PROBLEM → centerpiece is that fear visualized dramatically (filling the frame)
If the hook mentions SOCIAL PROOF → centerpiece is the number, large and bold
If the hook mentions a COMPARISON → centerpiece is a split visual
The centerpiece must be the LARGEST element (60% of the frame) — NOT a small detail in the corner.

STEP 2 — BUILD AROUND THE CENTERPIECE:
- VISUAL CENTERPIECE (dominant): The concept from Step 1, unmissable at phone size
- TEXT OVERLAY — TOP: "${hook.slice(0, 80)}" in bold Hinglish, high contrast, readable
${bottomOverlayLine}
- PRODUCT VISIBLE — show ${product?.name ?? 'the product'} clearly
- INDIAN CONTEXT — real Indian faces, settings, skin tones
- HIGH CONTRAST — thumb-stopping colors, no muted/pastel

${visualInsights}

Format: Vertical 9:16, photorealistic, 4-5 sentences.
Describe: focal point, emotional tone, text overlay placement (exact words + position), product placement, colors, lighting.

AVOID: generic lifestyle photos, text-free images, muted colors, stock photo look, cluttered composition.

Return ONLY the image prompt, nothing else.
    `.trim();

    // Fire and forget — regenerate prompt + image for targeted variants in parallel
    (async () => {
      const images: any[] = [...((pkg as any).images ?? [])];

      await Promise.allSettled(
        targetIndices.map(async (i: number) => {
          const variant = copyVariants[i];
          if (!variant) return;
          const hook = variant.primaryText?.split('\n')[0] ?? (brief as any).hook ?? '';
          try {
            const result = await this.claudeService.runAgent({
              tenantId,
              runId: (pkg as any).runId,
              agentType: AgentType.CREATIVE_PRODUCER,
              systemPrompt: '',
              liveContext: this.liveContextBuilder.build(company),
              userMessage: buildImagePrompt(hook),
              maxTurns: 2,
            });
            const newImagePrompt = result.content.trim();
            const imageResult = await this.imageGenerator.generateFromPrompt(newImagePrompt, company, (pkg as any).runId);
            const existingIdx = images.findIndex((img: any) => img.variantIndex === i);
            if (existingIdx >= 0) {
              images[existingIdx] = { variantIndex: i, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl };
            } else {
              images.push({ variantIndex: i, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl });
            }
            this.logger.log(`Image prompt regenerated for variant ${i}: tenantId=${tenantId}`);
          } catch (err: any) {
            this.logger.error(`Image prompt regeneration failed for variant ${i}: ${err.message}`);
          }
        }),
      );

      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        { $set: { images } },
      );

      this.logger.log(`All image prompts regenerated: tenantId=${tenantId} packageId=${creativePackageId}`);
    })().catch((err) => this.logger.error(`Image prompt regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, variantIndices: targetIndices, message: 'Image prompt regeneration started. Poll GET /packages/:id for result.' };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-image
   * Retry image generation using the saved imagePrompt (does NOT rewrite the prompt).
   */
  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-image
   * Retry image generation for a specific variant using the saved imagePrompt.
   * Body: { variantIndex?: number } — defaults to selectedCopyIndex
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-image')
  async regenerateImage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { variantIndex?: number } = {},
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const variantIndex = body.variantIndex ?? (pkg as any).selectedCopyIndex ?? 0;
    const images: any[] = (pkg as any).images ?? [];
    const imageEntry = images.find((img: any) => img.variantIndex === variantIndex);

    if (!imageEntry?.imagePrompt) {
      return { error: `No imagePrompt saved for variant ${variantIndex} — run full creative production first` };
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    this.logger.log(`Regenerating image for variant ${variantIndex}: tenantId=${tenantId} packageId=${creativePackageId}`);

    // Fire and forget
    this.imageGenerator.generateFromPrompt(imageEntry.imagePrompt, company, (pkg as any).runId)
      .then(async (result) => {
        const updatedImages = [...images];
        const idx = updatedImages.findIndex((img: any) => img.variantIndex === variantIndex);
        if (idx >= 0) updatedImages[idx] = { ...updatedImages[idx], imageUrl: result.imageUrl };
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { images: updatedImages } },
        );
        this.logger.log(`Image regenerated for variant ${variantIndex}: tenantId=${tenantId} packageId=${creativePackageId}`);
      })
      .catch((err) => this.logger.error(`Image regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, variantIndex, message: 'Image generation started. Poll GET /packages/:id for result.' };
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

    const video = (pkg as any).video;
    if (!video?.videoPrompt) return { error: 'No videoPrompt saved — run full creative production first' };

    this.logger.log(`Regenerating video: tenantId=${tenantId} packageId=${creativePackageId}`);

    // Fire and forget
    (async () => {
      const result = await this.videoGenerator.generateFromScript(
        video.videoPrompt,
        tenantId,
        (pkg as any).runId,
        async (videoId: string) => {
          await this.creativePackageModel.updateOne(
            { _id: creativePackageId, tenantId },
            { $set: { heygenVideoId: videoId } },
          );
          this.logger.log(`Heygen videoId persisted on regenerate: ${videoId} packageId=${creativePackageId}`);
        },
      );
      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        { $set: { video: { ...video, videoUrl: result.videoUrl, videoThumbnailUrl: result.videoThumbnailUrl } } },
      );
      this.logger.log(`Video regenerated: tenantId=${tenantId} packageId=${creativePackageId}`);
    })().catch((err) => this.logger.error(`Video regeneration failed: ${err.message}`));

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

    // product/targetSegment/targetLanguage MUST be forwarded — otherwise the
    // creative producer falls back to the first active product and the resulting
    // copy/price/imagery match the wrong product. See pipeline.controller.ts
    // produceIdea for the same pattern.
    const briefData: BriefData = {
      product: (brief as any).product ?? '',
      topic: brief.topic,
      angle: brief.angle,
      platform: brief.platform,
      format: brief.format,
      audience: brief.audience,
      hook: (brief as any).hook ?? '',
      keyMessage: (brief as any).keyMessage ?? '',
      conversionBridge: (brief as any).conversionBridge ?? '',
      audienceStage: (brief as any).audienceStage,
      explorationArm: (brief as any).explorationArm,
      targetSegment: (brief as any).targetSegment,
      targetLanguage: (brief as any).targetLanguage,
      winnerCloneOf: (brief as any).winnerCloneOf,
    };

    // Fire and forget — returns immediately, production runs in background
    this.creativeProducer.produce(tenantId, briefId, brief.runId, briefData)
      .catch(() => {});

    return { status: 'started', briefId, topic: brief.topic };
  }

  /**
   * POST /api/v1/creative/:tenantId/fix-caption-videos
   * Re-fetch video URLs without burned-in captions for all packages that have a heygenVideoId.
   * Use this once to fix existing videos that had overlapping captions + text overlays.
   */
  @Post(':tenantId/fix-caption-videos')
  async fixCaptionVideos(@Param('tenantId') tenantId: string) {
    const packages = await this.creativePackageModel.find({
      tenantId,
      heygenVideoId: { $ne: null },
      'video.videoUrl': { $exists: true, $ne: '' },
    }).exec();

    const results: { briefId: string; status: string }[] = [];

    for (const pkg of packages) {
      try {
        const result = await this.videoGenerator.resumeFromVideoId(
          pkg.heygenVideoId!,
          (pkg.video as any)?.videoPrompt ?? '',
          tenantId,
          pkg.runId,
        );

        await this.creativePackageModel.updateOne(
          { _id: pkg._id },
          { $set: { 'video.videoUrl': result.videoUrl, 'video.videoThumbnailUrl': result.videoThumbnailUrl } },
        );
        results.push({ briefId: pkg.briefId, status: 'fixed' });
      } catch (err: any) {
        this.logger.error(`Fix caption failed for ${pkg.briefId}: ${err.message}`);
        results.push({ briefId: pkg.briefId, status: `failed: ${err.message}` });
      }
    }

    return { fixed: results.filter(r => r.status === 'fixed').length, total: packages.length, results };
  }
}
