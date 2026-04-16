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
      const result = await this.claudeService.runAgent({
        tenantId,
        runId: (pkg as any).runId,
        agentType: AgentType.CREATIVE_PRODUCER,
        systemPrompt: '',
        liveContext: this.liveContextBuilder.build(company),
        userMessage: `
Write a scene-by-scene script for a 15-20 second vertical (9:16) Meta direct response ad video.

This is the TEXT-LED JUMP-CUT format — the highest converting format on Meta for Indian audiences.
Every 2-3 seconds = NEW SCENE with a sharp cut. Each scene has BOLD Hinglish/Hindi text + a short video clip behind it. The TEXT sells. The video creates mood.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Audience: ${brief.audience}
Product: ${product?.name ?? 'unknown'} — ₹${product?.price ?? '???'}
Winning hook: "${hookText}"
CTA: "${cta}"

SCENE STRUCTURE:
Scene 1 (0-3s) — HOOK: Bold Hinglish text that creates instant curiosity or hits a pain point. Viewer must think "yeh toh mere baare me hai." Video: dramatic emotional visual.
Scene 2-3 (3-8s) — PAIN POINTS: Each scene = one relatable question/fear in short punchy Hinglish. Video: literal visual of what the text says.
Scene 4 (8-12s) — PRODUCT REVEAL: Text introduces ${product?.name ?? 'the product'} as the answer. Video: someone using/holding the product. Close-up, real.
Scene 5 (12-15s) — PROOF + PRICE: Social proof text + "₹${product?.price ?? '???'}". Video: happy customer or results.
Scene 6 (15-18s) — CTA: Urgency text + "${cta}". Video: product hero shot.

${visualInsights}
${ctaInsights}

RULES:
- "text": Hinglish/Hindi only. 3-8 words max per scene. Punchy.
- "visual": Specific Indian scene. Describe what the camera sees — close-up/wide, lighting, action.
- Product name and price must appear in text of at least one scene each.
- NO English-only text. NO "link in bio". NO brand logo. NO generic intros.

Return ONLY a JSON array:
[
  { "duration": "0-3s", "text": "Hinglish hook", "visual": "scene description", "music": "Indian music style" },
  ...
]
        `.trim(),
        maxTurns: 2,
      });

      const rawOutput = result.content.trim();

      // Parse scene list — save the structured version
      let scenes: any[];
      try {
        const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
        scenes = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      } catch {
        scenes = [];
      }

      // Save structured scene list as videoPrompt inside video object
      const newVideoPrompt = scenes.length > 0 ? JSON.stringify(scenes, null, 2) : rawOutput;
      const currentVideo = (pkg as any).video ?? { variantIndex: (pkg as any).selectedCopyIndex ?? 0, videoUrl: '', videoThumbnailUrl: '' };

      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        { $set: { video: { ...currentVideo, videoPrompt: newVideoPrompt } } },
      );

      // Convert scene list to Heygen-compatible text prompt
      const heygenPrompt = scenes.length > 0
        ? `15-20 second vertical 9:16 Meta ad video. Sharp jump cuts every 2-3 seconds. Bold text overlays on every scene. Indian aesthetic throughout.\n\n${scenes.map((s: any) => `[${s.duration}] Text on screen: "${s.text}" — Visual: ${s.visual}${s.music ? ` — Music: ${s.music}` : ''}`).join('\n\n')}\n\nStyle: fast-paced, high contrast, thumb-stopping. Each scene has bold centered text overlay in white/yellow on a semi-transparent dark band. Sharp cuts between scenes — no smooth transitions.`
        : rawOutput;

      // Generate video
      try {
        const videoResult = await this.videoGenerator.generateFromScript(heygenPrompt, tenantId, (pkg as any).runId);
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

    const selectedCopy = (pkg as any).copyVariants?.[(pkg as any).selectedCopyIndex ?? 0];
    const hookText = selectedCopy?.primaryText?.split('\n')[0] ?? (brief as any).hook ?? '';
    const creative = company.learnings?.creative;
    const visualInsights = creative?.visualInsights?.length
      ? `Visual patterns that work: ${creative.visualInsights.join('; ')}`
      : '';

    this.logger.log(`Regenerating image prompt from scratch: tenantId=${tenantId} packageId=${creativePackageId}`);

    // Fire and forget — rewrite prompt then generate image
    (async () => {
      const result = await this.claudeService.runAgent({
        tenantId,
        runId: (pkg as any).runId,
        agentType: AgentType.CREATIVE_PRODUCER,
        systemPrompt: '',
        liveContext: this.liveContextBuilder.build(company),
        userMessage: `
Write an image generation prompt for a Meta direct response ad. This image must make someone STOP scrolling and TAP the ad.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Product: ${product?.name ?? 'unknown'} — ₹${product?.price ?? '???'}
Hook (winning copy): "${hookText}"

STEP 1 — VISUAL CENTERPIECE: Read the hook and topic above. What is the ONE visual concept that makes THIS ad unique?
If the hook mentions a DATE/EVENT → centerpiece is that date (calendar, countdown, highlighted date — LARGE, dominating the frame)
If the hook mentions a FEAR/PROBLEM → centerpiece is that fear visualized dramatically (filling the frame)
If the hook mentions SOCIAL PROOF → centerpiece is the number, large and bold
If the hook mentions a COMPARISON → centerpiece is a split visual
The centerpiece must be the LARGEST element (60% of the frame) — NOT a small detail in the corner.

STEP 2 — BUILD AROUND THE CENTERPIECE:
- VISUAL CENTERPIECE (dominant): The concept from Step 1, unmissable at phone size
- TEXT OVERLAY — TOP: "${hookText.slice(0, 80)}" in bold Hinglish, high contrast, readable
- TEXT OVERLAY — BOTTOM: "${product?.name ?? 'Product'} — ₹${product?.price ?? '???'}" + CTA in large text
- PRODUCT VISIBLE — show ${product?.name ?? 'the product'} clearly
- INDIAN CONTEXT — real Indian faces, settings, skin tones
- HIGH CONTRAST — thumb-stopping colors, no muted/pastel

${visualInsights}

Format: Vertical 9:16, photorealistic, 4-5 sentences.
Describe: focal point, emotional tone, text overlay placement (exact words + position), product placement, colors, lighting.

AVOID: generic lifestyle photos, text-free images, muted colors, stock photo look, cluttered composition.

Return ONLY the image prompt, nothing else.
        `.trim(),
        maxTurns: 2,
      });

      const newImagePrompt = result.content.trim();

      const selectedIndex = (pkg as any).selectedCopyIndex ?? 0;
      const images: any[] = (pkg as any).images ?? [];

      // Generate image from new prompt
      const imageResult = await this.imageGenerator.generateFromPrompt(newImagePrompt, company, (pkg as any).runId);
      const existingIdx = images.findIndex((img: any) => img.variantIndex === selectedIndex);
      if (existingIdx >= 0) {
        images[existingIdx] = { variantIndex: selectedIndex, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl };
      } else {
        images.push({ variantIndex: selectedIndex, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl });
      }

      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        { $set: { images } },
      );

      this.logger.log(`Image prompt regenerated + image generated: tenantId=${tenantId} packageId=${creativePackageId}`);
    })().catch((err) => this.logger.error(`Image prompt regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, message: 'Image prompt regeneration started. Poll GET /packages/:id for result.' };
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
    this.videoGenerator.generateFromScript(video.videoPrompt, tenantId, (pkg as any).runId)
      .then(async (result) => {
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { video: { ...video, videoUrl: result.videoUrl, videoThumbnailUrl: result.videoThumbnailUrl } } },
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
