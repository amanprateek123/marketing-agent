import { Controller, Get, Post, Patch, Param, Body, NotFoundException, BadRequestException, Logger, Query, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreativeProducerService, BriefData } from './creative-producer/creative-producer.service';
import { ImageGeneratorService } from './image-generator/image-generator.service';
import { VideoGeneratorService } from './video-generator/video-generator.service';
import { HiggsfieldService } from './video-generator/higgsfield.service';
import { CartesiaService } from './video-generator/cartesia.service';
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
import { parseRobustJson } from '../common/llm/robust-json-parser.util';
import { GalleryService } from '../gallery/gallery.service';
import {
  HOOK_STYLES_DR, HOOK_STYLES_MEME, HOOK_STYLES_SCREENSHOT, HOOK_STYLES_POLL,
  HOOK_STYLE_DESCRIPTIONS, HOOK_STYLE_DESCRIPTIONS_MEME, HOOK_STYLE_DESCRIPTIONS_SCREENSHOT, HOOK_STYLE_DESCRIPTIONS_POLL,
} from '../common/creative/hook-styles';

/** Shared body shape for both POST packages/upload and POST packages/upload-bulk (one entry per item there). */
interface UploadCreativeItem {
  productName?: string;
  targetLanguage?: string;
  topic?: string;
  /**
   * When set, the asset(s) go straight into THIS existing Gallery sheet
   * instead of the resolved topic's "Unsorted" sheet — used by the Gallery
   * topic page's own upload form, so an upload made from within a specific
   * sheet lands there directly rather than needing a manual move
   * afterward. Takes priority over `topic` when both are set.
   */
  sheetId?: string;
  copy?: { headline?: string; primaryText?: string; cta?: string };
  assetType?: 'image' | 'video';
  sourceUrl?: string;
  aspectRatio?: string;
  resolution?: string;
}

@Controller('creative')
export class CreativeController {
  private readonly logger = new Logger(CreativeController.name);

  constructor(
    private readonly creativeProducer: CreativeProducerService,
    private readonly imageGenerator: ImageGeneratorService,
    private readonly videoGenerator: VideoGeneratorService,
    private readonly higgsfieldService: HiggsfieldService,
    private readonly cartesiaService: CartesiaService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly companiesService: CompaniesService,
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    private readonly s3Service: S3Service,
    private readonly galleryService: GalleryService,
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
   * GET /api/v1/creative/hook-styles
   * Every hookStyle the pipeline supports, grouped by which format they apply
   * to (the DR 7 apply to image/video/carousel/native; meme/screenshot/poll
   * have their own small sets) — lets a dashboard picker force a specific
   * hookStyle instead of letting the Creative Team auto-pick one per variant.
   * Single source of truth stays backend-side (hook-styles.ts).
   */
  @Get('hook-styles')
  getHookStyles() {
    return {
      dr: HOOK_STYLES_DR.map(value => ({ value, description: HOOK_STYLE_DESCRIPTIONS[value] })),
      meme: HOOK_STYLES_MEME.map(value => ({ value, description: HOOK_STYLE_DESCRIPTIONS_MEME[value] })),
      screenshot: HOOK_STYLES_SCREENSHOT.map(value => ({ value, description: HOOK_STYLE_DESCRIPTIONS_SCREENSHOT[value] })),
      poll: HOOK_STYLES_POLL.map(value => ({ value, description: HOOK_STYLE_DESCRIPTIONS_POLL[value] })),
    };
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
      /** Forces every copy variant (and its matching image prompt) to this one hookStyle instead of the Creative Team auto-picking one per variant. Ignored when hookStyles[] is also set. */
      forcedHookStyle?: string;
      /** Explicit per-variant hookStyle plan, operator-picked from the dashboard — its length becomes the variant count, and variant i is locked to hookStyles[i]. Overrides forcedHookStyle when both are set. */
      hookStyles?: string[];
      /** Which engine renders the video — defaults to 'heygen' when omitted. */
      videoProvider?: 'heygen' | 'higgsfield';
      /** Higgsfield model job_type (e.g. 'seedance_2_0') — only used when videoProvider === 'higgsfield'. */
      higgsfieldJobType?: string;
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
      forcedHookStyle: body.forcedHookStyle,
      hookStyles: body.hookStyles,
      videoProvider: body.videoProvider,
      higgsfieldJobType: body.higgsfieldJobType,
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
   * POST /api/v1/creative/:tenantId/upload-file
   * Upload a local file (image/video picked or dropped in the browser)
   * straight to this tenant's S3 bucket — the file-upload counterpart to
   * rehostMedia below, for when you have the asset on disk rather than
   * already hosted at a URL. Returns a permanent S3 URL, same shape as
   * rehostMedia, so callers (e.g. the creative upload form) can treat both
   * paths identically once they get a URL back.
   * multipart/form-data body: single field named "file".
   */
  @Post(':tenantId/upload-file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 250 * 1024 * 1024 } }))
  async uploadFile(
    @Param('tenantId') tenantId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!/^image\/|^video\//.test(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
    }

    const ext = file.originalname.split('.').pop()?.toLowerCase() || (file.mimetype.startsWith('video') ? 'mp4' : 'png');
    const key = `${tenantId}/uploads/${Date.now()}.${ext}`;

    this.logger.log(`Uploading local file to S3: tenantId=${tenantId} originalname=${file.originalname} size=${file.size}`);

    const url = await this.s3Service.uploadBuffer(file.buffer, key, file.mimetype);
    return { url };
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
   * POST /api/v1/creative/:tenantId/packages/upload
   * Register an already-made creative (a single image or video you already
   * have, not generated by this pipeline) as a real library entry — unlike
   * the manual-campaign one-off path (briefId==='manual'), this shows up in
   * the creative library AND auto-populates the Gallery, exactly like an
   * AI-generated package does. Rehosts sourceUrl onto this tenant's own S3
   * first (same convention as rehostMedia above) so it doesn't depend on
   * wherever it currently lives staying up.
   * Body: { productName?, targetLanguage?, topic?,
   *   copy: { headline: string, primaryText: string, cta: string },
   *   assetType: 'image' | 'video', sourceUrl: string,
   *   aspectRatio?: string, resolution?: string }
   */
  @Post(':tenantId/packages/upload')
  async uploadCreative(@Param('tenantId') tenantId: string, @Body() body: UploadCreativeItem) {
    return this.uploadOneCreative(tenantId, body);
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/upload-bulk
   * Same as upload above, but takes an array — for filing several
   * already-made creatives into the library (and Gallery) in one request
   * instead of one form submission per asset. Processed independently
   * (Promise.allSettled), so one bad URL doesn't block the rest of the
   * batch — returns a per-item result array in the same order as the input.
   * Body: { items: UploadCreativeItem[] } — each item has the same shape as
   * the single-upload body above.
   */
  @Post(':tenantId/packages/upload-bulk')
  async uploadCreativeBulk(
    @Param('tenantId') tenantId: string,
    @Body() body: { items?: UploadCreativeItem[] },
  ) {
    if (!body.items?.length) throw new BadRequestException('items is required');

    const results = await Promise.allSettled(
      body.items.map(item => this.uploadOneCreative(tenantId, item)),
    );
    return results.map((result, i) =>
      result.status === 'fulfilled'
        ? { ...result.value, sourceUrl: body.items![i].sourceUrl }
        : { status: 'failed', error: result.reason?.message ?? 'Upload failed', sourceUrl: body.items![i].sourceUrl },
    );
  }

  private async uploadOneCreative(tenantId: string, body: UploadCreativeItem) {
    const sourceUrl = body.sourceUrl?.trim();
    if (!sourceUrl) throw new BadRequestException('sourceUrl is required');
    const assetType = body.assetType === 'video' ? 'video' : 'image';
    const headline = body.copy?.headline?.trim();
    const primaryText = body.copy?.primaryText?.trim();
    const cta = body.copy?.cta?.trim();
    if (!headline || !primaryText || !cta) {
      throw new BadRequestException('copy.headline, copy.primaryText, and copy.cta are required');
    }

    const ext = assetType === 'image' ? 'png' : 'mp4';
    const contentType = assetType === 'image' ? 'image/png' : 'video/mp4';
    const key = `${tenantId}/uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    this.logger.log(`Uploading external ${assetType} to S3 for a new library creative: tenantId=${tenantId} sourceUrl=${sourceUrl}`);
    const hostedUrl = await this.s3Service.uploadFromUrl(sourceUrl, key, contentType);

    const briefId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const images = assetType === 'image'
      ? [{ variantIndex: 0, imagePrompt: '', imageUrl: hostedUrl, aspectRatio: body.aspectRatio, resolution: body.resolution }]
      : [];
    const video = assetType === 'video'
      ? { variantIndex: 0, videoPrompt: '', videoUrl: hostedUrl, videoThumbnailUrl: '', aspectRatio: body.aspectRatio, resolution: body.resolution }
      : null;

    const pkg = await this.creativePackageModel.create({
      tenantId,
      runId: briefId,
      briefId,
      status: 'completed',
      productName: body.productName ?? '',
      targetLanguage: body.targetLanguage ?? '',
      copyVariants: [{ headline, primaryText, cta, hookStyle: 'uploaded' }],
      selectedCopyIndex: 0,
      images,
      video,
      completedAt: new Date(),
    });

    try {
      if (body.sheetId) {
        await this.galleryService.populateSheet(tenantId, body.sheetId, pkg._id.toString(), images as any, video as any, []);
      } else {
        await this.galleryService.autoPopulate(
          tenantId,
          body.topic || body.productName || 'Uploaded creatives',
          pkg._id.toString(),
          images as any,
          video as any,
          [],
        );
      }
    } catch (galleryErr: any) {
      this.logger.error(`Gallery auto-populate failed for uploaded package ${pkg._id}: ${galleryErr.message}`);
    }

    return { status: 'completed', packageId: pkg._id.toString() };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/reject-asset
   * Soft-delete, reversible, per-asset (one image or the video, never the
   * whole package) — sets `rejected: true`. Never read by campaign launch
   * code, so a rejected-but-still-referenced asset stays fully launchable;
   * this is purely a visibility/organization flag (see schema comment).
   * The Gallery's live-resolve join hides rejected assets from their sheet
   * automatically — restoring makes it reappear there, unchanged.
   * Body: { assetType: 'image' | 'video', variantIndex: number }
   */
  @Post(':tenantId/packages/:creativePackageId/reject-asset')
  async rejectAsset(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { assetType?: 'image' | 'video'; variantIndex?: number },
  ) {
    return this.setAssetRejected(tenantId, creativePackageId, body.assetType, body.variantIndex, true);
  }

  /** POST /api/v1/creative/:tenantId/packages/:creativePackageId/restore-asset — inverse of reject-asset. */
  @Post(':tenantId/packages/:creativePackageId/restore-asset')
  async restoreAsset(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { assetType?: 'image' | 'video'; variantIndex?: number },
  ) {
    return this.setAssetRejected(tenantId, creativePackageId, body.assetType, body.variantIndex, false);
  }

  private async setAssetRejected(
    tenantId: string,
    creativePackageId: string,
    assetType: 'image' | 'video' | undefined,
    variantIndex: number | undefined,
    rejected: boolean,
  ) {
    if (assetType !== 'image' && assetType !== 'video') throw new BadRequestException('assetType must be "image" or "video"');
    if (variantIndex == null) throw new BadRequestException('variantIndex is required');

    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    if (assetType === 'video') {
      if (!pkg.video) throw new NotFoundException(`Package ${creativePackageId} has no video`);
      await this.creativePackageModel.updateOne({ _id: creativePackageId, tenantId }, { $set: { 'video.rejected': rejected } });
    } else {
      const images = [...(pkg.images ?? [])];
      const idx = images.findIndex((i: any) => i.variantIndex === variantIndex);
      if (idx < 0) throw new NotFoundException(`No image at variantIndex ${variantIndex} in package ${creativePackageId}`);
      images[idx] = { ...images[idx], rejected } as any;
      await this.creativePackageModel.updateOne({ _id: creativePackageId, tenantId }, { $set: { images } });
    }

    return { packageId: creativePackageId, assetType, variantIndex, rejected };
  }

  /**
   * GET /api/v1/creative/:tenantId/rejected-assets
   * Every rejected image/video across all packages for this tenant — powers
   * the "Rejected" tab on the creative library page.
   */
  @Get(':tenantId/rejected-assets')
  async listRejectedAssets(@Param('tenantId') tenantId: string) {
    const packages = await this.creativePackageModel
      .find({ tenantId, $or: [{ 'images.rejected': true }, { 'video.rejected': true }] })
      .select('images video productName')
      .lean()
      .exec();

    const rejected: Array<{ packageId: string; assetType: 'image' | 'video'; variantIndex: number; assetUrl: string; productName?: string }> = [];
    for (const pkg of packages) {
      for (const img of (pkg as any).images ?? []) {
        if (img.rejected) {
          rejected.push({ packageId: pkg._id.toString(), assetType: 'image', variantIndex: img.variantIndex, assetUrl: img.imageUrl, productName: (pkg as any).productName });
        }
      }
      if ((pkg as any).video?.rejected) {
        rejected.push({ packageId: pkg._id.toString(), assetType: 'video', variantIndex: 0, assetUrl: (pkg as any).video.videoUrl, productName: (pkg as any).productName });
      }
    }
    return rejected;
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
            // Fresh generation — new base image, so any prior edit chain no longer applies.
            if (existingIdx >= 0) {
              images[existingIdx] = { variantIndex: i, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl, originalImageUrl: imageResult.imageUrl, editInstructions: [], aspectRatio: resolvedAspectRatio, resolution };
            } else {
              images.push({ variantIndex: i, imagePrompt: newImagePrompt, imageUrl: imageResult.imageUrl, originalImageUrl: imageResult.imageUrl, editInstructions: [], aspectRatio: resolvedAspectRatio, resolution });
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
        // Fresh generation — new base image, so any prior edit chain no longer applies.
        if (idx >= 0) updatedImages[idx] = { ...updatedImages[idx], imageUrl: result.imageUrl, originalImageUrl: result.imageUrl, editInstructions: [], aspectRatio, resolution };
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

    // Lock in the TRUE original the first time this variant is edited — every
    // edit call (this one and all future ones) re-applies the FULL
    // instruction list to this same source image, never to a previous edit's
    // output, so quality doesn't compound-degrade across rounds. See
    // ImageGeneratorService.editImage for why.
    const originalImageUrl = imageEntry.originalImageUrl ?? imageEntry.imageUrl;
    const allInstructions = [...(imageEntry.editInstructions ?? []), instruction];

    this.logger.log(`Editing image for variant ${variantIndex}: tenantId=${tenantId} packageId=${creativePackageId} rounds=${allInstructions.length} instruction="${instruction.slice(0, 80)}" aspectRatio=${aspectRatio} resolution=${resolution}`);

    // Fire and forget
    this.imageGenerator.editImage(originalImageUrl, allInstructions, tenantId, (pkg as any).runId, aspectRatio, resolution)
      .then(async (result) => {
        const updatedImages = [...images];
        const idx = updatedImages.indexOf(imageEntry);
        if (idx >= 0) {
          updatedImages[idx] = { ...updatedImages[idx], imageUrl: result.imageUrl, originalImageUrl, editInstructions: allInstructions, aspectRatio, resolution };
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
   * GET /api/v1/creative/higgsfield/models
   * Video models available through the Higgsfield CLI (Seedance, Kling, Veo,
   * Wan, Hailuo, ...) — proxied live from `higgsfield model list --video`,
   * not a hardcoded list, so new models show up without a redeploy.
   */
  @Get('higgsfield/models')
  async getHiggsfieldModels() {
    return this.higgsfieldService.listVideoModels();
  }

  /**
   * GET /api/v1/creative/higgsfield/models/:jobType
   * Full accepted-params schema for one Higgsfield model (name/type/default/
   * enum/required) — drives the dashboard's generation form so each model
   * shows its own real params instead of a one-size-fits-all form.
   */
  @Get('higgsfield/models/:jobType')
  async getHiggsfieldModel(@Param('jobType') jobType: string) {
    return this.higgsfieldService.getModel(jobType);
  }

  /**
   * POST /api/v1/creative/higgsfield/cost
   * Dry-run credit estimate for a given model + params — no job is created.
   * Body: { jobType: string, params: Record<string, unknown> }
   */
  @Post('higgsfield/cost')
  async getHiggsfieldCost(@Body() body: { jobType?: string; params?: Record<string, unknown> }) {
    if (!body.jobType) throw new BadRequestException('jobType is required');
    const credits = await this.higgsfieldService.estimateCost(body.jobType, body.params ?? {});
    return { credits };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/higgsfield-write-prompt
   * Expands a topic into a detailed Higgsfield/Seedance-style video prompt —
   * pure cinematic scene description (subject, action, camera, lighting,
   * lens, mood), deliberately NO text overlays/CTA/typography, unlike the
   * Heygen "Video Agent" path — Higgsfield's models render straight b-roll
   * footage, not a text-overlay ad renderer. Synchronous (an LLM call, not a
   * video render) — returns the prompt text directly so it can be reviewed
   * and edited before spending real Higgsfield credits on generation.
   * Body: { topic: string, jobType?: string, duration?: number }
   */
  @Post(':tenantId/packages/:creativePackageId/higgsfield-write-prompt')
  async writeHiggsfieldPrompt(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { topic?: string; jobType?: string; duration?: number },
  ) {
    const topic = body.topic?.trim();
    if (!topic) throw new BadRequestException('topic is required');

    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const company = await this.companiesService.findByTenantId(tenantId);
    const brief = (pkg as any).briefId
      ? await this.intelligenceBriefModel.findOne({ tenantId, briefId: (pkg as any).briefId }).lean().exec()
      : null;
    const product = (company.products ?? []).find(p => p.name === (brief as any)?.product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0];

    const duration = body.duration ?? 5;
    const hidePrice = !!product?.hidePriceInCreative;

    this.logger.log(`Writing Higgsfield prompt: tenantId=${tenantId} packageId=${creativePackageId} topic="${topic.slice(0, 60)}"`);

    const result = await this.claudeService.runAgent({
      tenantId,
      runId: (pkg as any).runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company, product?.name),
      userMessage: `
Write a single detailed video-generation prompt for Higgsfield's Seedance model, to produce a ${duration}-second continuous cinematic shot.

TOPIC: ${topic}
Brand: ${company.name}
${product ? `Product: ${product.name}${hidePrice ? ' (do not mention price)' : ` — ₹${product.price ?? '???'}`}` : ''}

This is a text-to-video model, NOT a text-overlay ad renderer — do NOT write any on-screen text, captions, CTA, price, or typography instructions. Describe pure b-roll/cinematic footage only: who/what is in frame, the setting, the action taking place, camera movement (e.g. slow dolly out, static, handheld), lighting (e.g. soft golden hour, warm interior), lens/technical detail (e.g. 50mm shallow depth of field, Sony FX3 style), and mood/genre. Keep the action simple enough to read clearly in ${duration} seconds — one continuous beat, not a multi-scene story.

Return ONLY the prompt text. No explanation, no JSON, no labels, no quotes around it.
      `.trim(),
      maxTurns: 2,
    });

    return { prompt: result.content.trim() };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/generate-higgsfield
   * Generate a video via any Higgsfield model (Seedance/Kling/Veo/...) for this
   * package. Additive — appends to `videos[]` tagged with provider/providerModel
   * rather than overwriting the existing (Heygen) `video` field, so a Higgsfield
   * test doesn't destroy what's already there. Fire-and-forget — poll GET
   * /packages/:id for the result.
   * Body: { jobType: string, params: Record<string, unknown>, variantIndex?: number }
   *   `params` should include `prompt` plus whatever that model's schema
   *   accepts (aspect_ratio, resolution, duration, mode, ...) — see
   *   GET /higgsfield/models/:jobType for the real shape.
   */
  @Post(':tenantId/packages/:creativePackageId/generate-higgsfield')
  async generateHiggsfieldVideo(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { jobType?: string; params?: Record<string, unknown>; variantIndex?: number },
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);
    if (!body.jobType) throw new BadRequestException('jobType is required');
    if (!body.params?.prompt) throw new BadRequestException('params.prompt is required');

    const jobType = body.jobType;
    const params = body.params;
    const variantIndex = body.variantIndex ?? (pkg as any).selectedCopyIndex ?? 0;

    this.logger.log(`Generating Higgsfield video: tenantId=${tenantId} packageId=${creativePackageId} jobType=${jobType}`);

    // Fire and forget
    (async () => {
      const result = await this.higgsfieldService.generateVideo(
        jobType,
        params,
        async (jobId: string) => {
          await this.creativePackageModel.updateOne(
            { _id: creativePackageId, tenantId },
            { $set: { higgsfieldJobId: jobId } },
          );
          this.logger.log(`Higgsfield jobId persisted: ${jobId} packageId=${creativePackageId}`);
        },
      );
      await this.creativePackageModel.updateOne(
        { _id: creativePackageId, tenantId },
        {
          $push: {
            videos: {
              variantIndex,
              videoPrompt: String(params.prompt),
              videoUrl: result.videoUrl,
              videoThumbnailUrl: result.thumbnailUrl,
              aspectRatio: params.aspect_ratio,
              resolution: params.resolution,
              provider: 'higgsfield',
              providerModel: jobType,
            },
          },
        },
      );
      this.logger.log(`Higgsfield video generated: tenantId=${tenantId} packageId=${creativePackageId}`);
    })().catch((err) => this.logger.error(`Higgsfield video generation failed: ${err.message}`));

    return { status: 'started', creativePackageId, message: 'Higgsfield video generation started. Poll GET /packages/:id for result.' };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/higgsfield-scenes/plan
   * Plans a scene-by-scene Higgsfield video build: splits totalDurationSeconds
   * into N scenes at jobType's verified minimum chunk size (only
   * seedance_2_0/seedance_2_0_mini are supported — see
   * HiggsfieldService.VERIFIED_SCENE_MODEL_FLOORS), then writes N distinct
   * cinematic, no-text-overlay prompts forming a hook -> development -> payoff
   * arc around the topic. Each scene is framed as an independent, discrete
   * shot (hard cuts, no continuity) since there's no frame-conditioning
   * between separately-generated clips. Synchronous (LLM-only, nothing
   * generated yet) so the plan can be reviewed/edited before any spend.
   * Overwrites any existing videoScenes on this package.
   * Body: { topic: string, jobType: string, totalDurationSeconds: number,
   *   aspectRatio?: string, resolution?: string }
   */
  @Post(':tenantId/packages/:creativePackageId/higgsfield-scenes/plan')
  async planHiggsfieldScenes(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { topic?: string; jobType?: string; totalDurationSeconds?: number; aspectRatio?: string; resolution?: string },
  ) {
    const topic = body.topic?.trim();
    if (!topic) throw new BadRequestException('topic is required');
    if (!body.jobType) throw new BadRequestException('jobType is required');
    if (!body.totalDurationSeconds) throw new BadRequestException('totalDurationSeconds is required');

    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);

    const jobType = body.jobType;
    const aspectRatio = body.aspectRatio ?? '9:16';
    const resolution = body.resolution ?? '480p';

    let durations: number[];
    try {
      durations = this.higgsfieldService.planSceneDurations(body.totalDurationSeconds, jobType);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    const brief = (pkg as any).briefId
      ? await this.intelligenceBriefModel.findOne({ tenantId, briefId: (pkg as any).briefId }).lean().exec()
      : null;
    const product = (company.products ?? []).find(p => p.name === (brief as any)?.product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0];
    const hidePrice = !!product?.hidePriceInCreative;

    this.logger.log(`Planning Higgsfield scenes: tenantId=${tenantId} packageId=${creativePackageId} scenes=${durations.length} topic="${topic.slice(0, 60)}"`);

    const result = await this.claudeService.runAgent({
      tenantId,
      runId: (pkg as any).runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company, product?.name),
      userMessage: `
Write ${durations.length} short video-generation prompts for Higgsfield's Seedance model, one per scene, that together form a coherent mini narrative arc (hook -> development -> payoff) around this topic — built to actually attract and hold attention, not generic filler. Each scene is rendered as an INDEPENDENT, DISCRETE shot with no frame-conditioning from the others — hard cuts between scenes, not continuous camera motion — so do NOT write anything like "continuing from the previous shot".

TOPIC: ${topic}
Brand: ${company.name}
${product ? `Product: ${product.name}${hidePrice ? ' (do not mention price)' : ` — ₹${product.price ?? '???'}`}` : ''}

Scene durations (seconds), in order: ${durations.join(', ')}

This is a text-to-video model, NOT a text-overlay ad renderer — do NOT write any on-screen text, captions, CTA, price, or typography instructions in ANY scene. Each scene prompt describes pure b-roll/cinematic footage only: who/what is in frame, the setting, the action taking place, camera movement, lighting, lens/technical detail, and mood/genre — sized to that scene's own duration (a 4-second scene needs ONE simple, clearly-readable action, not a sequence of events).

CHARACTER CONSISTENCY (critical — each scene is generated independently with NO shared reference image or frame-conditioning between them, so the model has nothing to anchor "same person" on except your own wording): if the same character (protagonist, reader, any recurring person) appears in more than one scene, you MUST repeat their EXACT physical description verbatim in every scene they appear in — same age, gender, skin tone, hair (style/color/length), and exact clothing (garment + color) every single time. Do not vary the wording ("a person" in scene 1 vs "the person" in scene 3 is NOT enough) — literally copy-paste the same descriptive phrase for that character into each scene's prompt. Decide each recurring character's full physical description BEFORE writing scene 1, then reuse it identically.

Return ONLY this JSON (no markdown, no explanation):
{"scenes": ["prompt for scene 1", "prompt for scene 2", ...]}
The array MUST have exactly ${durations.length} entries, in order.
      `.trim(),
      maxTurns: 2,
    });

    const parsed = parseRobustJson<{ scenes?: string[] }>(result.content);
    const scenePrompts = parsed.scenes;
    if (!Array.isArray(scenePrompts) || scenePrompts.length !== durations.length) {
      throw new Error(`Scene plan mismatch: expected ${durations.length} scenes, got ${scenePrompts?.length ?? 0}`);
    }

    const videoScenes = durations.map((durationSeconds, sceneIndex) => ({
      sceneIndex,
      prompt: scenePrompts[sceneIndex],
      durationSeconds,
      aspectRatio,
      resolution,
      videoUrl: '',
      status: 'pending' as const,
      provider: 'higgsfield' as const,
      providerModel: jobType,
      higgsfieldJobId: null,
    }));

    await this.creativePackageModel.updateOne(
      { _id: creativePackageId, tenantId },
      { $set: { videoScenes, videoTotalDurationSeconds: body.totalDurationSeconds } },
    );

    return { videoScenes };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/higgsfield-scenes/generate
   * Generates every pending/failed scene in videoScenes, SEQUENTIALLY —
   * Higgsfield/the CLI's rate limits are unverified and this module has no
   * queue, so scenes are generated one at a time, not in parallel. Persists
   * each scene's result via a positional update as soon as it completes, so
   * the frontend can poll and show progress scene-by-scene instead of
   * all-or-nothing. Fire-and-forget.
   */
  @Post(':tenantId/packages/:creativePackageId/higgsfield-scenes/generate')
  async generateHiggsfieldScenes(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);
    const scenes = ((pkg as any).videoScenes ?? []) as any[];
    if (scenes.length === 0) throw new BadRequestException('No scenes planned — call higgsfield-scenes/plan first');

    this.logger.log(`Generating Higgsfield scenes: tenantId=${tenantId} packageId=${creativePackageId} count=${scenes.length}`);

    // Fire and forget — sequential, one scene at a time
    (async () => {
      for (const scene of scenes) {
        if (scene.status === 'completed') continue;
        try {
          const result = await this.higgsfieldService.generateVideo(
            scene.providerModel,
            { prompt: scene.prompt, duration: scene.durationSeconds, aspect_ratio: scene.aspectRatio, resolution: scene.resolution },
            async (jobId: string) => {
              await this.creativePackageModel.updateOne(
                { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': scene.sceneIndex },
                { $set: { 'videoScenes.$.higgsfieldJobId': jobId } },
              );
            },
          );
          await this.creativePackageModel.updateOne(
            { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': scene.sceneIndex },
            { $set: { 'videoScenes.$.videoUrl': result.videoUrl, 'videoScenes.$.status': 'completed', 'videoScenes.$.error': '' } },
          );
          this.logger.log(`Scene generated: packageId=${creativePackageId} sceneIndex=${scene.sceneIndex}`);
        } catch (err: any) {
          await this.creativePackageModel.updateOne(
            { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': scene.sceneIndex },
            { $set: { 'videoScenes.$.status': 'failed', 'videoScenes.$.error': err.message } },
          );
          this.logger.error(`Scene generation failed: packageId=${creativePackageId} sceneIndex=${scene.sceneIndex} | ${err.message}`);
        }
      }
    })().catch((err) => this.logger.error(`Scene generation loop failed: ${err.message}`));

    return { status: 'started', creativePackageId, sceneCount: scenes.length };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/higgsfield-scenes/:sceneIndex/regenerate
   * Regenerates a single scene in place — the whole point of chunked
   * generation is not having to redo the entire video for one bad clip.
   * Body: { prompt?: string } — optional edited prompt; falls back to the
   * scene's currently-stored prompt if omitted.
   */
  @Post(':tenantId/packages/:creativePackageId/higgsfield-scenes/:sceneIndex/regenerate')
  async regenerateHiggsfieldScene(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Param('sceneIndex') sceneIndexParam: string,
    @Body() body: { prompt?: string },
  ) {
    const sceneIndex = Number(sceneIndexParam);
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);
    const scene = ((pkg as any).videoScenes ?? []).find((s: any) => s.sceneIndex === sceneIndex);
    if (!scene) throw new NotFoundException(`Scene ${sceneIndex} not found on package ${creativePackageId}`);

    const prompt = body.prompt?.trim() || scene.prompt;

    this.logger.log(`Regenerating Higgsfield scene: tenantId=${tenantId} packageId=${creativePackageId} sceneIndex=${sceneIndex}`);

    await this.creativePackageModel.updateOne(
      { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': sceneIndex },
      { $set: { 'videoScenes.$.prompt': prompt, 'videoScenes.$.status': 'pending', 'videoScenes.$.videoUrl': '', 'videoScenes.$.error': '' } },
    );

    // Fire and forget
    (async () => {
      try {
        const result = await this.higgsfieldService.generateVideo(
          scene.providerModel,
          { prompt, duration: scene.durationSeconds, aspect_ratio: scene.aspectRatio, resolution: scene.resolution },
          async (jobId: string) => {
            await this.creativePackageModel.updateOne(
              { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': sceneIndex },
              { $set: { 'videoScenes.$.higgsfieldJobId': jobId } },
            );
          },
        );
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': sceneIndex },
          { $set: { 'videoScenes.$.videoUrl': result.videoUrl, 'videoScenes.$.status': 'completed', 'videoScenes.$.error': '' } },
        );
        this.logger.log(`Scene regenerated: packageId=${creativePackageId} sceneIndex=${sceneIndex}`);
      } catch (err: any) {
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId, 'videoScenes.sceneIndex': sceneIndex },
          { $set: { 'videoScenes.$.status': 'failed', 'videoScenes.$.error': err.message } },
        );
        this.logger.error(`Scene regeneration failed: packageId=${creativePackageId} sceneIndex=${sceneIndex} | ${err.message}`);
      }
    })().catch((err) => this.logger.error(`Scene regeneration failed: ${err.message}`));

    return { status: 'started', creativePackageId, sceneIndex };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/higgsfield-scenes/merge
   * Merges every completed scene (in sceneIndex order) into one final video
   * via ffmpeg, uploads it to S3, and sets it as this package's `video`.
   * Requires every scene to have status='completed' first. Fire-and-forget —
   * poll GET /packages/:id and watch for video.videoUrl to populate.
   */
  @Post(':tenantId/packages/:creativePackageId/higgsfield-scenes/merge')
  async mergeHiggsfieldScenes(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);
    const scenes = (((pkg as any).videoScenes ?? []) as any[]).sort((a, b) => a.sceneIndex - b.sceneIndex);
    if (scenes.length === 0) throw new BadRequestException('No scenes planned — call higgsfield-scenes/plan first');
    const notReady = scenes.filter(s => s.status !== 'completed');
    if (notReady.length > 0) {
      throw new BadRequestException(`${notReady.length} scene(s) not completed yet: ${notReady.map(s => s.sceneIndex).join(', ')}`);
    }

    this.logger.log(`Merging Higgsfield scenes: tenantId=${tenantId} packageId=${creativePackageId} count=${scenes.length}`);

    const selectedIndex = (pkg as any).selectedCopyIndex ?? 0;
    const first = scenes[0];

    // Fire and forget
    (async () => {
      try {
        const { videoUrl } = await this.higgsfieldService.mergeVideos(scenes.map(s => s.videoUrl), tenantId);
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          {
            $set: {
              video: {
                variantIndex: selectedIndex,
                videoPrompt: scenes.map(s => s.prompt).join('\n\n'),
                videoUrl,
                videoThumbnailUrl: '',
                aspectRatio: first.aspectRatio,
                resolution: first.resolution,
                provider: 'higgsfield',
                providerModel: first.providerModel,
              },
            },
          },
        );
        this.logger.log(`Scenes merged: packageId=${creativePackageId} url=${videoUrl}`);
      } catch (err: any) {
        this.logger.error(`Scene merge failed: packageId=${creativePackageId} | ${err.message}`);
      }
    })().catch((err) => this.logger.error(`Scene merge failed: ${err.message}`));

    return { status: 'started', creativePackageId };
  }

  /**
   * POST /api/v1/creative/:tenantId/packages/:creativePackageId/higgsfield-scenes/add-voiceover
   * Adds a Cartesia-narrated Hindi/English voiceover to a COPY of this
   * package's video — the original `video.videoUrl` (and `videoScenes[].videoUrl`)
   * is never touched or overwritten. Requires `video.videoUrl` to already
   * exist (single-shot Heygen/Higgsfield render, or a merged scene build).
   * Does NOT call Higgsfield's generation API — only Claude (script), Cartesia
   * (TTS) and ffmpeg (mux), per the standing rule that video generation is
   * manual-only. Fire-and-forget — poll GET /packages/:id and watch for
   * videoWithVoiceoverUrl to populate.
   * Body: { script?: string, keepBackgroundAudio?: boolean } — pass a script
   * to skip LLM generation and use it verbatim (must already be in proper
   * Devanagari for Hindi portions). keepBackgroundAudio (default true) ducks
   * the video's own generated ambient audio under the narration instead of
   * discarding it.
   */
  @Post(':tenantId/packages/:creativePackageId/higgsfield-scenes/add-voiceover')
  async addHiggsfieldVoiceover(
    @Param('tenantId') tenantId: string,
    @Param('creativePackageId') creativePackageId: string,
    @Body() body: { script?: string; keepBackgroundAudio?: boolean },
  ) {
    const pkg = await this.creativePackageModel.findOne({ _id: creativePackageId, tenantId }).lean().exec();
    if (!pkg) throw new NotFoundException(`Creative package ${creativePackageId} not found`);
    const videoUrl = (pkg as any).video?.videoUrl;
    if (!videoUrl) throw new BadRequestException('This package has no video.videoUrl yet — generate/merge a video first');

    const durationSeconds = (pkg as any).videoTotalDurationSeconds || 15;
    const scenes = (((pkg as any).videoScenes ?? []) as any[]).sort((a, b) => a.sceneIndex - b.sceneIndex);
    const sceneSummary = scenes.length > 0
      ? scenes.map(s => `Scene ${s.sceneIndex + 1} (${s.durationSeconds}s): ${s.prompt}`).join('\n')
      : ((pkg as any).video?.videoPrompt ?? '');

    let script = body.script?.trim();
    if (!script) {
      const company = await this.companiesService.findByTenantId(tenantId);
      const brief = (pkg as any).briefId
        ? await this.intelligenceBriefModel.findOne({ tenantId, briefId: (pkg as any).briefId }).lean().exec()
        : null;
      const product = (company.products ?? []).find(p => p.name === (brief as any)?.product)
        ?? (company.products ?? []).find(p => p.active)
        ?? (company.products ?? [])[0];
      const hidePrice = !!product?.hidePriceInCreative;

      this.logger.log(`Writing voiceover script: tenantId=${tenantId} packageId=${creativePackageId} duration=${durationSeconds}s`);

      const result = await this.claudeService.runAgent({
        tenantId,
        runId: (pkg as any).runId,
        agentType: AgentType.CREATIVE_PRODUCER,
        systemPrompt: '',
        liveContext: this.liveContextBuilder.build(company, product?.name),
        userMessage: `
Write a natural voiceover narration script for this ${durationSeconds}-second video ad, timed to match its visual arc scene-by-scene:

${sceneSummary}

Brand: ${company.name}
${product ? `Product: ${product.name}${hidePrice ? ' (do not mention price)' : ` — ₹${product.price ?? '???'}`}` : ''}

LANGUAGE: Write natural, spoken Hindi-English code-switched narration (the way an Indian speaker naturally mixes languages), matching this brand's tone. This is DIFFERENT from on-screen text conventions elsewhere — this script is fed directly to a text-to-speech engine, so:
- Write every Hindi word/phrase in proper DEVANAGARI script (नाड़ी, विश्लेषण, etc) — NEVER in Latin/Hinglish transliteration. Transliteration causes mispronunciation (e.g. an ambiguous romanization of a word can come out wrong).
- Common English words a Hindi speaker would naturally say in English (brand name, "report", "call now", technical terms) may stay in Latin script — that's normal code-switching, not a pronunciation risk.
- CRITICAL: this brand's product involves "Nadi" in the pulse/energy-channel sense — always render it as नाड़ी (never नदी, which means river).

PACING: Aim for the narration to take approximately ${durationSeconds} seconds to speak aloud at a natural, unhurried pace (roughly 2-2.2 words per second for mixed Hindi-English speech). Err SHORTER rather than longer — if the narration runs long it gets abruptly cut off to match the video length.

Return ONLY this JSON (no markdown, no explanation):
{"script": "the full narration text"}
        `.trim(),
        maxTurns: 2,
      });

      const parsed = parseRobustJson<{ script?: string }>(result.content);
      script = parsed.script?.trim();
      if (!script) throw new Error('Voiceover script generation returned empty script');
    }

    this.logger.log(`Adding voiceover: tenantId=${tenantId} packageId=${creativePackageId} chars=${script.length}`);
    const finalScript = script;

    // Fire and forget
    (async () => {
      try {
        const narration = await this.cartesiaService.synthesizeSpeech(finalScript);
        const { videoUrl: withVoiceoverUrl } = await this.higgsfieldService.addVoiceover(videoUrl, narration, tenantId, {
          keepBackgroundAudio: body.keepBackgroundAudio,
        });
        await this.creativePackageModel.updateOne(
          { _id: creativePackageId, tenantId },
          { $set: { videoWithVoiceoverUrl: withVoiceoverUrl, voiceoverScript: finalScript } },
        );
        this.logger.log(`Voiceover added: packageId=${creativePackageId} url=${withVoiceoverUrl}`);
      } catch (err: any) {
        this.logger.error(`Adding voiceover failed: packageId=${creativePackageId} | ${err.message}`);
      }
    })().catch((err) => this.logger.error(`Adding voiceover failed: ${err.message}`));

    return { status: 'started', creativePackageId, script: finalScript };
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
