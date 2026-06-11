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
import { resolveTargetLanguage, CanonicalLanguage } from '../../common/creative/language-utils';

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
  referenceVideoPrompt?: string;  // Original video prompt to replicate style for creative replacements
  forcedHookStyle?: string;        // when set, ALL variants must use this hookStyle (replace_creative path)
  avoidHookStyles?: string[];      // hookStyles to avoid (saturated / fatigued)
  audienceStage?: 'cold' | 'warm' | 'hot';  // cold = prospecting, warm = retarget, hot = cart-recovery
  explorationArm?: boolean;                 // when true, Creative Team skips winningHooks/winningExemplars injection (closed-loop drift mitigation)
  /**
   * Exploit-winner marker — when set, Creative Team looks up the matching
   * HotWinner (via metaAdId) on company.learnings.hotWinners and injects a
   * "anchor on this verbatim pattern (don't copy)" block. Strategy Team
   * writes this onto the CreativeBrief; creative-producer reads it from
   * the brief doc and forwards here.
   */
  winnerCloneOf?: {
    sourceCampaignId: string;
    sourceBriefId: string;
    metaAdId: string;
    hookStyle: string;
    audienceType: string;
    format?: 'video' | 'image' | 'carousel';
    budgetTier: number;
    sourceCPA: number;
    sourceROAS: number;
    clonedAt: Date;
  };
  // Resolved language for all creative output. Caller may override; otherwise
  // creative-producer resolves from segment.languages → product.languages → 'hinglish'.
  // Drives copy text, image overlay text, and (when language video lands) VO script.
  targetLanguage?: CanonicalLanguage;
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
    /**
     * Bypass the resume-safe dedup when true. The default `produce()` call has
     * a safety check: if a completed package exists for this (tenantId, briefId),
     * return it without regenerating. Designed for resume-from-crash scenarios
     * — pipeline reruns shouldn't double-produce.
     *
     * BUT this also fires for legitimate re-produce intents:
     *   - User clicks "regenerate" from the dashboard
     *   - /briefs/:briefId/approve called twice (e.g. after a bug fix)
     *   - Operator manually re-triggers /produce after fixing a flag
     *
     * In those cases the silent short-circuit is confusing — the button "does
     * nothing." Caused real friction during the 2026-06-02 hidePriceInCreative
     * fix where re-producing kept returning the stale leaky package until the
     * existing record was manually deleted.
     *
     * Set `forceRegenerate: true` from any caller that has intentional intent
     * to re-produce. Existing completed package gets deleted, fresh production
     * runs. The pipeline orchestrator and resume paths keep default `false`.
     */
    options?: { forceRegenerate?: boolean },
  ): Promise<CreativePackageDocument> {
    const company = await this.companiesService.findByTenantId(tenantId);
    const forceRegenerate = options?.forceRegenerate === true;

    // Check for existing package — avoid duplicates on resume.
    // forceRegenerate bypass: legitimate re-produce intents (manual regenerate,
    // post-bug-fix reruns) skip the dedup and treat the existing record as
    // stale-to-be-replaced.
    const existing = await this.creativePackageModel.findOne({ tenantId, briefId }).lean().exec();
    if (existing && existing.status === 'completed' && !forceRegenerate) {
      this.logger.log(`Creative production skipped — already completed for briefId=${briefId} (set options.forceRegenerate=true to override)`);
      return existing as any;
    }
    if (existing && forceRegenerate) {
      await this.creativePackageModel.deleteOne({ _id: existing._id });
      this.logger.log(`Force-regenerate: deleted existing package for briefId=${briefId} (status was ${existing.status})`);
    }
    // Resume video polling if we have a videoId but no completed video
    if (existing && existing.heygenVideoId && !(existing.video as any)?.videoUrl) {
      this.logger.log(`Resuming Heygen poll for briefId=${briefId} videoId=${existing.heygenVideoId}`);
      try {
        const videoResult = await this.videoGenerator.resumeFromVideoId(
          existing.heygenVideoId,
          (existing.video as any)?.videoPrompt ?? '',
          tenantId,
          runId,
        );
        await this.creativePackageModel.updateOne(
          { _id: existing._id },
          {
            status: 'completed',
            completedAt: new Date(),
            video: {
              variantIndex: (existing.video as any)?.variantIndex ?? 0,
              videoPrompt: (existing.video as any)?.videoPrompt ?? '',
              videoUrl: videoResult.videoUrl,
              videoThumbnailUrl: videoResult.videoThumbnailUrl,
            },
          },
        );
        this.logger.log(`Heygen resume succeeded for briefId=${briefId}`);
        return (await this.creativePackageModel.findOne({ _id: existing._id }).lean().exec()) as any;
      } catch (resumeErr: any) {
        this.logger.error(`Heygen resume failed for briefId=${briefId}: ${resumeErr.message} — regenerating`);
        await this.creativePackageModel.deleteOne({ _id: existing._id });
      }
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

    // Resolve targetLanguage once at the boundary — every downstream creator
    // (copy, image, eventually video) reads brief.targetLanguage and writes in
    // that language. Resolution order: explicit brief.targetLanguage → matched
    // audienceSegment.languages → product.languages → 'hinglish' default. This
    // is what makes the Marathi brief actually produce Marathi creative instead
    // of defaulting to Hinglish.
    if (!brief.targetLanguage) {
      const matchedProduct = (company.products ?? []).find(p =>
        brief.product ? p.name === brief.product : p.active,
      );
      const matchedSegment = matchedProduct?.audienceSegments?.find(s =>
        brief.targetSegment && s.name?.toLowerCase().trim() === brief.targetSegment.toLowerCase().trim(),
      );
      brief.targetLanguage = resolveTargetLanguage({
        segmentLanguages: matchedSegment?.languages,
        productLanguages: matchedProduct?.languages,
      });
      this.logger.log(`Creative language resolved: tenantId=${tenantId} briefId=${briefId} language=${brief.targetLanguage} (segment=${matchedSegment?.name ?? 'none'}, product=${matchedProduct?.name ?? 'none'})`);
    }

    this.logger.log(`Creative production started: tenantId=${tenantId} briefId=${briefId} targetLanguage=${brief.targetLanguage}`);

    try {
      let copyPackage: { variants: any[]; selectedIndex: number; selectionReason: string } | null = null;
      let images: ImageCreative[] = [];
      let carouselCards: any[] = [];
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

        const isCarousel = brief.format === 'carousel'
          && Array.isArray(teamResult.carouselCards)
          && teamResult.carouselCards.length >= 2;

        if (isCarousel) {
          // Carousel — generate N per-card images instead of per-variant images.
          // Per-card prompts include explicit shared-visual-language directives
          // (palette / setting / composition) so the slides cohere.
          this.logger.log(`Generating ${teamResult.carouselCards!.length} carousel card images: tenantId=${tenantId} briefId=${briefId}`);
          const cardResults = await Promise.allSettled(
            teamResult.carouselCards!.map((card) =>
              this.imageGenerator.generateFromPrompt(card.imagePrompt, company, runId),
            ),
          );
          carouselCards = teamResult.carouselCards!.map((card, i) => {
            const result = cardResults[i];
            if (result.status === 'fulfilled') {
              return {
                slotIndex: card.slotIndex,
                headline: card.headline,
                description: card.description,
                imagePrompt: card.imagePrompt,
                imageUrl: result.value.imageUrl,
                cardLink: card.cardLink,
              };
            }
            this.logger.error(`Carousel card ${card.slotIndex} image generation failed: ${(result as any).reason?.message}`);
            return {
              slotIndex: card.slotIndex,
              headline: card.headline,
              description: card.description,
              imagePrompt: card.imagePrompt,
              imageUrl: '',
              cardLink: card.cardLink,
            };
          });
          // images[] stays empty for carousel format — launch path looks at
          // creativePackage.carouselCards when adSet.creativeFormat === 'carousel'.
          images = [];
        } else {
          // Standard path — one image per copy variant
          this.logger.log(`Generating ${teamResult.variants.length} images (one per variant): tenantId=${tenantId}`);
          const imageResults = await Promise.allSettled(
            teamResult.variants.map((variant: any, i: number) => {
              const teamImagePrompt = teamResult.imagePrompts?.[i];
              if (teamImagePrompt) {
                // Use the creative team's reviewed image prompt directly — skip re-writing via Claude
                return this.imageGenerator.generateFromPrompt(teamImagePrompt, company, runId);
              }
              // Fallback: generate image prompt from scratch for this variant
              return this.imageGenerator.generateForVariant(
                { topic: brief.topic, angle: brief.angle, platform: brief.platform, format: brief.format, audience: brief.audience },
                variant,
                i,
                company,
                runId,
              );
            }),
          );

          images = teamResult.variants.map((_: any, i: number) => {
            const result = imageResults[i];
            if (result.status === 'fulfilled') {
              return { variantIndex: i, imagePrompt: result.value.imagePrompt, imageUrl: result.value.imageUrl };
            }
            this.logger.error(`Image generation failed for variant ${i}: ${(result as any).reason?.message}`);
            return { variantIndex: i, imagePrompt: teamResult.imagePrompts?.[i] ?? '', imageUrl: '' };
          });
        }

        // Generate one video for the selected copy variant — skip for meme format (static image ad)
        const selectedIndex = teamResult.selectedIndex ?? 0;
        const videoPromptStr = typeof teamResult.videoPrompt === 'string'
          ? teamResult.videoPrompt
          : JSON.stringify(teamResult.videoPrompt);

        if (brief.format === 'meme') {
          this.logger.log(`Video generation skipped — meme format uses static image only`);
          video = null;
        } else
        try {
          const videoResult = await this.videoGenerator.generateFromScript(
            videoPromptStr,
            tenantId,
            runId,
            async (videoId: string) => {
              await this.creativePackageModel.updateOne(
                { _id: pkg._id },
                { heygenVideoId: videoId, video: { variantIndex: selectedIndex, videoPrompt: videoPromptStr, videoUrl: '', videoThumbnailUrl: '' } },
              );
              this.logger.log(`Heygen videoId persisted: ${videoId} for briefId=${briefId}`);
            },
          );
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

      const allFailed = !copyPackage && images.length === 0 && carouselCards.length === 0 && !video;
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
          carouselCards,
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

}
