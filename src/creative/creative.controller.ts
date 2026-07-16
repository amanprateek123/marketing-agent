import { Controller, Get, Post, Patch, Param, Body, NotFoundException, BadRequestException, Logger, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreativeProducerService, BriefData } from './creative-producer/creative-producer.service';
import { ImageGeneratorService } from './image-generator/image-generator.service';
import { VideoGeneratorService } from './video-generator/video-generator.service';
import { CampaignCreatorService } from '../campaigns/campaign-creator/campaign-creator.service';
import { CompaniesService } from '../companies/companies.service';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { CreativePackage, CreativePackageDocument } from './schemas/creative-package.schema';
import { CANONICAL_LANGUAGES } from '../common/creative/language-utils';
import { listFormatSpecs, AspectRatio, ImageResolution, VideoAspectRatio, VideoResolution } from '../common/creative/format-specs';
import { S3Service } from '../common/storage/s3.service';

@Controller('creative')
export class CreativeController {
  private readonly logger = new Logger(CreativeController.name);

  constructor(
    private readonly creativeProducer: CreativeProducerService,
    private readonly imageGenerator: ImageGeneratorService,
    private readonly videoGenerator: VideoGeneratorService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly companiesService: CompaniesService,
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Resolves which sized image entry a regenerate/edit call targets — exact
   * (variantIndex, aspectRatio) match when aspectRatio is given and such an
   * entry exists, else the first entry for that variantIndex (the untagged
   * "primary" size — the only entry at all for packages with one image per
   * variant, which is still the common case). Without this, a variant
   * carrying multiple sizes would have regenerate/edit blindly grab
   * whichever entry happens to be first, silently mutating the wrong size.
   */
  private resolveImageEntry(images: any[], variantIndex: number, aspectRatio?: string): any {
    if (aspectRatio) {
      const exact = images.find((img) => img.variantIndex === variantIndex && img.aspectRatio === aspectRatio);
      if (exact) return exact;
    }
    return images.find((img) => img.variantIndex === variantIndex);
  }

  /**
   * GET /api/v1/creative/languages
   * Static list of every canonical language the creative pipeline supports,
   * for a dashboard language picker. Single source of truth stays backend-side.
   */
  @Get('languages')
  getLanguages() {
    return CANONICAL_LANGUAGES;
  }

  /**
   * GET /api/v1/creative/formats
   * Every creative format the pipeline supports, for the dashboard's category
   * picker. Single source of truth stays backend-side (format-specs.ts) —
   * only label/hint/group are exposed, not the prompt-internal fields.
   */
  @Get('formats')
  getFormats() {
    return listFormatSpecs().map(spec => ({
      value: spec.id,
      label: spec.label,
      hint: spec.hint,
      group: spec.group,
      skipVideo: spec.skipVideo,
    }));
  }

  /**
   * GET /api/v1/creative/:tenantId/packages?productName=&targetLanguage=&status=&briefId=
   * Browse the creative library for a tenant. Excludes one-off packages made
   * by pasting URLs directly into a manual campaign (briefId==='manual') —
   * those are single-use, not meant to be reused, and would just clutter a
   * "reusable creative" library view.
   */
  @Get(':tenantId/packages')
  async listPackages(
    @Param('tenantId') tenantId: string,
    @Query('productName') productName?: string,
    @Query('targetLanguage') targetLanguage?: string,
    @Query('status') status?: string,
    @Query('briefId') briefId?: string,
  ) {
    const query: Record<string, unknown> = { tenantId, briefId: { $ne: 'manual' } };
    if (productName) query.productName = productName;
    if (targetLanguage) query.targetLanguage = targetLanguage;
    if (status) query.status = status;
    if (briefId) query.briefId = briefId;

    return this.creativePackageModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
  }

  /**
   * POST /api/v1/creative/:tenantId/product-creative
   * Generate a standalone ad creative (copy + images/video) for a product,
   * outside of any campaign — for the creative library. Same pattern as
   * landingPageTest() below: synthesizes a lightweight BriefData directly
   * from the product's own config, no pre-existing IntelligenceBrief needed.
   *
   * Body: { product: string (required), targetLanguage?, targetSegment?,
   *   angle?, topic?, platform?, format?, audience?, hook?, keyMessage?,
   *   conversionBridge?, audienceStage? }
   */
  @Post(':tenantId/product-creative')
  async productCreative(
    @Param('tenantId') tenantId: string,
    @Body() body: {
      product: string;
      targetLanguage?: string;
      targetSegment?: string;
      angle?: string;
      topic?: string;
      platform?: string;
      format?: string;
      audience?: string;
      hook?: string;
      keyMessage?: string;
      conversionBridge?: string;
      audienceStage?: 'cold' | 'warm' | 'hot';
      carouselPattern?: 'auto' | 'sequential' | 'tier_reveal' | 'story_arc' | 'differentiator_stack' | 'qa' | 'catalog_grid';
      aspectRatio?: AspectRatio;
      imageResolution?: ImageResolution;
      videoAspectRatio?: VideoAspectRatio;
      videoResolution?: VideoResolution;
    },
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    const product = (company.products ?? []).find(p => p.name === body.product);

    if (!body.product || !product) {
      throw new BadRequestException(`Product "${body.product}" not found for tenant ${tenantId}.`);
    }

    const briefId = `product-creative-${Date.now()}`;
    const runId = briefId;

    // Creative inputs — operator-supplied, with neutral fallbacks derived
    // from the product (same fallback pattern as landingPageTest below).
    const briefData: BriefData = {
      product: product.name,
      topic: body.topic ?? `Product creative: ${product.name}`,
      angle: body.angle ?? 'Direct-response ad for this product',
      platform: body.platform ?? 'facebook',
      format: body.format ?? 'image',
      audience: body.audience ?? product.audienceSegments?.[0]?.description ?? (product.description ?? '').slice(0, 120),
      hook: body.hook ?? product.differentiators?.[0] ?? (product.description ?? '').split('.')[0],
      keyMessage: body.keyMessage ?? (product.description ?? '').slice(0, 180),
      conversionBridge: body.conversionBridge ?? 'Tap to learn more.',
      audienceStage: body.audienceStage ?? 'cold',
      targetSegment: body.targetSegment ?? product.audienceSegments?.[0]?.name,
      targetLanguage: body.targetLanguage as any,
      carouselPattern: body.carouselPattern,
      aspectRatio: body.aspectRatio,
      imageResolution: body.imageResolution,
      videoAspectRatio: body.videoAspectRatio,
      videoResolution: body.videoResolution,
    };

    this.logger.log(`Product creative requested: tenant=${tenantId} product=${product.name} briefId=${briefId} aspectRatio=${body.aspectRatio ?? 'format-default'} imageResolution=${body.imageResolution ?? '1K'} videoAspectRatio=${body.videoAspectRatio ?? '9:16'} videoResolution=${body.videoResolution ?? '1080p'}`);

    // Fire and forget — returns immediately, production runs in background.
    // Poll GET :tenantId/packages?briefId=... for the result.
    this.creativeProducer.produce(
      tenantId, briefId, runId, briefData, { forceRegenerate: true },
    ).catch(() => {});

    return { status: 'started', briefId, product: product.name };
  }

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
   * POST /api/v1/creative/:tenantId/rehost-media
   * Re-host an externally-hosted video/image (e.g. a Higgsfield-generated
   * video URL) into our own S3 bucket, so it doesn't depend on the
   * third-party host staying up or the URL staying unsigned/permanent.
   * Returns a permanent S3 URL — paste it into a package's imageUrl/videoUrl
   * via the PATCH endpoint below (or use it directly on a landing page etc).
   * Body: { sourceUrl: string, mediaType?: 'video' | 'image' }
   */
  @Post(':tenantId/rehost-media')
  async rehostMedia(
    @Param('tenantId') tenantId: string,
    @Body() body: { sourceUrl?: string; mediaType?: 'video' | 'image' },
  ) {
    const sourceUrl = body.sourceUrl?.trim();
    if (!sourceUrl) {
      throw new BadRequestException('sourceUrl is required');
    }

    const mediaType = body.mediaType === 'image' ? 'image' : 'video';
    const ext = mediaType === 'image' ? 'png' : 'mp4';
    const contentType = mediaType === 'image' ? 'image/png' : 'video/mp4';
    const key = `${tenantId}/uploads/${Date.now()}.${ext}`;

    this.logger.log(`Re-hosting external ${mediaType} to S3: tenantId=${tenantId} sourceUrl=${sourceUrl}`);

    const url = await this.s3Service.uploadFromUrl(sourceUrl, key, contentType);
    return { url };
  }

  /**
   * PATCH /api/v1/creative/:tenantId/packages/:creativePackageId
   * Manually update imageUrl and/or videoUrl on a creative package.
   */
  /**
   * PATCH /api/v1/creative/:tenantId/packages/:creativePackageId
   * Manually update a specific variant's imageUrl, the video's videoUrl,
   * which variant is "selected" (the one launch() actually uses for video
   * ad sets and the one shown as the primary thumbnail), or the copy text
   * itself (headline/primaryText/cta/hookStyle) — added so a pending
   * campaign's ad copy can be corrected in place instead of deleting and
   * recreating the whole campaign for a wording fix.
   * Body: { variantIndex?: number, imageUrl?: string, aspectRatio?: string,
   *         videoUrl?: string, selectedCopyIndex?: number,
   *         copy?: { headline?, primaryText?, cta?, hookStyle? } }
   * aspectRatio ('9:16' | '1:1' | '4:5' | '16:9') tags which SIZE imageUrl
   * (or videoUrl) is — a variant/video can carry more than one (a human
   * creative team's pre-made sizes); omit it to edit/replace the untagged
   * "primary" size, unchanged from before. A tagged videoUrl goes into the
   * additive `videos[]` array (not the legacy singular `video` field) so a
   * second size doesn't overwrite the first — see
   * MetaAdsService.buildImageAssetFeedSpec / buildVideoAssetFeedSpec for how
   * launch() uses them.
   * NOTE: this package may be shared/reused via the creative library (picked
   * by creativePackageId on a different campaign) — editing copy here
   * changes it everywhere that package is referenced, same as editing
   * imageUrl/videoUrl already does. Not scoped to "manual, one-off" packages
   * only, for consistency with the rest of this endpoint.
   */
  @Patch(':tenantId/packages/:creativePackageId')
  async updatePackage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: {
      variantIndex?: number;
      imageUrl?: string;
      aspectRatio?: string;
      videoUrl?: string;
      selectedCopyIndex?: number;
      copy?: { headline?: string; primaryText?: string; cta?: string; hookStyle?: string };
    },
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const update: any = {};

    if (body.imageUrl !== undefined) {
      const variantIndex = body.variantIndex ?? 0;
      // Update or push the image entry for this (variantIndex, aspectRatio)
      // pair — NOT variantIndex alone, or supplying a second size for the
      // same variant would silently overwrite the first instead of adding to it.
      const images: any[] = (pkg as any).images ?? [];
      const existing = images.find(
        (img: any) => img.variantIndex === variantIndex && (img.aspectRatio ?? undefined) === body.aspectRatio,
      );
      if (existing) {
        existing.imageUrl = body.imageUrl;
      } else {
        images.push({ variantIndex, imagePrompt: '', imageUrl: body.imageUrl, aspectRatio: body.aspectRatio });
      }
      update.images = images;
    }

    if (body.videoUrl !== undefined) {
      if (body.aspectRatio) {
        // A tagged size — goes into videos[] (additive, multi-size), not the
        // legacy singular `video` field, and matched by (variantIndex,
        // aspectRatio) same as images so a second size doesn't clobber the first.
        const variantIndex = body.variantIndex ?? (pkg as any).video?.variantIndex ?? 0;
        const videos: any[] = (pkg as any).videos ?? [];
        const existing = videos.find(
          (v: any) => v.variantIndex === variantIndex && v.aspectRatio === body.aspectRatio,
        );
        if (existing) {
          existing.videoUrl = body.videoUrl;
        } else {
          videos.push({ variantIndex, videoPrompt: '', videoUrl: body.videoUrl, videoThumbnailUrl: '', aspectRatio: body.aspectRatio });
        }
        update.videos = videos;
      } else {
        const currentVideo = (pkg as any).video ?? { variantIndex: 0, videoPrompt: '', videoThumbnailUrl: '' };
        update.video = { ...currentVideo, videoUrl: body.videoUrl };
      }
    }

    if (body.selectedCopyIndex !== undefined) {
      const variantCount = ((pkg as any).copyVariants ?? []).length;
      if (body.selectedCopyIndex < 0 || body.selectedCopyIndex >= variantCount) {
        throw new BadRequestException(`selectedCopyIndex ${body.selectedCopyIndex} is out of range (${variantCount} variants)`);
      }
      update.selectedCopyIndex = body.selectedCopyIndex;
    }

    if (body.copy) {
      const variantIndex = body.variantIndex;
      if (variantIndex === undefined) {
        throw new BadRequestException('variantIndex is required when editing copy');
      }
      const copyVariants: any[] = [...((pkg as any).copyVariants ?? [])];
      if (variantIndex < 0 || variantIndex >= copyVariants.length) {
        throw new BadRequestException(`variantIndex ${variantIndex} is out of range (${copyVariants.length} variants)`);
      }
      const company = await this.companiesService.findByTenantId(tenantId);
      const merged = { ...copyVariants[variantIndex], ...body.copy };
      if (company?.forbiddenTopics?.length) {
        const text = `${merged.headline ?? ''} ${merged.primaryText ?? ''}`.toLowerCase();
        const forbidden = company.forbiddenTopics.find((t) => text.includes(t.toLowerCase()));
        if (forbidden) {
          throw new BadRequestException(`Copy matches forbidden topic "${forbidden}" — not saved`);
        }
      }
      copyVariants[variantIndex] = merged;
      update.copyVariants = copyVariants;
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
    @Body() body: { aspectRatio?: AspectRatio; resolution?: VideoResolution } = {},
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const aspectRatio: AspectRatio = body.aspectRatio ?? ((pkg as any).video?.aspectRatio as AspectRatio) ?? '9:16';
    const resolution: VideoResolution = body.resolution ?? (pkg as any).video?.resolution ?? '1080p';
    const orientationWord = aspectRatio === '9:16' ? 'vertical' : aspectRatio === '16:9' ? 'landscape' : aspectRatio === '1:1' ? 'square' : 'portrait';

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
        liveContext: this.liveContextBuilder.build(company, product?.name),
        userMessage: `
Write a detailed Heygen Video Agent prompt that will be submitted directly to Heygen's API to generate a 15-second ${aspectRatio} ${orientationWord} Meta conversion ad video.

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

1. VIDEO CONCEPT: 15-second ${aspectRatio} ${orientationWord} Meta ad for ${company.name}, cinematic b-roll with text overlays and off-screen Hindi voiceover narration. No visible person speaking.

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
        { $set: { video: { ...currentVideo, videoPrompt: newVideoPrompt, aspectRatio, resolution } } },
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
          aspectRatio,
          resolution,
        );
        const currentVideo = (pkg as any).video ?? { variantIndex: (pkg as any).selectedCopyIndex ?? 0, videoThumbnailUrl: '' };
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { video: { ...currentVideo, videoPrompt: newVideoPrompt, videoUrl: videoResult.videoUrl, videoThumbnailUrl: videoResult.videoThumbnailUrl, aspectRatio, resolution } } },
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
    @Body() body: { variantIndex?: number; aspectRatio?: AspectRatio; resolution?: ImageResolution } = {},
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const existingImages: any[] = (pkg as any).images ?? [];
    const existingForTarget = body.variantIndex !== undefined
      ? this.resolveImageEntry(existingImages, body.variantIndex, body.aspectRatio)
      : undefined;
    const aspectRatio: AspectRatio = body.aspectRatio ?? existingForTarget?.aspectRatio ?? '9:16';
    const resolution: ImageResolution = body.resolution ?? existingForTarget?.resolution ?? '1K';

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
      ? `- TEXT OVERLAY — LOWER (inside the safe zone below): "${product?.name ?? 'Product'}" + CTA in large text. DO NOT include any price (no ₹, no rupees).`
      : `- TEXT OVERLAY — LOWER (inside the safe zone below): "${product?.name ?? 'Product'} — ₹${product?.price ?? '???'}" + CTA in large text`;
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
- TEXT OVERLAY — UPPER (inside the safe zone below): "${hook.slice(0, 80)}" in bold Hinglish, high contrast, readable
${bottomOverlayLine}
- PRODUCT VISIBLE — show ${product?.name ?? 'the product'} clearly
- INDIAN CONTEXT — real Indian faces, settings, skin tones
- HIGH CONTRAST — thumb-stopping colors, no muted/pastel

${aspectRatio === '9:16' ? `SAFE ZONE — CRITICAL, non-negotiable: This vertical image also runs on Feed/Marketplace/Explore placements, which crop it down to 4:5 and 1:1 by keeping only the CENTER of the frame — the outer ~20% at the top and outer ~20% at the bottom get CUT OFF on those placements. Keep BOTH text overlays (and the CTA) inside the CENTER 60% of the vertical frame (roughly 20%-80% of frame height). The outer top/bottom 20% may only hold background/atmosphere — no text, no CTA, nothing critical.` : ''}

${visualInsights}

Format: ${aspectRatio === '9:16' ? 'Vertical 9:16' : aspectRatio === '16:9' ? 'Landscape 16:9' : aspectRatio === '1:1' ? 'Square 1:1' : 'Portrait 4:5'}, photorealistic, 4-5 sentences.
Describe: focal point, emotional tone, text overlay placement (exact words + position within the safe zone), product placement, colors, lighting.

AVOID: generic lifestyle photos, text-free images, muted colors, stock photo look, cluttered composition, any text/CTA placed at the true top or bottom edge of the frame.

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
              liveContext: this.liveContextBuilder.build(company, product?.name),
              userMessage: buildImagePrompt(hook),
              maxTurns: 2,
            });
            const newImagePrompt = result.content.trim();
            const imageResult = await this.imageGenerator.generateFromPrompt(newImagePrompt, company, (pkg as any).runId, aspectRatio, resolution);
            const existingEntry = this.resolveImageEntry(images, i, body.aspectRatio);
            const existingIdx = existingEntry ? images.indexOf(existingEntry) : -1;
            // Keep the resolved entry's own size tag (its exact tag when
            // matched by aspectRatio, or its pre-existing tag on a fallback
            // match) rather than body.aspectRatio, or a fallback match on an
            // untagged/differently-tagged entry would silently relabel it.
            const resolvedAspectRatio = existingEntry?.aspectRatio ?? body.aspectRatio;
            if (existingIdx >= 0) {
              images[existingIdx] = { variantIndex: i, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl, aspectRatio: resolvedAspectRatio, resolution };
            } else {
              images.push({ variantIndex: i, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl, aspectRatio: resolvedAspectRatio, resolution });
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
    @Body() body: { variantIndex?: number; aspectRatio?: AspectRatio; resolution?: ImageResolution } = {},
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const variantIndex = body.variantIndex ?? (pkg as any).selectedCopyIndex ?? 0;
    const images: any[] = (pkg as any).images ?? [];
    const imageEntry = this.resolveImageEntry(images, variantIndex, body.aspectRatio);

    if (!imageEntry?.imagePrompt) {
      return { error: `No imagePrompt saved for variant ${variantIndex} — run full creative production first` };
    }

    const aspectRatio: AspectRatio = body.aspectRatio ?? imageEntry.aspectRatio ?? '9:16';
    const resolution: ImageResolution = body.resolution ?? imageEntry.resolution ?? '1K';

    const company = await this.companiesService.findByTenantId(tenantId);
    this.logger.log(`Regenerating image for variant ${variantIndex}: tenantId=${tenantId} packageId=${creativePackageId} aspectRatio=${aspectRatio} resolution=${resolution}`);

    // Fire and forget
    this.imageGenerator.generateFromPrompt(imageEntry.imagePrompt, company, (pkg as any).runId, aspectRatio, resolution)
      .then(async (result) => {
        const updatedImages = [...images];
        const idx = updatedImages.indexOf(imageEntry);
        if (idx >= 0) updatedImages[idx] = { ...updatedImages[idx], imageUrl: result.imageUrl, aspectRatio, resolution };
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
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/edit-image
   * Edit the EXISTING image with a free-text instruction ("change the
   * headline to X", "make the background blue") instead of regenerating from
   * scratch — feeds the current image back into the provider so most of the
   * image stays intact. Fire-and-forget — poll GET for result.
   * Body: { variantIndex?: number, instruction: string }
   */
  @Post(':tenantId/packages/:creativePackageId/edit-image')
  async editImage(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { variantIndex?: number; instruction?: string; aspectRatio?: AspectRatio; resolution?: ImageResolution } = {},
  ) {
    const instruction = body.instruction?.trim();
    if (!instruction) {
      throw new BadRequestException('instruction is required');
    }

    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const variantIndex = body.variantIndex ?? (pkg as any).selectedCopyIndex ?? 0;
    const images: any[] = (pkg as any).images ?? [];
    const imageEntry = this.resolveImageEntry(images, variantIndex, body.aspectRatio);

    if (!imageEntry?.imageUrl) {
      return { error: `No image exists yet for variant ${variantIndex} — generate one first` };
    }

    const aspectRatio: AspectRatio = body.aspectRatio ?? imageEntry.aspectRatio ?? '9:16';
    const resolution: ImageResolution = body.resolution ?? imageEntry.resolution ?? '1K';

    this.logger.log(`Editing image for variant ${variantIndex}: tenantId=${tenantId} packageId=${creativePackageId} instruction="${instruction.slice(0, 80)}" aspectRatio=${aspectRatio} resolution=${resolution}`);

    // Fire and forget
    this.imageGenerator.editImage(imageEntry.imageUrl, instruction, tenantId, (pkg as any).runId, aspectRatio, resolution)
      .then(async (result) => {
        const updatedImages = [...images];
        const idx = updatedImages.indexOf(imageEntry);
        if (idx >= 0) {
          const editInstructions = [...(updatedImages[idx].editInstructions ?? []), instruction];
          updatedImages[idx] = { ...updatedImages[idx], imageUrl: result.imageUrl, editInstructions, aspectRatio, resolution };
        }
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { images: updatedImages } },
        );
        this.logger.log(`Image edited for variant ${variantIndex}: tenantId=${tenantId} packageId=${creativePackageId}`);
      })
      .catch((err) => this.logger.error(`Image edit failed: ${err.message}`));

    return { status: 'started', creativePackageId, variantIndex, message: 'Image edit started. Poll GET /packages/:id for result.' };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-video
   * Retry video generation using the saved videoPrompt from the Creative Team.
   */
  @Post(':tenantId/packages/:creativePackageId/regenerate-video')
  async regenerateVideo(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { aspectRatio?: AspectRatio; resolution?: VideoResolution } = {},
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const video = (pkg as any).video;
    if (!video?.videoPrompt) return { error: 'No videoPrompt saved — run full creative production first' };

    const aspectRatio: AspectRatio = body.aspectRatio ?? video.aspectRatio ?? '9:16';
    const resolution: VideoResolution = body.resolution ?? video.resolution ?? '1080p';

    this.logger.log(`Regenerating video: tenantId=${tenantId} packageId=${creativePackageId} aspectRatio=${aspectRatio} resolution=${resolution}`);

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
        aspectRatio,
        resolution,
      );
      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        { $set: { video: { ...video, videoUrl: result.videoUrl, videoThumbnailUrl: result.videoThumbnailUrl, aspectRatio, resolution } } },
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
    @Query('force') force?: string,
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

    // Fire and forget — returns immediately, production runs in background.
    // ?force=true bypasses the producer's resume-safe dedup. Use when an
    // operator intentionally re-approves the same brief (e.g. after the
    // previous creative shipped with stale data and was fixed in the brief).
    this.creativeProducer.produce(
      tenantId,
      briefId,
      brief.runId,
      briefData,
      { forceRegenerate: force === 'true' || force === '1' },
    ).catch(() => {});

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

  /**
   * POST /api/v1/creative/:tenantId/landing-page-test
   * Launch a landing-page A/B test for a product: generates ONE creative set,
   * then ships a single campaign with TWO ad sets — identical audience +
   * creatives, differing ONLY by destination URL. Variant A = the product's
   * current landingUrl (control); variant B = body.variantUrl (challenger).
   * Meta's per-ad-set reporting isolates which page converts better; the audit
   * loop surfaces the winner (report-only — never auto-promoted).
   *
   * Body: {
   *   product: string;          // product name (control URL = its landingUrl)
   *   variantUrl: string;       // the challenger landing page (B)
   *   budget: number;           // total daily budget (split 50/50)
   *   audienceType?: string;    // held constant across both ad sets
   *   metaAudienceId?: string;  // e.g. a buyer-lookalike id; auto-resolved if omitted
   *   hook?, keyMessage?, angle?, topic?, platform?, audience?,
   *   conversionBridge?, targetSegment?, targetLanguage?  // creative inputs (defaults derived from product)
   * }
   *
   * Returns immediately; creative generation + campaign creation run in the
   * background. The campaign is saved as pending_approval — approve it via
   * POST /campaigns/:tenantId/:campaignId/approve to go live.
   */
  @Post(':tenantId/landing-page-test')
  async landingPageTest(
    @Param('tenantId') tenantId: string,
    @Body() body: {
      product: string;
      variantUrl: string;
      controlUrl?: string;      // defaults to the product's current landingUrl; pass to test two arbitrary pages
      budget: number;
      audienceType?: string;
      metaAudienceId?: string;
      hook?: string;
      keyMessage?: string;
      angle?: string;
      topic?: string;
      platform?: string;
      audience?: string;
      conversionBridge?: string;
      targetSegment?: string;
      targetLanguage?: string;
    },
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    const product = (company.products ?? []).find(p => p.name === body.product);

    // ── Synchronous validation — surface user errors as 400s before the
    //    long-running background job kicks off. createLandingPageTest
    //    re-validates as defense-in-depth. ──────────────────────────────────
    if (!body.product || !product) {
      throw new BadRequestException(`Product "${body.product}" not found for tenant ${tenantId}.`);
    }
    // Control = explicit controlUrl (to test two NEW pages head-to-head) or the
    // product's current landingUrl by default (current vs new).
    const controlUrl = body.controlUrl ?? product.landingUrl ?? '';
    if (!controlUrl) {
      throw new BadRequestException(`No control URL: product "${product.name}" has no landingUrl and no controlUrl was provided. Pass controlUrl (page A) to test two new pages.`);
    }
    if (!body.variantUrl) {
      throw new BadRequestException(`variantUrl (page B) is required.`);
    }
    if (body.variantUrl === controlUrl) {
      throw new BadRequestException(`variantUrl (B) must differ from controlUrl (A).`);
    }
    if (!body.budget || body.budget <= 0) {
      throw new BadRequestException(`A positive budget is required.`);
    }
    if (product.landingPageTest?.status === 'running') {
      throw new BadRequestException(`A landing-page test is already running for "${product.name}" (campaign ${product.landingPageTest.campaignId}). Conclude it before starting another.`);
    }

    const briefId = `lp-test-${Date.now()}`;
    const runId = briefId;

    // Creative inputs — operator-supplied, with neutral fallbacks derived from
    // the product (no hardcoded copy). Format forced to image: the test holds
    // ONE creative set constant across both ad sets, and image keeps the
    // launch path off the mixed/video split logic.
    const briefData: BriefData = {
      product: product.name,
      topic: body.topic ?? `Landing page test: ${product.name}`,
      angle: body.angle ?? 'Direct-response ad driving clicks to the landing page',
      platform: body.platform ?? 'facebook',
      format: 'image',
      audience: body.audience ?? product.audienceSegments?.[0]?.description ?? (product.description ?? '').slice(0, 120),
      hook: body.hook ?? product.differentiators?.[0] ?? (product.description ?? '').split('.')[0],
      keyMessage: body.keyMessage ?? (product.description ?? '').slice(0, 180),
      conversionBridge: body.conversionBridge ?? 'Tap to explore the full details on the page.',
      audienceStage: 'cold',
      targetSegment: body.targetSegment ?? product.audienceSegments?.[0]?.name,
      targetLanguage: body.targetLanguage as any,
    };

    this.logger.log(`Landing-page test requested: tenant=${tenantId} product=${product.name} variantUrl=${body.variantUrl} budget=₹${body.budget}`);

    // Fire-and-forget: generate creative, then build the pending_approval
    // campaign. Heavy (copy + image generation) — runs in the background.
    (async () => {
      try {
        const pkg = await this.creativeProducer.produce(
          tenantId, briefId, runId, briefData, { forceRegenerate: true },
        );
        await this.campaignCreator.createLandingPageTest({
          tenantId, briefId, runId, briefData,
          creativePackage: pkg,
          company,
          productName: product.name,
          controlUrl,
          variantUrl: body.variantUrl,
          budget: body.budget,
          audienceType: body.audienceType,
          metaAudienceId: body.metaAudienceId,
        });
        this.logger.log(`Landing-page test campaign created (pending_approval): tenant=${tenantId} product=${product.name} briefId=${briefId}`);
      } catch (err: any) {
        this.logger.error(`Landing-page test creation failed for ${tenantId}/${product.name}: ${err.message}`);
      }
    })().catch(() => {});

    return {
      status: 'started',
      product: product.name,
      briefId,
      control: controlUrl,
      variant: body.variantUrl,
      message: 'Generating creative, then creating the landing-page-test campaign as pending_approval. Poll GET /campaigns/:tenantId for the LP_TEST_* campaign, then approve it to launch.',
    };
  }
}
