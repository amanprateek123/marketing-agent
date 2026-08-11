import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import {
  checkCopySafety,
  formatSafetyError,
} from '../../common/safety/copy-safety-checker.util';
import { withUtmParams } from './meta-utm.util';
import { PlacementPreset, resolvePlacementPreset } from './placement-presets';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// Meta error codes that are safe to retry. 4/17/32/613/80004 are rate-limit
// codes (app/user/page/custom/ad-account level) — 80004 ("too many calls to
// this ad-account") hit production 2026-07-20 and was NOT in this list, so
// it failed on the first attempt instead of backing off.
const RETRYABLE_ERROR_CODES = [2, 4, 17, 32, 341, 368, 613, 80004];
const MAX_RETRIES = 4;
const RETRY_DELAYS = [1000, 3000, 10000, 25000]; // exponential backoff — rate-limit codes need longer waits than the network-blip case this was originally tuned for

// https://developers.facebook.com/docs/marketing-api/reference/ad-account/#fields — account_status
const META_ACCOUNT_STATUS: Record<number, MetaAdAccountSummary['status']> = {
  1: 'active',
  2: 'disabled',
  3: 'unsettled',
  7: 'pending_review',
  8: 'pending_review',
  9: 'in_grace_period',
  100: 'pending_closure',
  101: 'pending_closure',
};

export interface MetaAdAccountSummary {
  id: string; // "act_123456"
  name: string;
  status: 'active' | 'disabled' | 'unsettled' | 'pending_review' | 'in_grace_period' | 'pending_closure' | 'other';
  currency: string;
  timezoneName: string;
}

export interface MetaPageSummary {
  id: string;
  name: string;
  category?: string;
  /** True if the token can post ads as this Page right now (from /me/accounts). False = owned by the Business Manager but not yet granted to this token — page_id will 403 at launch until access is granted. */
  accessible: boolean;
  /** True if this tenant's configured ad account(s) are authorized to advertise as this Page (Meta's own promote_pages allowlist). A Page can be fully manageable above and still get rejected at launch if it isn't on this list — this is the exact gate Meta Ads Manager enforces per ad account. */
  promotable: boolean;
}

export interface MetaCustomAudience {
  id: string;
  name: string;
  type: 'custom' | 'lookalike';
  subtype?: string;
  approxSizeLower?: number;
  approxSizeUpper?: number;
  deliveryStatus?: string;
}

/**
 * One uploaded image for a copy variant. Most variants have exactly one
 * (aspectRatio undefined/whatever the format defaulted to) — createAd() uses
 * the plain single-image_hash path in that case, unchanged from before.
 * When a variant has 2+ entries with distinct aspectRatios (a human creative
 * team supplying pre-made sizes, or a library package edited to add one),
 * createAd() switches to Meta's asset_feed_spec so each placement gets the
 * asset actually composed for it instead of an auto-crop of one image.
 */
export interface MetaImageAsset {
  hash: string;
  aspectRatio?: string; // '9:16' | '1:1' | '4:5' | '16:9'
}

/**
 * One uploaded video, with its own thumbnail. Unlike images (per-variant),
 * a package has a single set of video sizes shared across every ad that
 * ships as a video ad, regardless of which copy variant it's paired with —
 * mirrors how the legacy singular video field worked (one video, reused
 * across variants). 2+ distinct videoIds triggers placement asset
 * customization in createVideoAd(), same pattern as MetaImageAsset.
 */
export interface MetaVideoAsset {
  videoId: string;
  thumbnailHash?: string;
  aspectRatio?: string; // '9:16' | '1:1' | '4:5' | '16:9'
}

export interface MetaLaunchResult {
  campaignId: string;
  adSets: {
    adSetId: string;
    name: string;
    ads: {
      adId: string;
      creativeId: string;
      copyVariantIndex: number;
      format: 'video' | 'image' | 'carousel'; // populated at launch — required to measure mixed-format ad sets; carousel = one ad with N child cards
    }[];
  }[];
}

export interface MetaAdSetConfig {
  name: string;
  budgetPercent: number;
  audienceType: string;
  creativeFormat?: 'video' | 'image' | 'both' | 'mixed' | 'carousel';
  // 'mixed' = the selected variant ships as a video ad, all OTHER variants in adSet.ads
  // ship as image ads. Lets a single ad set test 1 video + N images side-by-side
  // (Meta-recommended creative diversity within one optimization bucket) without
  // duplicating the same video across N copy variants the way 'both' does.
  // 'carousel' = ONE ad with N linked cards (config.carouselCards). Ignores
  // adSet.ads variant list — carousel ships as a single ad regardless of variant count.
  metaAudienceId?: string;
  excludeAudienceIds?: string[];
  ageMin?: number;
  ageMax?: number;
  gender?: string;
  geoLocations?: string[]; // ISO country codes (e.g. ['IN'])
  geoStates?: string[]; // Meta region keys (e.g. ['480'] for Maharashtra)
  geoCities?: string[]; // Meta city keys (e.g. ['2295411'] for Mumbai)
  // Meta locale IDs (e.g. [81] = Marathi, [46] = Hindi — verified 2026-07-16 via
  // /search?type=adlocale; see META_LOCALE_IDS, the source of truth). Filters
  // delivery to users whose platform language matches. Populated by audience-targeting-resolver from
  // segment.languages or product.languages (canonical names → IDs via META_LOCALE_IDS).
  locales?: number[];
  interests?: string[]; // Meta interest IDs from the interest catalog (NOT names — names are rejected by API)
  // Device OS targeting (Meta's targeting.user_os, values are literally
  // 'iOS'/'Android' — case-sensitive). Undefined/empty = no OS filter, ships
  // to both. Set to a single platform to split a campaign into per-platform
  // ad sets with independent budgets/reporting — createAdSet then also picks
  // that platform's store URL (product.metaAppStoreUrlIos/Android) over the
  // campaign-default metaAppStoreUrl, when this ad set targets exactly one OS.
  userOs?: ('iOS' | 'Android')[];
  optimizationGoal: string;
  ads: number[];
  // Optional per-ad-set destination URL. When set, every ad in THIS ad set
  // points here instead of config.landingUrl (UTM params still appended per
  // ad). Used by the landing-page A/B test: two ad sets share identical
  // audience + creatives and differ ONLY by this URL, so Meta's per-ad-set
  // reporting isolates which landing page converts better. Undefined → the
  // ad set inherits the campaign-global config.landingUrl (normal behaviour).
  landingUrlOverride?: string;
  // Optional cost-cap bid (in rupees, full not paise). When set, ad set ships
  // with bid_strategy=COST_CAP + bid_amount=this. Used to anchor broad cold
  // audiences (lookalike >1%, advantage_plus, interest) to the product's
  // historical CPA so Meta stops delivering ₹6 junk traffic that doesn't
  // convert. Leave undefined for warm/hot custom-audience retargeting where
  // LOWEST_COST_WITHOUT_CAP is fine (the audience itself is the quality gate).
  bidAmountInr?: number;
  // Which Meta surfaces this ad set can serve on — resolved via
  // resolvePlacementPreset() in placement-presets.ts. Undefined -> 'vertical',
  // the long-standing unconditional default (see createAdSet below), so every
  // existing caller that doesn't set this keeps its current behavior.
  placementPreset?: PlacementPreset;
}

export interface MetaCampaignConfig {
  accountId: string;
  accessToken: string;
  pageId?: string;
  pixelId?: string;
  // App Promotion / App Engagement counterpart to pixelId — set together with
  // conversionEvent (read as an App Event name, e.g. "chat_success") to build
  // promoted_object.application_id instead of promoted_object.pixel_id. See
  // the applicationId branch in createAdSet for exact field semantics.
  applicationId?: string;
  // App store URL for the app behind applicationId. Only required for the
  // App Installs objective — omit for pure App Engagement ad sets optimizing
  // toward an existing user's in-app event. Used as the fallback whenever an
  // ad set's userOs isn't exactly one platform; objectStoreUrlIos/Android
  // win over this for an ad set that targets that single platform.
  objectStoreUrl?: string;
  objectStoreUrlIos?: string;
  objectStoreUrlAndroid?: string;
  campaignName: string;
  budget: number; // in INR (full rupees, not paise)
  objective: string;
  conversionEvent: string;
  customEventName?: string; // used when conversionEvent === 'CustomEvent'
  customConversionId?: string; // Meta Custom Conversion ID — takes priority over conversionEvent
  adSets: MetaAdSetConfig[];
  copyVariants: { primaryText: string; headline: string; cta: string }[];
  /**
   * Per-variant uploaded image(s) — variantIndex → all sizes uploaded for
   * that variant. Almost always length 1; length >1 triggers placement
   * asset customization in createAd() (see MetaImageAsset).
   */
  imageHashes?: Record<number, MetaImageAsset[]>;
  /**
   * Per-variant uploaded video(s), each already uploaded + thumbnailed —
   * variantIndex → every size of that variant's video. Mirrors imageHashes:
   * multiple entries under one variantIndex (different sizes of the SAME
   * video) trigger placement asset customization in createVideoAd(); entries
   * under DIFFERENT variantIndexes are entirely separate videos, each its
   * own ad. A variantIndex with no video here simply doesn't get a video ad.
   */
  videoAssets?: Record<number, MetaVideoAsset[]>;
  selectedCopyIndex?: number; // which copy variant the video matches (for 'mixed' format)
  landingUrl: string;
  declaredSpecialAdCategories?: string[]; // for safety check on regulated copy
  /**
   * Carousel cards — required when an ad set has creativeFormat='carousel'.
   * Each card needs an image hash (uploaded ahead of launch), headline,
   * optional description, and optional per-card link override. Cards form a
   * narrative; ordering matters. multi_share_optimized=false at the API layer
   * preserves order so step-1→step-2→step-3 stories don't break.
   */
  carouselCards?: Array<{
    imageHash: string;
    headline: string;
    description?: string;
    cardLink?: string;
  }>;
}

// Track all created Meta objects for rollback on failure
interface CreatedObjects {
  campaignId: string | null;
  adSetIds: string[];
  creativeIds: string[];
  adIds: string[];
}

/**
 * Meta Ads Service — creates campaigns, ad sets, and ads via Graph API.
 *
 * Key design decisions:
 * - Everything starts PAUSED — activated only after all objects are created
 * - Rollback on partial failure — deletes campaign (cascades to ad sets + ads)
 * - Retry with exponential backoff on transient Meta errors (codes 2, 17, 341)
 * - Budget in INR rupees → converted to paise at the API boundary
 * - Access token never logged — passed as parameter, never in log statements
 */
@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);

  /**
   * Upload an ad image to Meta's ad library.
   */
  async uploadImage(
    imageUrl: string,
    accountId: string,
    accessToken: string,
  ): Promise<string> {
    this.logger.log(`Uploading image to Meta: accountId=${accountId}`);

    let payload: any;

    if (imageUrl.startsWith('data:')) {
      // Base64 data URL — extract raw base64 and send as bytes
      const base64 = imageUrl.split(',')[1];
      if (!base64) throw new Error('Invalid base64 data URL');
      payload = { bytes: base64, access_token: accessToken };
    } else {
      // Download image and send as base64 bytes — avoids app capability issues with URL fetch
      this.logger.log(
        `Downloading image for base64 upload: ${imageUrl.slice(0, 80)}...`,
      );
      const imgResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const base64 = Buffer.from(imgResponse.data).toString('base64');
      payload = { bytes: base64, access_token: accessToken };
    }

    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/adimages`,
      payload,
    );

    const images = response.data?.images;
    if (!images) throw new Error('No image data in response');

    const firstKey = Object.keys(images)[0];
    const hash = images[firstKey]?.hash;
    if (!hash) throw new Error('No image hash in response');

    this.logger.log(`Image uploaded: hash=${hash}`);
    return hash;
  }

  /**
   * Upload a video to Meta's ad video library.
   * Polls until Meta finishes processing before returning — prevents race condition
   * where ad creative creation fails because video isn't ready yet.
   */
  async uploadVideo(
    videoUrl: string,
    accountId: string,
    accessToken: string,
  ): Promise<string> {
    this.logger.log(`Uploading video to Meta: accountId=${accountId}`);

    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/advideos`,
      { file_url: videoUrl, access_token: accessToken },
    );

    const videoId = response.data?.id;
    if (!videoId) throw new Error('No video ID in Meta upload response');

    this.logger.log(
      `Video uploaded: videoId=${videoId} — waiting for Meta processing`,
    );

    // Poll until Meta finishes processing the video (async on their side)
    const deadline = Date.now() + 3 * 60 * 1000; // 3 min max
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await this.metaApiCall(
        'GET',
        `${META_API_BASE}/${videoId}?fields=status&access_token=${accessToken}`,
        {},
      );
      const status =
        statusRes.data?.status?.processing_progress ?? statusRes.data?.status;
      this.logger.log(
        `Meta video processing: videoId=${videoId} status=${JSON.stringify(status)}`,
      );
      // Meta returns status.video_status = 'ready' when done
      if (statusRes.data?.status?.video_status === 'ready') {
        this.logger.log(`Meta video ready: videoId=${videoId}`);
        return videoId;
      }
      if (statusRes.data?.status?.video_status === 'error') {
        throw new Error(`Meta video processing failed: videoId=${videoId}`);
      }
    }

    // If still not ready after 3min, proceed anyway — Meta may still serve it
    this.logger.warn(
      `Meta video processing timeout — proceeding anyway: videoId=${videoId}`,
    );
    return videoId;
  }

  /**
   * Get a thumbnail image hash from a Meta video.
   * Returns the first auto-generated thumbnail's image_hash.
   */
  async getVideoThumbnailHash(
    videoId: string,
    accountId: string,
    accessToken: string,
  ): Promise<string | undefined> {
    try {
      const response = await this.metaApiCall(
        'GET',
        `${META_API_BASE}/${videoId}/thumbnails?access_token=${accessToken}`,
        {},
      );
      const thumbnails = response.data?.data;
      if (!thumbnails || thumbnails.length === 0) return undefined;

      // Pick the preferred thumbnail (is_preferred = true) or first one
      const preferred =
        thumbnails.find((t: any) => t.is_preferred) ?? thumbnails[0];
      const thumbUrl = preferred?.uri;
      if (!thumbUrl) return undefined;

      // Upload the thumbnail URL as an image to Meta and get the hash
      const imgResponse = await axios.get(thumbUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const base64 = Buffer.from(imgResponse.data).toString('base64');

      const uploadResponse = await this.metaApiCall(
        'POST',
        `${META_API_BASE}/${accountId}/adimages`,
        { bytes: base64, access_token: accessToken },
      );
      const images = uploadResponse.data?.images;
      const firstKey = Object.keys(images ?? {})[0];
      const hash = images?.[firstKey]?.hash;
      this.logger.log(`Video thumbnail uploaded: hash=${hash}`);
      return hash;
    } catch (err: any) {
      this.logger.warn(`Could not get video thumbnail: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Full launch: campaign → ad sets → ads.
   * Everything starts PAUSED. Call activateCampaign() to go live.
   * On partial failure, rolls back all created objects.
   */
  async launchCampaign(config: MetaCampaignConfig): Promise<MetaLaunchResult> {
    this.logger.log(
      `Launching campaign: ${config.campaignName} | budget: ₹${config.budget} | adSets: ${config.adSets.length}`,
    );

    // ── Safety pre-check on every copy variant ─────────────────────────────
    // Same gate as createAdInAdSet, but applied here so initial campaign launches
    // (the dominant launch path) are also screened. One BM strike on policy-violating
    // copy can restrict the account for days — cheap regex check, asymmetric upside.
    // Scan EVERY variant and report them together. This loop used to throw on
    // the first failure, which on a 40-variant package meant: launch, wait for
    // ~80 image uploads, die on variant 19, fix it, relaunch, re-upload, die on
    // variant 28, fix, relaunch, re-upload, die on 29. One offending variant
    // per attempt, each attempt paying the full upload cost. Collecting them
    // turns that into a single round trip.
    const failures: string[] = [];
    for (let i = 0; i < config.copyVariants.length; i++) {
      const v = config.copyVariants[i];
      const safety = checkCopySafety({
        primaryText: v.primaryText,
        headline: v.headline,
        cta: v.cta,
        declaredSpecialAdCategories: config.declaredSpecialAdCategories,
      });
      if (!safety.safe) {
        failures.push(
          `  variant #${i}${v.headline ? ` ("${v.headline.slice(0, 60)}")` : ''}:\n` +
            formatSafetyError(safety)
              .split('\n')
              .slice(1)
              .map((l) => `  ${l}`)
              .join('\n'),
        );
      }
    }
    if (failures.length > 0) {
      const errorMsg =
        `Copy safety check failed on ${failures.length} of ${config.copyVariants.length} copy variant(s) ` +
        `in campaign "${config.campaignName}" (would risk Meta policy strike):\n` +
        `${failures.join('\n')}\n` +
        `Fix ALL of the above before retrying — every one is checked on each launch attempt. ` +
        `Either rewrite the copy, or (for special-ad-category) declare the category on the company config.`;
      this.logger.error(`Refusing to launch campaign — ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // ── Idempotency pre-check ──────────────────────────────────────────────
    // Meta has no idempotency key on campaign creation. If a BullMQ retry or
    // a double /approve re-enters this path after a mid-flight timeout, the
    // second call would create a SECOND live campaign spending money that the
    // DB doesn't track. Campaign names are deterministic per brief+date
    // (AGENT_<topic>_<date>), so an exact-name match on Meta means this launch
    // already ran — fail loudly for the operator instead of double-spending.
    const existingId = await this.findCampaignIdByName(
      config.accountId,
      config.accessToken,
      config.campaignName,
    );
    if (existingId) {
      throw new Error(
        `Refusing to launch: campaign named "${config.campaignName}" already exists on Meta (id=${existingId}). ` +
          `This is a duplicate-launch guard — if the previous attempt died mid-launch, inspect campaign ${existingId} on Meta ` +
          `(delete it or link it in the DB) before retrying.`,
      );
    }

    const created: CreatedObjects = {
      campaignId: null,
      adSetIds: [],
      creativeIds: [],
      adIds: [],
    };

    const expectedAdCount = config.adSets.reduce(
      (sum, as) => sum + as.ads.length,
      0,
    );

    try {
      // Step 1: Create campaign (PAUSED) — ABO (budget at ad set level for testing)
      created.campaignId = await this.createCampaign(
        config.accountId,
        config.accessToken,
        config.campaignName,
        config.objective,
        config.declaredSpecialAdCategories ?? [],
      );

      // Step 2: Create ad sets + ads
      const adSetResults: MetaLaunchResult['adSets'] = [];

      for (const adSetConfig of config.adSets) {
        // Mirrors createAdSet's placement resolution: the 'vertical' preset
        // (the default when unset) ships Stories/Reels only, which are all
        // 9:16 surfaces. Recomputed here rather than read back from Meta so
        // the two stay in lockstep — if that default ever changes, this must
        // change with it or ads get the wrong aspect ratio again.
        const verticalOnlyPlacements = (adSetConfig.placementPreset ?? 'vertical') === 'vertical';

        const adSetId = await this.createAdSet(
          config.accountId,
          config.accessToken,
          created.campaignId,
          adSetConfig,
          config.budget,
          config.conversionEvent,
          config.pixelId,
          config.customEventName,
          config.customConversionId,
          config.applicationId,
          config.objectStoreUrl,
          config.objectStoreUrlIos,
          config.objectStoreUrlAndroid,
        );
        created.adSetIds.push(adSetId);

        // Create ads (one per copy variant — EXCEPT for carousel, which ships
        // as ONE ad with N linked cards regardless of variant list)
        const adResults: MetaLaunchResult['adSets'][0]['ads'] = [];
        const creativeFormat = adSetConfig.creativeFormat ?? 'image';
        const selectedCopyIndex = config.selectedCopyIndex ?? 0;

        // Per-ad-set URL override (landing-page A/B test) falls back to the
        // campaign-global landingUrl. UTM params are appended either way, so
        // downstream analytics still attribute by campaign/ad-set/ad name.
        const adSetLandingUrl =
          adSetConfig.landingUrlOverride || config.landingUrl;
        const buildLandingUrl = (adName: string) =>
          withUtmParams(adSetLandingUrl, {
            campaignName: config.campaignName,
            adSetName: adSetConfig.name,
            adName,
          });

        // Carousel: one ad per ad set, N cards inside it. Uses selected copy
        // variant's primaryText as the message above the cards, and the cards
        // themselves come from config.carouselCards (orchestrated upstream).
        if (creativeFormat === 'carousel') {
          if (!config.carouselCards || config.carouselCards.length < 2) {
            throw new Error(
              `Ad set "${adSetConfig.name}" is creativeFormat=carousel but config.carouselCards has < 2 entries; cannot launch.`,
            );
          }
          const selectedVariant =
            config.copyVariants[selectedCopyIndex] ?? config.copyVariants[0];
          if (!selectedVariant) {
            throw new Error(
              `Ad set "${adSetConfig.name}" carousel needs at least one copy variant for primaryText + cta`,
            );
          }
          const adName = `${adSetConfig.name} — Carousel`;
          const { adId, creativeId } = await this.createCarouselAd(
            config.accountId,
            config.accessToken,
            adSetId,
            adName,
            selectedVariant.primaryText,
            selectedVariant.cta,
            config.pageId ?? '',
            buildLandingUrl(adName),
            config.carouselCards,
          );
          created.creativeIds.push(creativeId);
          created.adIds.push(adId);
          adResults.push({
            adId,
            creativeId,
            copyVariantIndex: selectedCopyIndex,
            format: 'carousel',
          });
          adSetResults.push({
            adSetId,
            name: adSetConfig.name,
            ads: adResults,
          });
          continue;
        }

        for (const variantIndex of adSetConfig.ads) {
          const variant = config.copyVariants[variantIndex];
          if (!variant) continue;

          // hookStyle in ad name for Meta UI clarity + downstream attribution by name
          const hookStyle = (variant as any).hookStyle
            ? ` (${(variant as any).hookStyle})`
            : '';
          const adName = `${adSetConfig.name} — Variant ${variantIndex + 1}${hookStyle}`;

          // Resolve per-variant image asset(s) — usually one; multiple sizes
          // trigger placement customization in createAd(). variantImageHash
          // stays the "primary" (first) hash for callers that only ever need
          // one (video-ad thumbnail, the mixed/video branch's still fallback).
          const variantImages = config.imageHashes?.[variantIndex] ?? [];
          const variantImageHash = variantImages[0]?.hash;
          // Per-variant, like images — a variantIndex with no video here
          // just doesn't get a video ad (see MetaCampaignConfig.videoAssets).
          const videoAssets = config.videoAssets?.[variantIndex] ?? [];

          // 'mixed': each variant ships as video (if it has one) or image,
          // never both — that's what distinguishes it from 'both'.
          //   -> N video/image ads compete in one bucket, Meta optimizes across formats
          if (creativeFormat === 'mixed') {
            if (videoAssets.length > 0) {
              const videoAdName = `${adName} (video)`;
              const { adId, creativeId } = await this.createVideoAd(
                config.accountId,
                config.accessToken,
                adSetId,
                videoAdName,
                variant,
                videoAssets,
                config.pageId!,
                buildLandingUrl(videoAdName),
                variantImageHash, // fallback thumbnail for any video asset missing its own
              );
              created.creativeIds.push(creativeId);
              created.adIds.push(adId);
              adResults.push({
                adId,
                creativeId,
                copyVariantIndex: variantIndex,
                format: 'video',
              });
            } else if (variantImageHash) {
              const { adId, creativeId } = await this.createAd(
                config.accountId,
                config.accessToken,
                adSetId,
                adName,
                variant,
                variantImages,
                config.pageId ?? '',
                buildLandingUrl(adName),
                verticalOnlyPlacements,
              );
              created.creativeIds.push(creativeId);
              created.adIds.push(adId);
              adResults.push({
                adId,
                creativeId,
                copyVariantIndex: variantIndex,
                format: 'image',
              });
            }
            continue;
          }

          // video-only or both → create video ad if any video asset available
          if (
            (creativeFormat === 'video' || creativeFormat === 'both') &&
            videoAssets.length > 0
          ) {
            const videoAdName = `${adName} (video)`;
            const { adId, creativeId } = await this.createVideoAd(
              config.accountId,
              config.accessToken,
              adSetId,
              videoAdName,
              variant,
              videoAssets,
              config.pageId!,
              buildLandingUrl(videoAdName),
              variantImageHash, // fallback thumbnail for any video asset missing its own
            );
            created.creativeIds.push(creativeId);
            created.adIds.push(adId);
            adResults.push({
              adId,
              creativeId,
              copyVariantIndex: variantIndex,
              format: 'video',
            });
          }

          // image-only or both → create image ad using variant-specific hash
          if (
            (creativeFormat === 'image' || creativeFormat === 'both') &&
            variantImageHash
          ) {
            const adName2 =
              creativeFormat === 'both' ? `${adName} (image)` : adName;
            const { adId, creativeId } = await this.createAd(
              config.accountId,
              config.accessToken,
              adSetId,
              adName2,
              variant,
              variantImages,
              config.pageId ?? '',
              buildLandingUrl(adName2),
              verticalOnlyPlacements,
            );
            created.creativeIds.push(creativeId);
            created.adIds.push(adId);
            adResults.push({
              adId,
              creativeId,
              copyVariantIndex: variantIndex,
              format: 'image',
            });
          }

          // fallback: if neither image nor video available, skip this variant
        }

        adSetResults.push({ adSetId, name: adSetConfig.name, ads: adResults });
      }

      // Validate: did we create all expected ads?
      const totalAdsCreated = created.adIds.length;
      if (totalAdsCreated < expectedAdCount) {
        this.logger.warn(
          `Only ${totalAdsCreated}/${expectedAdCount} ads created — saving as draft, not activating`,
        );
        // Don't throw — return what we have, but don't activate
        return { campaignId: created.campaignId, adSets: adSetResults };
      }

      this.logger.log(
        `Campaign created (PAUSED): campaignId=${created.campaignId} | adSets=${adSetResults.length} | ads=${totalAdsCreated}`,
      );

      return { campaignId: created.campaignId, adSets: adSetResults };
    } catch (err: any) {
      // Rollback: delete campaign (cascades to ad sets + ads)
      this.logger.error(
        `Campaign launch failed — rolling back: ${err.message}`,
      );
      await this.rollback(created, config.accessToken);
      throw err;
    }
  }

  /**
   * Activate a paused campaign (set status to ACTIVE).
   * Only call after verifying all ads were created.
   */
  async activateCampaign(
    campaignId: string,
    accessToken: string,
    launchResult: MetaLaunchResult,
  ): Promise<void> {
    // Activate campaign
    await this.metaApiCall('POST', `${META_API_BASE}/${campaignId}`, {
      status: 'ACTIVE',
      access_token: accessToken,
    });
    this.logger.log(`Campaign activated: ${campaignId}`);

    // Activate all ad sets
    for (const adSet of launchResult.adSets) {
      await this.metaApiCall('POST', `${META_API_BASE}/${adSet.adSetId}`, {
        status: 'ACTIVE',
        access_token: accessToken,
      });
      this.logger.log(`Ad set activated: ${adSet.adSetId} (${adSet.name})`);

      // Activate all ads within each ad set
      for (const ad of adSet.ads) {
        await this.metaApiCall('POST', `${META_API_BASE}/${ad.adId}`, {
          status: 'ACTIVE',
          access_token: accessToken,
        });
        this.logger.log(`Ad activated: ${ad.adId}`);
      }
    }
  }

  // ─── Private: Meta API methods ──────────────────────────────────────────────

  /**
   * Exact-name campaign lookup for the duplicate-launch guard. Fails OPEN
   * (returns null on API error) — blocking every launch because the lookup
   * hiccuped would be worse than the rare duplicate it protects against.
   */
  private async findCampaignIdByName(
    accountId: string,
    accessToken: string,
    name: string,
  ): Promise<string | null> {
    try {
      const res = await this.metaApiCall(
        'GET',
        `${META_API_BASE}/${accountId}/campaigns`,
        {
          fields: 'id,name',
          filtering: JSON.stringify([
            { field: 'name', operator: 'EQUAL', value: name },
          ]),
          limit: '5',
          access_token: accessToken,
        },
      );
      const match = (res.data?.data ?? []).find((c: any) => c.name === name);
      return match?.id ?? null;
    } catch (err: any) {
      this.logger.warn(
        `Duplicate-launch pre-check failed (proceeding without it): ${err.message}`,
      );
      return null;
    }
  }

  private async createCampaign(
    accountId: string,
    accessToken: string,
    name: string,
    objective: string,
    specialAdCategories: string[],
  ): Promise<string> {
    this.logger.log(
      `Creating campaign: ${name}${specialAdCategories.length ? ` | special_ad_categories: ${specialAdCategories.join(',')}` : ''}`,
    );

    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/campaigns`,
      {
        name,
        objective,
        status: 'PAUSED',
        // Was hardcoded `[]` — regulated verticals (credit/employment/housing/
        // social-issues) launched without the declaration → strike risk. Now
        // sourced from company.meta.specialAdCategories per tenant.
        special_ad_categories: specialAdCategories,
        // Required by Meta when not using CBO (we use ABO — budget at ad set
        // level). false = each ad set keeps its own budget, no 20% sharing.
        is_adset_budget_sharing_enabled: false,
        // bid_strategy lives at AD SET level under ABO — Meta rejects it on
        // the campaign with subcode 1885737 ("No budget for campaign") because
        // campaign-level bid_strategy requires CBO (campaign-level budget).
        access_token: accessToken,
      },
    );

    const campaignId = response.data?.id;
    if (!campaignId) throw new Error('No campaign ID in response');

    this.logger.log(`Campaign created: ${campaignId}`);
    return campaignId;
  }

  private async createAdSet(
    accountId: string,
    accessToken: string,
    campaignId: string,
    config: MetaAdSetConfig,
    totalBudget: number,
    conversionEvent: string,
    pixelId?: string,
    customEventName?: string,
    customConversionId?: string,
    applicationId?: string,
    objectStoreUrl?: string,
    objectStoreUrlIos?: string,
    objectStoreUrlAndroid?: string,
  ): Promise<string> {
    // ABO: budget at ad set level for testing new creatives/audiences
    const dailyBudgetPaise = Math.round(
      ((totalBudget * config.budgetPercent) / 100) * 100,
    );

    // Geo targeting — Meta rejects overlapping locations (subcode 1487756) if
    // we send both countries AND regions/cities of the same country. So when
    // states or cities are set, drop the country and use the narrower layer
    // alone. The targeting resolver populates geoStates with top-purchase-
    // intent states (Maharashtra, TN, Karnataka, etc.) so we don't waste
    // budget on low-conversion regions.
    const hasStates = config.geoStates && config.geoStates.length > 0;
    const hasCities = config.geoCities && config.geoCities.length > 0;
    const geoLocations: any = { location_types: ['home', 'recent'] };
    if (hasStates) {
      geoLocations.regions = config.geoStates!.map((key) => ({ key }));
    }
    if (hasCities) {
      geoLocations.cities = config.geoCities!.map((key) => ({
        key,
        radius: 25,
        distance_unit: 'kilometer',
      }));
    }
    if (!hasStates && !hasCities) {
      geoLocations.countries = config.geoLocations ?? ['IN'];
    }
    const targeting: any = { geo_locations: geoLocations };

    // Audience type specific targeting
    if (
      ['lookalike', 'retarget', 'custom'].includes(config.audienceType) &&
      config.metaAudienceId
    ) {
      targeting.custom_audiences = [{ id: config.metaAudienceId }];
      targeting.targeting_automation = { advantage_audience: 0 };
      if (config.ageMin) targeting.age_min = config.ageMin;
      if (config.ageMax) targeting.age_max = config.ageMax;
      if (config.gender === 'male') targeting.genders = [1];
      else if (config.gender === 'female') targeting.genders = [2];
    } else if (config.audienceType === 'advantage_plus') {
      // Meta requires age_max >= 65 for Advantage+ — omit age/gender constraints entirely
      targeting.targeting_automation = { advantage_audience: 1 };
      // Custom audience as an Advantage+ SUGGESTION — Meta's "Include these
      // custom audiences" box. Semantics differ sharply from the branch above:
      // with advantage_audience=1 this SEEDS delivery rather than restricting
      // it, and Meta will spend outside the audience whenever it expects a
      // better result. Never use this shape for true retargeting — that needs
      // audienceType retarget/custom (advantage_audience=0), which is what
      // actually confines delivery to the audience.
      if (config.metaAudienceId) {
        targeting.custom_audiences = [{ id: config.metaAudienceId }];
      }
    } else {
      // interest / broad — disable advantage audience
      targeting.targeting_automation = { advantage_audience: 0 };
      if (config.ageMin) targeting.age_min = config.ageMin;
      if (config.ageMax) targeting.age_max = config.ageMax;
      if (config.gender === 'male') targeting.genders = [1];
      else if (config.gender === 'female') targeting.genders = [2];
    }

    // Interest targeting — Meta requires real interest IDs (not names — names
    // are rejected). Populated by the targeting resolver from product.audience
    // Segments[].interests where each interest is { id, name }. The audience
    // resolver filters out plain-string interests so we never ship names here.
    if (config.interests && config.interests.length > 0) {
      targeting.flexible_spec = [
        {
          interests: config.interests.map((id) => ({ id, name: id })),
        },
      ];
    }

    // Locale targeting — filters delivery by platform language (e.g. 81=Marathi,
    // per META_LOCALE_IDS — verified via /search?type=adlocale, never guessed).
    // Empty array means no filter; resolver only populates when segment/product
    // specifies languages. Compatible with all audienceTypes including advantage_plus.
    if (Array.isArray(config.locales) && config.locales.length > 0) {
      targeting.locales = config.locales;
    }

    // Device OS targeting — splits a campaign into per-platform ad sets
    // (independent budget/reporting). Values are Meta's literal, case-
    // sensitive strings ('iOS'/'Android'), not ISO or lowercase.
    if (Array.isArray(config.userOs) && config.userOs.length > 0) {
      targeting.user_os = config.userOs;
    }

    // Exclude audiences (past buyers)
    if (config.excludeAudienceIds && config.excludeAudienceIds.length > 0) {
      targeting.excluded_custom_audiences = config.excludeAudienceIds.map(
        (id) => ({ id }),
      );
    }

    // Placement preset — resolvePlacementPreset() in placement-presets.ts is
    // the single source of truth for what each preset resolves to. Always
    // scoped to facebook+instagram, never Audience Network/Messenger — for
    // Indian DTC, AN is mostly garbage app-install clicks (5-15% of budget
    // historically burned there before the auditor caught it). Undefined
    // config.placementPreset resolves to 'vertical', the long-standing
    // default: every image/video asset this pipeline produces is 9:16 with
    // text baked into the top/bottom ~15% margins, and Feed/Marketplace
    // center-crop to fit (crop math: 9:16→1:1 drops the outer ~22% off both
    // edges), which was cutting the hook text and CTA off entirely. Callers
    // that know their creative tolerates a crop (or supply non-vertical
    // sizes) can opt into 'vertical_feed'/'everywhere' explicitly.
    const resolvedPlacements = resolvePlacementPreset(config.placementPreset);
    targeting.publisher_platforms = resolvedPlacements.publisherPlatforms;
    targeting.facebook_positions = resolvedPlacements.facebookPositions;
    targeting.instagram_positions = resolvedPlacements.instagramPositions;

    // Bid strategy: prefer COST_CAP when bidAmountInr is supplied (anchors
    // broad cold audiences to historical CPA, prevents ₹6 junk-traffic spiral
    // that the May 2026 agent campaign hit — 0.10% CVR on ₹6 CPC because
    // LOWEST_COST_WITHOUT_CAP delivered to lowest-quality placements).
    // Fall back to LOWEST_COST_WITHOUT_CAP when no bid is set (custom-audience
    // retargeting where the audience itself is the quality gate).
    //
    // Guard: Meta rejects COST_CAP + optimization_goal=VALUE (Value-Based Bidding
    // is only compatible with LOWEST_COST_WITHOUT_CAP or LOWEST_COST_WITH_MIN_ROAS).
    // When VALUE is set, suppress COST_CAP regardless of bidAmountInr.
    const optimizationGoal = config.optimizationGoal || 'OFFSITE_CONVERSIONS';
    const isValueOptimization = optimizationGoal === 'VALUE';
    const useBidCap =
      !isValueOptimization &&
      typeof config.bidAmountInr === 'number' &&
      config.bidAmountInr > 0;
    if (
      isValueOptimization &&
      typeof config.bidAmountInr === 'number' &&
      config.bidAmountInr > 0
    ) {
      this.logger.warn(
        `bidAmountInr=${config.bidAmountInr} supplied but suppressed — COST_CAP is incompatible with optimization_goal=VALUE. Ad set will ship with LOWEST_COST_WITHOUT_CAP (Highest Value).`,
      );
    }
    const adSetData: any = {
      name: config.name,
      campaign_id: campaignId,
      daily_budget: dailyBudgetPaise,
      billing_event: 'IMPRESSIONS',
      optimization_goal: optimizationGoal,
      // destination_type: 'WEBSITE' only applies to website-pixel ad sets —
      // Meta rejects it on App Promotion/Engagement ad sets (application_id
      // promoted_object), so it's omitted whenever applicationId is set.
      ...(applicationId ? {} : { destination_type: 'WEBSITE' }),
      bid_strategy: useBidCap ? 'COST_CAP' : 'LOWEST_COST_WITHOUT_CAP',
      ...(useBidCap
        ? { bid_amount: Math.round(config.bidAmountInr! * 100) }
        : {}),
      targeting,
      status: 'PAUSED',
      access_token: accessToken,
    };

    // Attribution: 7-day click + 1-day view — view-through captures 15-25% more
    // attributed conversions for video-heavy creative. Click-only under-counts
    // video performance and biases the audit loop's format-comparison toward image.
    // Only confirmed safe for OFFSITE_CONVERSIONS, the goal every AI-generated
    // campaign uses and the one this spec was tuned against.
    //
    // Every other optimization_goal has its OWN, narrower, largely undocumented
    // set of valid click/view window combinations — e.g. VALUE (VBB) accepts
    // only (CLICK_THROUGH 1, 0) or (CLICK_THROUGH 7, 0); LANDING_PAGE_VIEWS hit
    // subcode 1885501 "View-through attribution window is invalid" in production
    // (2026-07-16) demanding (CLICK_THROUGH 1, 0) instead — a THIRD combination,
    // not one of the two already handled. Rather than special-case every goal
    // Meta might reject differently, fall back to the one window nearly every
    // goal accepts (CLICK_THROUGH, 1 day) for anything other than
    // OFFSITE_CONVERSIONS. This matters in practice because the manual
    // campaign form lets a human pick objective/optimizationGoal freely — the
    // AI path only ever produces OFFSITE_CONVERSIONS, so this branch protects
    // exactly the surface most likely to hit an unvalidated combination.
    // App campaigns (any optimization_goal, as long as applicationId is set —
    // App Engagement via OFFSITE_CONVERSIONS, App Installs, etc.) reject any
    // VIEW_THROUGH window outright: Meta only accepts (CLICK_THROUGH 1, view 0)
    // or (CLICK_THROUGH 7, view 0). Hit in production 2026-08-11 — the
    // OFFSITE_CONVERSIONS branch below (tuned for website pixel campaigns,
    // which DO accept a 1-day view window) sent the same 7-click+1-view spec
    // to an app ad set and got subcode 1885501 "View-through attribution
    // window is invalid", same failure family as the LANDING_PAGE_VIEWS case
    // already documented below. Must be checked before the optimizationGoal
    // branches, since App Engagement also reports optimizationGoal ===
    // 'OFFSITE_CONVERSIONS' and would otherwise fall into that branch.
    if (applicationId) {
      adSetData.attribution_spec = [
        { event_type: 'CLICK_THROUGH', window_days: 7 },
      ];
    } else if (optimizationGoal === 'OFFSITE_CONVERSIONS') {
      adSetData.attribution_spec = [
        { event_type: 'CLICK_THROUGH', window_days: 7 },
        { event_type: 'VIEW_THROUGH', window_days: 1 },
      ];
    } else if (isValueOptimization) {
      adSetData.attribution_spec = [
        { event_type: 'CLICK_THROUGH', window_days: 7 },
      ];
    } else {
      adSetData.attribution_spec = [
        { event_type: 'CLICK_THROUGH', window_days: 1 },
      ];
    }

    // Pixel for conversion optimization — only wired up for goals that
    // actually optimize toward a conversion event. Traffic-style goals
    // (LANDING_PAGE_VIEWS, LINK_CLICKS, REACH, IMPRESSIONS) don't optimize
    // toward conversions at all; attaching a Purchase custom_conversion_id
    // to one of those ad sets is a real config bug, not just unnecessary —
    // it points Meta at a promoted_object the chosen optimization_goal
    // can't act on. Hit in production 2026-07-16 on a LANDING_PAGE_VIEWS
    // ad set that had inherited the Purchase-tracking promoted_object meant
    // for the OFFSITE_CONVERSIONS path.
    //
    // The promoted_object shape depends on optimization_goal:
    //   - OFFSITE_CONVERSIONS + customConversionId: just custom_conversion_id.
    //     Meta derives the pixel internally; sending pixel_id alongside this
    //     path triggers subcode 1885014 ("invalid combination of parameters").
    //   - VALUE (VBB) + customConversionId: REQUIRES pixel_id alongside the
    //     custom_conversion_id. Sending custom_conversion_id alone returns
    //     subcode 1815430 ("Select a promoted object for your ad set") —
    //     Meta doesn't accept the implicit-pixel derivation for VBB. Hit on
    //     Nadi Leaf launch 2026-06-09.
    //   - No customConversionId: standard pixel+event path.
    //   - Traffic-style goals (LANDING_PAGE_VIEWS/LINK_CLICKS/REACH/
    //     IMPRESSIONS): NO promoted_object at all — confirmed by Meta
    //     rejecting even a bare `{pixel_id}` with subcode 1885014 ("invalid
    //     combination of parameters") in production 2026-07-16. These goals
    //     aren't tied to a conversion event, so Meta doesn't want a
    //     promoted_object for them; pixel-based reporting still works via
    //     the account's pixel without declaring it here.
    //   - APP_INSTALLS: the true Meta App Installs objective — REQUIRES a
    //     promoted_object (application_id + object_store_url), unlike the
    //     traffic-style goals above. Only reachable via the applicationId
    //     branch below since it's app-only; there's no APP_INSTALLS+pixel
    //     combination in Meta's API.
    const isConversionGoal =
      optimizationGoal === 'OFFSITE_CONVERSIONS' ||
      optimizationGoal === 'APP_INSTALLS' ||
      isValueOptimization;
    if (!isConversionGoal) {
      // Intentionally no promoted_object.
    } else if (applicationId && conversionEvent) {
      // App Promotion / App Engagement — targets Meta App Events on
      // applicationId instead of a website pixel. Custom Conversions
      // (customConversionId) are a Pixel/Conversions-API-only construct in
      // Meta, so this branch is checked before, and short-circuits, the
      // pixel-based branches below — applicationId and pixelId are mutually
      // exclusive per product (see Product.metaAppId's doc comment).
      //
      // UNVALIDATED IN PRODUCTION as of 2026-08-07 — built from Meta's
      // documented promoted_object/App Events reference, not yet confirmed
      // against a live launch the way the pixel branch below has been
      // (see the subcode-specific comments on that branch). Watch the first
      // real launch closely for a rejected combination.
      const mappedEventType = this.mapConversionEvent(conversionEvent);
      // Per-platform store URL wins when this ad set targets exactly one OS
      // (config.userOs === ['iOS'] or ['Android']) and that platform's URL is
      // set on the product; otherwise falls back to the campaign-default
      // objectStoreUrl. A mixed/unset userOs always uses the default — Meta
      // requires ONE object_store_url per ad set, so there's no correct
      // per-platform choice when an ad set targets both (or neither).
      const singleOs =
        config.userOs?.length === 1 ? config.userOs[0] : undefined;
      const resolvedObjectStoreUrl =
        (singleOs === 'iOS' && objectStoreUrlIos) ||
        (singleOs === 'Android' && objectStoreUrlAndroid) ||
        objectStoreUrl ||
        undefined;
      adSetData.promoted_object = {
        application_id: applicationId,
        custom_event_type: mappedEventType,
        // object_store_url is mandatory for the App Installs objective, but
        // NOT for pure App Engagement ad sets that only optimize toward an
        // existing user's in-app event — omit when unset rather than send
        // an empty/wrong value.
        ...(resolvedObjectStoreUrl
          ? { object_store_url: resolvedObjectStoreUrl }
          : {}),
      };
      // custom_event_str is only valid alongside custom_event_type=OTHER.
      // Every in-app event this pipeline currently knows about (chat_success,
      // chat_started, etc.) is non-standard and maps to OTHER.
      if (mappedEventType === 'OTHER') {
        adSetData.promoted_object.custom_event_str =
          customEventName ?? conversionEvent;
      }
    } else if (customConversionId) {
      if (isValueOptimization && pixelId) {
        adSetData.promoted_object = {
          pixel_id: pixelId,
          custom_conversion_id: customConversionId,
        };
      } else {
        adSetData.promoted_object = {
          custom_conversion_id: customConversionId,
        };
      }
    } else if (pixelId && conversionEvent) {
      // Standard or custom event
      adSetData.promoted_object = {
        pixel_id: pixelId,
        custom_event_type: this.mapConversionEvent(conversionEvent),
      };
      // Custom events need custom_event_str with the actual event name
      if (conversionEvent === 'CustomEvent') {
        adSetData.promoted_object.custom_event_str =
          customEventName ?? conversionEvent;
      } else if (
        !['Purchase', 'Lead', 'CompleteRegistration', 'Subscribe'].includes(
          conversionEvent,
        )
      ) {
        adSetData.promoted_object.custom_event_str = conversionEvent;
      }
    }

    this.logger.log(
      `Creating ad set: ${config.name} | payload: ${JSON.stringify({ ...adSetData, access_token: '[REDACTED]' })}`,
    );

    try {
      const response = await this.metaApiCall(
        'POST',
        `${META_API_BASE}/${accountId}/adsets`,
        adSetData,
      );

      const adSetId = response.data?.id;
      if (!adSetId)
        throw new Error(`No ad set ID in response for ${config.name}`);

      this.logger.log(`Ad set created: ${adSetId}`);
      return adSetId;
    } catch (err: any) {
      // Custom audience expired/deleted/wrong-account — Meta returns
      // "Invalid parameter" with error_subcode 1359207 for expired
      // audiences, 3858504 for some deletions, or a bare code:100 "Invalid
      // parameter" for others (e.g. an audience saved against a DIFFERENT
      // ad account than the one being launched to — hit in production
      // 2026-07-16, an auto-added Purchasers-exclusion audience that only
      // existed on the tenant's default account).
      const isAudienceError = (e: any) =>
        e.message?.includes('subcode: 1359207') ||
        e.message?.includes('subcode: 3858504') ||
        (e.message?.includes('code: 100') &&
          e.message?.includes('Invalid parameter'));
      const hasIncludes = !!targeting.custom_audiences;
      const hasExcludes = !!targeting.excluded_custom_audiences;
      if (!isAudienceError(err) || (!hasIncludes && !hasExcludes)) throw err;

      // Stage 1: drop ONLY the exclusion list first, keeping the
      // deliberately-chosen include audience and age/gender targeting
      // intact. An exclude-audience problem (the common case — a saved
      // Purchasers audience invalid on this account) shouldn't cost the
      // whole ad set's precise targeting; only fall back further if the
      // chosen audience itself also turns out to be bad.
      if (hasExcludes) {
        this.logger.warn(
          `Excluded audience unavailable for "${config.name}" (excludes: ${config.excludeAudienceIds?.join(',') ?? 'none'}) — retrying without exclusions, keeping chosen audience/age/gender intact.`,
        );
        delete targeting.excluded_custom_audiences;
        adSetData.targeting = targeting;
        try {
          const retryResponse = await this.metaApiCall(
            'POST',
            `${META_API_BASE}/${accountId}/adsets`,
            adSetData,
          );
          const adSetId = retryResponse.data?.id;
          if (!adSetId)
            throw new Error(`No ad set ID in retry response for ${config.name}`);
          this.logger.log(`Ad set created (exclusion dropped): ${adSetId}`);
          return adSetId;
        } catch (err2: any) {
          if (!isAudienceError(err2)) throw err2;
          // Falls through to Stage 2 — the chosen audience is bad too.
        }
      }

      // Stage 2: chosen audience itself unavailable — last resort, fall
      // back to Advantage+ broad targeting (loses precise targeting).
      this.logger.warn(
        `Audience unavailable for "${config.name}" (custom: ${config.metaAudienceId ?? 'none'}) — retrying as Advantage+ broad targeting.`,
      );
      delete targeting.custom_audiences;
      delete targeting.excluded_custom_audiences;
      targeting.targeting_automation = { advantage_audience: 1 };
      delete targeting.age_min;
      delete targeting.age_max;
      delete targeting.genders;
      adSetData.targeting = targeting;

      const retryResponse = await this.metaApiCall(
        'POST',
        `${META_API_BASE}/${accountId}/adsets`,
        adSetData,
      );
      const adSetId = retryResponse.data?.id;
      if (!adSetId)
        throw new Error(`No ad set ID in retry response for ${config.name}`);
      this.logger.log(`Ad set created (advantage_plus fallback): ${adSetId}`);
      return adSetId;
    }
  }

  private async createAd(
    accountId: string,
    accessToken: string,
    adSetId: string,
    adName: string,
    copy: { primaryText: string; headline: string; cta: string },
    images: MetaImageAsset[],
    pageId: string,
    landingUrl: string,
    /**
     * True when the target ad set only runs vertical surfaces (Stories/Reels),
     * which is createAdSet's DEFAULT. Drives pickPrimaryImageSize so the one
     * image that ships matches the placement instead of being cropped into it.
     */
    verticalPlacements = false,
  ): Promise<{ adId: string; creativeId: string }> {
    // Dedup by hash — a variant tagged with the same hash under two aspect
    // ratios (shouldn't normally happen, but campaign-creator.service.ts
    // doesn't guarantee it) must not turn into a pointless 1-rule asset_feed_spec.
    const distinctImages = images.filter(
      (img, i) => img.hash && images.findIndex((o) => o.hash === img.hash) === i,
    );

    // Step 1: Create ad creative
    const creativeData: any = {
      name: `Creative — ${adName}`,
      object_story_spec: {
        page_id: pageId,
        // link_data stays populated even in the multi-size branch below — it's
        // what Meta uses for the creative preview / any placement not covered
        // by asset_customization_rules, so it must carry the same copy/CTA
        // asset_feed_spec does, not be left as a bare fallback.
        link_data: {
          link: landingUrl,
          message: copy.primaryText,
          name: copy.headline,
          call_to_action: {
            type: this.mapCta(copy.cta),
            value: { link: landingUrl },
          },
        },
      },
      access_token: accessToken,
    };

    // asset_customization_rules (Placement Asset Customization) is DISABLED
    // as of 2026-07-16 — Meta rejected it outright with subcode 1885896
    // ("The asset customisation rules field is not supported in asset
    // feed"), a feature-availability error, not a payload-shape bug. Most
    // likely requires is_dynamic_creative=true on the ad set, which is a
    // bigger, untested change with its own behavioral implications (Meta
    // then auto-mixes creative elements per user rather than deterministic
    // placement routing). After 4 failed real launch attempts chasing this,
    // reliability wins: fall back to the single best size — the same
    // plain image_hash path proven working all session — rather than keep
    // iterating on an unverified feature. buildImageAssetFeedSpec is kept
    // for when Dynamic Creative support is added properly.
    const primaryImage = this.pickPrimaryImageSize(
      distinctImages,
      verticalPlacements,
    );
    if (primaryImage?.hash) {
      creativeData.object_story_spec.link_data.image_hash = primaryImage.hash;
    }

    const creativeResponse = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/adcreatives`,
      creativeData,
    );

    const creativeId = creativeResponse.data?.id;
    if (!creativeId) throw new Error(`No creative ID for ${adName}`);

    // Step 2: Create the ad
    const adResponse = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/ads`,
      {
        name: adName,
        adset_id: adSetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: accessToken,
      },
    );

    const adId = adResponse.data?.id;
    if (!adId) {
      // Ad creation failed but creative exists — track for cleanup
      throw new Error(
        `No ad ID for ${adName} (dangling creative: ${creativeId})`,
      );
    }

    this.logger.log(`Ad created: ${adId} (${adName})`);
    return { adId, creativeId };
  }

  /**
   * Picks the single best size when placement customization isn't in play
   * (currently always — see buildImageAssetFeedSpec). Exactly ONE image ships
   * per ad, so this choice decides what every impression looks like.
   *
   * `verticalPlacements` matters more than it looks. createAdSet defaults every
   * ad set to Stories + Reels ONLY (facebook_positions ['facebook_reels','story'],
   * instagram_positions ['story','reels']) — all 9:16 surfaces. Preferring 4:5
   * there handed Meta a portrait image for vertical-only placements, so it got
   * pillarboxed or cropped on every single impression, while the correct 9:16
   * asset sat uploaded and unused. Feed-style placements still prefer 4:5,
   * which is Meta's own Feed default and usually the plurality of impressions.
   */
  private pickPrimaryImageSize(
    images: MetaImageAsset[],
    verticalPlacements = false,
  ): MetaImageAsset | undefined {
    if (verticalPlacements) {
      const vertical =
        images.find((img) => img.aspectRatio === '9:16') ??
        images.find((img) => img.aspectRatio === '4:5');
      if (vertical) return vertical;
    }
    return (
      images.find((img) => img.aspectRatio === '4:5') ??
      images.find((img) => img.aspectRatio === '1:1') ??
      images.find((img) => img.aspectRatio === '16:9') ??
      images.find((img) => img.aspectRatio === '9:16') ??
      images[0]
    );
  }

  /**
   * Meta Placement Asset Customization (asset_feed_spec) — DISABLED as of
   * 2026-07-16 (see createAd/createVideoAd, which call pickPrimaryImageSize
   * instead). Meta rejected asset_customization_rules outright with subcode
   * 1885896 ("The asset customisation rules field is not supported in
   * asset feed") — a feature-availability error, not a payload-shape bug;
   * most likely requires is_dynamic_creative=true on the ad set, untested.
   * Kept here, unused, so re-enabling later (once Dynamic Creative support
   * is added and verified) doesn't mean rebuilding this from scratch.
   *
   * Routes a vertical (9:16) image to Instagram Stories/Reels; every other
   * placement falls back to the non-vertical (4:5 preferred, else
   * 1:1/16:9/whatever else was given) image automatically, since it's
   * listed FIRST in `images[]` — Meta uses the first asset in the array as
   * the default for any placement not matched by a rule. Deliberately no
   * explicit catch-all rule (an `asset_customization_rules` entry with no
   * `customization_spec`, meant to mean "match anything else") —
   * undocumented whether Meta's API actually accepts that shape.
   *
   * Deliberately just two buckets, not a full per-placement mapping — Meta's
   * exact position enums for Audience Network / Facebook Reels / Messenger
   * drift across API versions, and a wrong guess fails the WHOLE ad creative
   * at launch time (this call is inside the sequential ad-set build loop, so
   * one bad request can abort the rest of the campaign launch). Instagram
   * Stories + Reels position values ('story', 'reels') are long-stable,
   * heavily-documented Meta constants — the highest-value, lowest-risk split.
   *
   * bodies/titles/link_urls are single-entry (no adlabels needed — Meta uses
   * the sole entry as the default when there's only one) since only the
   * IMAGE is being customized per placement here, not copy. call_to_actions
   * omits `value.link` — link_urls already supplies the destination, and
   * duplicating it there is unverified and unnecessary.
   */
  private buildImageAssetFeedSpec(
    images: MetaImageAsset[],
    copy: { primaryText: string; headline: string; cta: string },
    landingUrl: string,
  ): any {
    const vertical = images.find((img) => img.aspectRatio === '9:16');
    const nonVertical =
      images.find((img) => img.aspectRatio === '4:5') ??
      images.find((img) => img.aspectRatio === '1:1') ??
      images.find((img) => img.aspectRatio === '16:9') ??
      images.find((img) => img.hash !== vertical?.hash) ??
      images[0];

    const assetImages: Array<{ hash: string; adlabels: { name: string }[] }> = [];
    const rules: any[] = [];

    if (vertical && nonVertical && vertical.hash !== nonVertical.hash) {
      // Default/fallback asset listed FIRST.
      assetImages.push({ hash: nonVertical.hash, adlabels: [{ name: 'default' }] });
      assetImages.push({ hash: vertical.hash, adlabels: [{ name: 'vertical' }] });
      rules.push({
        customization_spec: {
          publisher_platforms: ['instagram'],
          instagram_positions: ['story', 'reels'],
        },
        image_label: { name: 'vertical' },
        priority: 1,
      });
    } else {
      // Callers only reach this method with >1 distinct hash, but if they
      // somehow all resolve to the same bucket, still emit a valid
      // single-image spec rather than an empty/malformed one.
      const only = nonVertical ?? vertical ?? images[0];
      assetImages.push({ hash: only.hash, adlabels: [{ name: 'default' }] });
    }

    return {
      images: assetImages,
      bodies: [{ text: copy.primaryText }],
      titles: [{ text: copy.headline }],
      link_urls: [{ website_url: landingUrl }],
      call_to_actions: [{ type: this.mapCta(copy.cta) }],
      ad_formats: ['SINGLE_IMAGE'],
      ...(rules.length > 0 ? { asset_customization_rules: rules } : {}),
    };
  }

  private async createVideoAd(
    accountId: string,
    accessToken: string,
    adSetId: string,
    adName: string,
    copy: { primaryText: string; headline: string; cta: string },
    videos: MetaVideoAsset[],
    pageId: string,
    landingUrl: string,
    fallbackThumbnailHash?: string,
  ): Promise<{ adId: string; creativeId: string }> {
    // Dedup by videoId — see createAd()'s identical guard for why.
    const distinctVideos = videos.filter(
      (v, i) => v.videoId && videos.findIndex((o) => o.videoId === v.videoId) === i,
    );
    // asset_customization_rules disabled as of 2026-07-16 — see
    // buildImageAssetFeedSpec for why. Pick the single best size instead of
    // routing per-placement, same as createAd().
    const primary =
      distinctVideos.find((v) => v.aspectRatio === '4:5') ??
      distinctVideos.find((v) => v.aspectRatio === '1:1') ??
      distinctVideos.find((v) => v.aspectRatio === '16:9') ??
      distinctVideos.find((v) => v.aspectRatio === '9:16') ??
      distinctVideos[0];

    const videoData: any = {
      video_id: primary?.videoId,
      message: copy.primaryText,
      call_to_action: {
        type: this.mapCta(copy.cta),
        value: { link: landingUrl },
      },
      title: copy.headline,
    };

    // Thumbnail is required by Meta for video ads
    const thumbnailHash = primary?.thumbnailHash ?? fallbackThumbnailHash;
    if (thumbnailHash) {
      videoData.image_hash = thumbnailHash;
    }

    const creativeData: any = {
      name: `Creative — ${adName}`,
      object_story_spec: {
        page_id: pageId,
        video_data: videoData,
      },
      access_token: accessToken,
    };

    this.logger.log(
      `Creating video creative: ${JSON.stringify({ ...creativeData, access_token: '[REDACTED]' })}`,
    );

    const creativeResponse = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/adcreatives`,
      creativeData,
    );

    const creativeId = creativeResponse.data?.id;
    if (!creativeId) throw new Error(`No creative ID for video ad ${adName}`);

    const adResponse = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/ads`,
      {
        name: adName,
        adset_id: adSetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: accessToken,
      },
    );

    const adId = adResponse.data?.id;
    if (!adId)
      throw new Error(
        `No ad ID for video ad ${adName} (dangling creative: ${creativeId})`,
      );

    this.logger.log(`Video ad created: ${adId} (${adName})`);
    return { adId, creativeId };
  }

  /**
   * Video counterpart of buildImageAssetFeedSpec — same vertical-vs-default
   * two-bucket placement split (Instagram Stories/Reels get the 9:16 cut,
   * everything else falls back to the non-vertical size by being listed
   * FIRST in `videos[]`, no explicit catch-all rule), just videos[] with a
   * required thumbnail per entry instead of images[]. See
   * buildImageAssetFeedSpec for why only two buckets and why no catch-all
   * rule (that shape — a rule with no customization_spec — is unconfirmed
   * against live Meta and is the leading suspect for a 2026-07-16 opaque
   * ad-creative-creation failure, subcode 1487390).
   */
  private buildVideoAssetFeedSpec(
    videos: MetaVideoAsset[],
    copy: { primaryText: string; headline: string; cta: string },
    landingUrl: string,
    fallbackThumbnailHash?: string,
  ): any {
    const vertical = videos.find((v) => v.aspectRatio === '9:16');
    const nonVertical =
      videos.find((v) => v.aspectRatio === '4:5') ??
      videos.find((v) => v.aspectRatio === '1:1') ??
      videos.find((v) => v.aspectRatio === '16:9') ??
      videos.find((v) => v.videoId !== vertical?.videoId) ??
      videos[0];

    const assetVideos: Array<{ video_id: string; thumbnail_hash?: string; adlabels: { name: string }[] }> = [];
    const rules: any[] = [];

    const toAsset = (v: MetaVideoAsset, label: string) => ({
      video_id: v.videoId,
      thumbnail_hash: v.thumbnailHash ?? fallbackThumbnailHash,
      adlabels: [{ name: label }],
    });

    if (vertical && nonVertical && vertical.videoId !== nonVertical.videoId) {
      // Default/fallback asset listed FIRST.
      assetVideos.push(toAsset(nonVertical, 'default'));
      assetVideos.push(toAsset(vertical, 'vertical'));
      rules.push({
        customization_spec: {
          publisher_platforms: ['instagram'],
          instagram_positions: ['story', 'reels'],
        },
        video_label: { name: 'vertical' },
        priority: 1,
      });
    } else {
      const only = nonVertical ?? vertical ?? videos[0];
      assetVideos.push(toAsset(only, 'default'));
    }

    return {
      videos: assetVideos,
      bodies: [{ text: copy.primaryText }],
      titles: [{ text: copy.headline }],
      link_urls: [{ website_url: landingUrl }],
      call_to_actions: [{ type: this.mapCta(copy.cta) }],
      ad_formats: ['SINGLE_VIDEO'],
      ...(rules.length > 0 ? { asset_customization_rules: rules } : {}),
    };
  }

  /**
   * Carousel ad — one ad with N linked cards (slides) the viewer swipes through.
   *
   * Different from single-image / video / mixed: those create N independent
   * variants in one ad set that compete via Meta's dynamic optimization.
   * Carousel is ONE ad with a coherent N-slide narrative, ideal for:
   *  - Multi-step process (the 5-step Nadi Leaf booking flow)
   *  - Multi-tier pricing (Starter / Standard / Complete shown as 3 cards)
   *  - Sequential storytelling (16 Kandams overview, before-the-leaf vs after)
   *  - Multi-feature showcase (4 differentiators as 4 cards)
   *
   * Each card has its own image, headline, optional description, and link. The
   * carousel as a whole has a single primaryText (`message`) shown above the
   * cards. Cards must share visual language — handled by the image generator
   * orchestration that produces N coherent images for one carousel package.
   *
   * Min 2 cards, Meta supports up to 10. Most performant range: 3-5 cards.
   */
  private async createCarouselAd(
    accountId: string,
    accessToken: string,
    adSetId: string,
    adName: string,
    primaryText: string,
    cta: string,
    pageId: string,
    landingUrl: string,
    cards: Array<{
      imageHash: string;
      headline: string;
      description?: string;
      cardLink?: string; // optional per-card link override (defaults to landingUrl)
    }>,
  ): Promise<{ adId: string; creativeId: string }> {
    if (!cards || cards.length < 2) {
      throw new Error(
        `Carousel ad "${adName}" requires at least 2 cards (got ${cards?.length ?? 0})`,
      );
    }
    if (cards.length > 10) {
      this.logger.warn(
        `Carousel ad "${adName}" has ${cards.length} cards; trimming to 10 (Meta hard limit)`,
      );
      cards = cards.slice(0, 10);
    }
    const ctaType = this.mapCta(cta);
    const childAttachments = cards.map((card) => ({
      image_hash: card.imageHash,
      link: card.cardLink ?? landingUrl,
      name: card.headline,
      ...(card.description ? { description: card.description } : {}),
      call_to_action: {
        type: ctaType,
        value: { link: card.cardLink ?? landingUrl },
      },
    }));

    const creativeData: any = {
      name: `Creative — ${adName}`,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          link: landingUrl,
          message: primaryText,
          child_attachments: childAttachments,
          // Multi_share_optimized lets Meta reorder cards by per-user performance.
          // For narrative carousels (step 1 → step 2 → step 3) this MUST be false
          // or the story breaks. Default to false; can be exposed as a flag later
          // if non-narrative carousels (independent benefit cards) want it on.
          multi_share_optimized: false,
          multi_share_end_card: true, // append page-end card with CTA — boosts CVR
          call_to_action: {
            type: ctaType,
            value: { link: landingUrl },
          },
        },
      },
      access_token: accessToken,
    };

    this.logger.log(
      `Creating carousel creative: ${adName} (${cards.length} cards)`,
    );

    const creativeResponse = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/adcreatives`,
      creativeData,
    );

    const creativeId = creativeResponse.data?.id;
    if (!creativeId)
      throw new Error(`No creative ID for carousel ad ${adName}`);

    const adResponse = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/ads`,
      {
        name: adName,
        adset_id: adSetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: accessToken,
      },
    );

    const adId = adResponse.data?.id;
    if (!adId)
      throw new Error(
        `No ad ID for carousel ad ${adName} (dangling creative: ${creativeId})`,
      );

    this.logger.log(
      `Carousel ad created: ${adId} (${adName}, ${cards.length} cards)`,
    );
    return { adId, creativeId };
  }

  // ─── Rollback: clean up on partial failure ──────────────────────────────────

  private async rollback(
    created: CreatedObjects,
    accessToken: string,
  ): Promise<void> {
    // Deleting the campaign cascades to all child ad sets and ads
    if (created.campaignId) {
      try {
        await axios.delete(`${META_API_BASE}/${created.campaignId}`, {
          params: { access_token: accessToken },
          timeout: 15000,
        });
        this.logger.log(
          `Rollback: deleted campaign ${created.campaignId} (cascades to ad sets + ads)`,
        );
      } catch (err: any) {
        this.logger.error(
          `Rollback failed for campaign ${created.campaignId}: ${err.message}`,
        );
      }
    }

    // Clean up any dangling creatives that weren't attached to ads
    for (const creativeId of created.creativeIds) {
      try {
        await axios.delete(`${META_API_BASE}/${creativeId}`, {
          params: { access_token: accessToken },
          timeout: 10000,
        });
        this.logger.log(`Rollback: deleted dangling creative ${creativeId}`);
      } catch {
        // Ignore — creative may have been cascade-deleted with campaign
      }
    }
  }

  // ─── Optimization actions (used by auditor) ─────────────────────────────────

  /**
   * Create a pixel-based custom audience (e.g. website visitors, purchasers).
   * Returns the audience ID.
   */
  async createPixelAudience(
    accountId: string,
    accessToken: string,
    name: string,
    pixelId: string,
    rule: { event: string; retentionDays: number },
  ): Promise<string> {
    // Meta deprecated `subtype: 'WEBSITE'` for pixel-event audiences in
    // Graph API v19+. v21 rejects it with code 2654 / subcode 1870053:
    // "The parameter 'subtype' is not supported in the current API version."
    // The audience type is now inferred from the `rule` shape — presence of
    // event_sources + filters means it's a pixel-event custom audience.
    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/customaudiences`,
      {
        name,
        retention_days: rule.retentionDays,
        rule: JSON.stringify({
          inclusions: {
            operator: 'or',
            rules: [
              {
                event_sources: [{ id: pixelId, type: 'pixel' }],
                retention_seconds: rule.retentionDays * 86400,
                filter: {
                  operator: 'and',
                  filters: [
                    { field: 'event', operator: 'eq', value: rule.event },
                  ],
                },
              },
            ],
          },
        }),
        access_token: accessToken,
      },
    );
    const id = response.data?.id;
    if (!id) throw new Error(`Failed to create audience "${name}"`);
    this.logger.log(`Pixel audience created: ${name} (${id})`);
    return id;
  }

  /**
   * Create a lookalike audience from a source custom audience.
   */
  async createLookalikeAudience(
    accountId: string,
    accessToken: string,
    name: string,
    sourceAudienceId: string,
    country: string,
    ratio: number, // 0.01 = 1%, 0.02 = 2%
  ): Promise<string> {
    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/customaudiences`,
      {
        name,
        subtype: 'LOOKALIKE',
        origin_audience_id: sourceAudienceId,
        lookalike_spec: { country, ratio },
        access_token: accessToken,
      },
    );
    const id = response.data?.id;
    if (!id) throw new Error(`Failed to create lookalike "${name}"`);
    this.logger.log(`Lookalike audience created: ${name} (${id})`);
    return id;
  }

  /**
   * Minimum members Meta requires in a lookalike SOURCE audience before it can
   * build the lookalike. Meta's documented floor is 100 people from a single
   * country; below that the build fails permanently with operation_status 433
   * ("We couldn't create your lookalike audience. Please delete this audience
   * and try creating it again") and never retries on its own.
   */
  static readonly LOOKALIKE_MIN_SEED_SIZE = 100;

  /**
   * Health of a single custom/lookalike audience.
   *
   * `usable` mirrors the pre-launch check in campaign-creator: codes below 400
   * are fine, 400+ means Meta refuses to deliver against it. `seedReady`
   * additionally requires the audience to be big enough to seed a lookalike —
   * a brand-new pixel audience is code 200 "ready" while still holding zero
   * people, which is exactly the state that produces a dead lookalike.
   */
  async getAudienceHealth(
    audienceId: string,
    accessToken: string,
  ): Promise<{
    id: string;
    name?: string;
    subtype?: string;
    size: number;
    usable: boolean;
    seedReady: boolean;
    deliveryCode?: number;
    operationCode?: number;
    reason?: string;
    /**
     * Present on LOOKALIKE audiences. Carries everything needed to rebuild the
     * audience identically — which matters because a dead lookalike can only
     * be repaired by delete-and-recreate, and the replacement must keep the
     * same seed, country and ratio or downstream targeting silently changes.
     */
    lookalikeSpec?: { originId: string; country: string; ratio: number };
  }> {
    const res = await this.metaApiCall('GET', `${META_API_BASE}/${audienceId}`, {
      fields:
        'id,name,subtype,lookalike_spec,delivery_status,operation_status,approximate_count_lower_bound',
      access_token: accessToken,
    });
    const d = res.data ?? {};
    const spec = d.lookalike_spec;
    const originId = spec?.origin?.[0]?.id;
    const deliveryCode = d.delivery_status?.code;
    const operationCode = d.operation_status?.code;
    const size = Number(d.approximate_count_lower_bound ?? 0);
    const usable =
      d.id === audienceId &&
      (deliveryCode === undefined || deliveryCode < 400) &&
      (operationCode === undefined || operationCode < 400);
    const bigEnough = size >= MetaAdsService.LOOKALIKE_MIN_SEED_SIZE;
    return {
      id: audienceId,
      name: d.name,
      subtype: d.subtype,
      ...(originId && spec
        ? {
            lookalikeSpec: {
              originId: String(originId),
              country: String(spec.country ?? 'IN'),
              ratio: Number(spec.ratio ?? 0.01),
            },
          }
        : {}),
      size,
      usable,
      // A seed must be usable AND populated. Meta reports delivery code 200 on
      // an empty, freshly-created audience, so the size check is what actually
      // prevents the two-seconds-after-creation failure.
      seedReady: usable && bigEnough,
      deliveryCode,
      operationCode,
      reason: !usable
        ? `unusable (delivery=${deliveryCode}, operation=${operationCode}: ${d.operation_status?.description ?? d.delivery_status?.description ?? 'unknown'})`
        : !bigEnough
          ? `too small to seed a lookalike (${size} < ${MetaAdsService.LOOKALIKE_MIN_SEED_SIZE})`
          : undefined,
    };
  }

  /**
   * Delete a custom/lookalike audience. Needed for lookalike repair: Meta will
   * not rebuild an audience stuck in operation_status 433 — its own error text
   * says to delete and recreate, so a repair pass has to do exactly that.
   */
  async deleteAudience(audienceId: string, accessToken: string): Promise<void> {
    await this.metaApiCall('DELETE', `${META_API_BASE}/${audienceId}`, {
      access_token: accessToken,
    });
    this.logger.log(`Audience deleted: ${audienceId}`);
  }

  /**
   * List custom + lookalike audiences that live in ONE specific ad account.
   * Custom Audiences are account-scoped Meta objects — an audience created
   * under act_A is a different object from anything in act_B, even with an
   * identical name, unless explicitly Business-Manager-shared. Used by the
   * Create Campaign form's audience picker so the list always matches
   * whichever account the campaign is actually being built for.
   */
  async listCustomAudiences(accountId: string, accessToken: string): Promise<MetaCustomAudience[]> {
    const acctRef = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    const res = await this.metaApiCall('GET', `${META_API_BASE}/${acctRef}/customaudiences`, {
      fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status',
      limit: 200,
      access_token: accessToken,
    });
    const rows: any[] = res?.data?.data ?? [];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.subtype === 'LOOKALIKE' ? 'lookalike' : 'custom',
      subtype: r.subtype,
      approxSizeLower: r.approximate_count_lower_bound ?? undefined,
      approxSizeUpper: r.approximate_count_upper_bound ?? undefined,
      deliveryStatus: r.delivery_status?.description ?? undefined,
    }));
  }

  /**
   * Pause an entire campaign on Meta.
   */
  async pauseCampaign(campaignId: string, accessToken: string): Promise<void> {
    await this.metaApiCall('POST', `${META_API_BASE}/${campaignId}`, {
      status: 'PAUSED',
      access_token: accessToken,
    });
    this.logger.log(`Campaign paused on Meta: ${campaignId}`);
  }

  /**
   * Validates a product's Custom Conversion ID against the specific ad
   * account it's about to be used on — Custom Conversions are account-scoped
   * in Meta, so an ID saved on the product (tenant-global) may not be shared
   * with every account it launches to. Meta does NOT reject ad-set creation
   * for an inaccessible custom_conversion_id — the ad set is created,
   * reports "Active", and simply never delivers any impressions, surfacing
   * only as a "delivery error" in Meta's UI, not an exception this code can
   * catch and roll back on (hit in production 2026-07-16). Falls back to
   * `undefined` (plain pixel+event tracking) rather than trust the saved ID
   * blindly. Shared by every path that can create an ad set — the initial
   * campaign launch AND ad sets added to an already-live campaign — after
   * the latter was found to skip this check entirely (2026-08-07 incident,
   * wish_letter_2026-08-07 tracked generic Purchase instead of its Custom
   * Conversion because addAdSet never passed customConversionId through).
   */
  async validateCustomConversionId(
    accountId: string,
    accessToken: string,
    customConversionId?: string,
  ): Promise<string | undefined> {
    if (!customConversionId) return undefined;
    const normalizedAccountId = `act_${accountId.replace(/^act_/, '')}`;
    try {
      const res = await this.metaApiCall(
        'GET',
        `${META_API_BASE}/${normalizedAccountId}/customconversions`,
        { fields: 'id', limit: 200, access_token: accessToken },
      );
      const available = new Set((res.data?.data ?? []).map((c: any) => c.id));
      if (!available.has(customConversionId)) {
        this.logger.warn(
          `Custom conversion ${customConversionId} not available on ${normalizedAccountId} — falling back to plain pixel+event tracking instead of a promoted_object that would silently never deliver.`,
        );
        return undefined;
      }
      return customConversionId;
    } catch (err: any) {
      this.logger.warn(
        `Custom conversion validation failed (falling back to plain pixel+event): ${err.message}`,
      );
      return undefined;
    }
  }

  /**
   * Create a new ad set in an existing campaign (used by auditor for retarget/narrowed ad sets).
   */
  async createAdSetInCampaign(
    campaignId: string,
    accessToken: string,
    config: MetaAdSetConfig,
    totalBudget: number,
    conversionEvent: string,
    pixelId?: string,
    customEventName?: string,
    customConversionId?: string,
    applicationId?: string,
    objectStoreUrl?: string,
    objectStoreUrlIos?: string,
    objectStoreUrlAndroid?: string,
  ): Promise<string> {
    // Need accountId from campaign — fetch it
    const campaignRes = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${campaignId}`,
      {
        fields: 'account_id',
        access_token: accessToken,
      },
    );
    const accountId = `act_${campaignRes.data?.account_id}`;

    const validatedCustomConversionId = await this.validateCustomConversionId(
      accountId,
      accessToken,
      customConversionId,
    );

    return this.createAdSet(
      accountId,
      accessToken,
      campaignId,
      config,
      totalBudget,
      conversionEvent,
      pixelId,
      customEventName,
      validatedCustomConversionId,
      applicationId,
      objectStoreUrl,
      objectStoreUrlIos,
      objectStoreUrlAndroid,
    );
  }

  /**
   * Create a single ad in an existing ad set (used by auditor for add_creative).
   * Uploads image, creates creative, creates ad — all in one call.
   */
  async createAdInAdSet(
    adSetId: string,
    accessToken: string,
    adName: string,
    copy: { primaryText: string; headline: string; cta: string },
    imageUrl: string,
    pageId: string,
    landingUrl: string,
    declaredSpecialAdCategories?: string[],
  ): Promise<{ adId: string; creativeId: string }> {
    // ── Safety pre-check — refuse launch on Meta-policy-violating copy ──────
    // One Meta policy strike can restrict a Business Manager for days. This is
    // the asymmetric-bet item: cheap regex check, prevents catastrophic outcomes.
    const safety = checkCopySafety({
      primaryText: copy.primaryText,
      headline: copy.headline,
      cta: copy.cta,
      declaredSpecialAdCategories,
    });
    if (!safety.safe) {
      const errorMsg = formatSafetyError(safety);
      this.logger.error(`Refusing to launch ad "${adName}" — ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Get accountId from ad set
    const adSetRes = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${adSetId}`,
      {
        fields: 'account_id',
        access_token: accessToken,
      },
    );
    const accountId = `act_${adSetRes.data?.account_id}`;

    // Upload image
    const imageHash = await this.uploadImage(imageUrl, accountId, accessToken);

    // Create ad + creative
    const result = await this.createAd(
      accountId,
      accessToken,
      adSetId,
      adName,
      copy,
      [{ hash: imageHash }],
      pageId,
      landingUrl,
    );

    // Activate the ad
    await this.updateAdStatus(result.adId, 'ACTIVE', accessToken);

    return result;
  }

  /**
   * Video counterpart of createAdInAdSet — used by the manual "add creative"
   * endpoint (video ads previously could only be attached at initial campaign
   * launch, never appended to an already-live ad set). Uploads the video,
   * lets Meta extract its own thumbnail (getVideoThumbnailHash — no separate
   * thumbnail upload needed from the caller), then creates + activates the ad.
   */
  async createVideoAdInAdSet(
    adSetId: string,
    accessToken: string,
    adName: string,
    copy: { primaryText: string; headline: string; cta: string },
    videoUrl: string,
    pageId: string,
    landingUrl: string,
    declaredSpecialAdCategories?: string[],
  ): Promise<{ adId: string; creativeId: string }> {
    // Same safety pre-check as the image path — one Meta policy strike can
    // restrict a Business Manager for days.
    const safety = checkCopySafety({
      primaryText: copy.primaryText,
      headline: copy.headline,
      cta: copy.cta,
      declaredSpecialAdCategories,
    });
    if (!safety.safe) {
      const errorMsg = formatSafetyError(safety);
      this.logger.error(`Refusing to launch video ad "${adName}" — ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const adSetRes = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${adSetId}`,
      { fields: 'account_id', access_token: accessToken },
    );
    const accountId = `act_${adSetRes.data?.account_id}`;

    const videoId = await this.uploadVideo(videoUrl, accountId, accessToken);
    const thumbnailHash = await this.getVideoThumbnailHash(videoId, accountId, accessToken);

    const result = await this.createVideoAd(
      accountId,
      accessToken,
      adSetId,
      adName,
      copy,
      [{ videoId, thumbnailHash }],
      pageId,
      landingUrl,
      thumbnailHash,
    );

    await this.updateAdStatus(result.adId, 'ACTIVE', accessToken);

    return result;
  }

  /**
   * Attach a custom audience to a live ad set's targeting. Read-modify-write
   * so we don't blow away geo / age / placements set at launch.
   *
   * Use case: agent campaigns launched before the warm/hot guard was deployed
   * (May 14 KAAL_SARPA) shipped audienceType="retarget" with no metaAudienceId
   * → Meta defaulted to Advantage+ broad. This method patches a real custom
   * audience onto the live ad set so warm copy reaches the warm pool.
   */
  async patchAdSetAudience(
    adSetId: string,
    accessToken: string,
    customAudienceId: string,
  ): Promise<void> {
    // Read current targeting so we don't lose geo/age/placements/excluded_audiences
    const currentRes = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${adSetId}`,
      {
        fields: 'targeting',
        access_token: accessToken,
      },
    );
    const targeting = currentRes.data?.targeting ?? {};

    // Merge: replace custom_audiences with the specified one. targeting_automation.advantage_audience
    // = 0 disables Meta's "Advantage+ audience expansion" — required when attaching a specific
    // custom audience or Meta will keep delivering broadly anyway.
    const newTargeting = {
      ...targeting,
      custom_audiences: [{ id: customAudienceId }],
      targeting_automation: { advantage_audience: 0 },
    };

    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      targeting: newTargeting,
      access_token: accessToken,
    });
    this.logger.log(
      `Ad set ${adSetId}: custom audience patched to ${customAudienceId}`,
    );
  }

  /**
   * Pause an individual ad.
   */
  async pauseAd(adId: string, accessToken: string): Promise<void> {
    await this.metaApiCall('POST', `${META_API_BASE}/${adId}`, {
      status: 'PAUSED',
      access_token: accessToken,
    });
    this.logger.log(`Ad paused: ${adId}`);
  }

  /**
   * Pause an entire ad set.
   */
  async pauseAdSet(adSetId: string, accessToken: string): Promise<void> {
    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      status: 'PAUSED',
      access_token: accessToken,
    });
    this.logger.log(`Ad set paused: ${adSetId}`);
  }

  /**
   * Update ad set daily budget (in INR rupees, converted to paise).
   */
  async updateAdSetBudget(
    adSetId: string,
    newDailyBudgetINR: number,
    accessToken: string,
  ): Promise<void> {
    const budgetPaise = Math.round(newDailyBudgetINR * 100);
    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      daily_budget: budgetPaise,
      access_token: accessToken,
    });
    this.logger.log(
      `Ad set budget updated: ${adSetId} → ₹${newDailyBudgetINR}/day`,
    );
  }

  /**
   * Update an existing ad's creative (swap creative on a live ad).
   */
  async updateAdCreative(
    adId: string,
    newCreativeId: string,
    accessToken: string,
  ): Promise<void> {
    await this.metaApiCall('POST', `${META_API_BASE}/${adId}`, {
      creative: { creative_id: newCreativeId },
      access_token: accessToken,
    });
    this.logger.log(`Ad creative updated: ${adId} → creative ${newCreativeId}`);
  }

  /**
   * Fix which Facebook Page a LIVE ad posts as, without touching the
   * campaign/ad set/ad IDs. Ad creatives are immutable on Meta — object_story_spec.page_id
   * can never be patched in place — so this reads the ad's current creative
   * (whatever copy/image/link/video is actually live), clones it with only
   * page_id overridden, creates that as a new creative object, and points
   * the existing ad at it via updateAdCreative. Works for image, video, and
   * carousel ads alike since none of link_data/video_data/asset_feed_spec is
   * touched — only the sibling page_id field on the same object_story_spec.
   *
   * Root incident (2026-07-29): company.meta.pageId pointed at the wrong
   * Page and every ad in a launched campaign inherited it — this is the
   * in-place fix, added so the campaign doesn't have to be relaunched from
   * scratch (losing ad set delivery/learning) just to correct the Page.
   *
   * The target Page must already be promote_pages-authorized on the ad
   * account this ad's account belongs to, or Meta rejects the new creative
   * outright — this does not (and cannot) grant that authorization itself.
   */
  async swapAdPage(
    adId: string,
    newPageId: string,
    accessToken: string,
  ): Promise<{ newCreativeId: string }> {
    const adRes = await this.metaApiCall('GET', `${META_API_BASE}/${adId}`, {
      fields: 'account_id,creative{name,object_story_spec}',
      access_token: accessToken,
    });
    const creative = adRes?.data?.creative;
    const objectStorySpec = creative?.object_story_spec;
    if (!objectStorySpec) {
      throw new Error(
        `Ad ${adId}: could not read current creative's object_story_spec — refusing to guess its shape and clone blind`,
      );
    }
    const accountId = `act_${adRes.data.account_id}`;

    const createRes = await this.metaApiCall('POST', `${META_API_BASE}/${accountId}/adcreatives`, {
      name: `${creative.name ?? 'Creative'} (page swap → ${newPageId})`,
      object_story_spec: { ...objectStorySpec, page_id: newPageId },
      access_token: accessToken,
    });
    const newCreativeId = createRes.data?.id;
    if (!newCreativeId) {
      throw new Error(`Ad ${adId}: page-swap creative creation returned no ID`);
    }

    await this.updateAdCreative(adId, newCreativeId, accessToken);
    this.logger.log(`Ad ${adId}: Page swapped to ${newPageId} via new creative ${newCreativeId}`);
    return { newCreativeId };
  }

  async updateAdStatus(
    adId: string,
    status: 'ACTIVE' | 'PAUSED',
    accessToken: string,
  ): Promise<void> {
    await this.metaApiCall('POST', `${META_API_BASE}/${adId}`, {
      status,
      access_token: accessToken,
    });
    this.logger.log(`Ad status updated: ${adId} → ${status}`);
  }

  /**
   * Narrow an ad set's placements — disable bleeding inventory (Audience Network,
   * Stories, etc.) without pausing the whole ad set.
   *
   * IMPORTANT: Meta's POST to /{ad_set_id} REPLACES the whole `targeting` object,
   * so we must GET the existing targeting first, deep-merge ONLY the placement
   * subfields, and POST the merged object. Otherwise age/geo/audience/excluded
   * audiences/etc. get wiped, leaving the ad set delivering to a global pool.
   */

  /**
   * Read-only fetch of an ad set's current targeting. Returns the raw Meta
   * targeting object (publisher_platforms, *_positions, age_min/max, locales,
   * geo_locations, custom_audiences — all the fields Meta tracks).
   *
   * Used by the audit's byPlacement filter to determine which placements are
   * currently active vs already-excluded. Null/undefined returns mean the ad
   * set has no restriction in that field (Meta's "all" default).
   */
  async getAdSetTargeting(
    adSetId: string,
    accessToken: string,
  ): Promise<Record<string, any> | null> {
    try {
      const response = await this.metaApiCall(
        'GET',
        `${META_API_BASE}/${adSetId}`,
        { fields: 'targeting', access_token: accessToken },
      );
      return (response?.data?.targeting ??
        response?.targeting ??
        null) as Record<string, any> | null;
    } catch (err: any) {
      this.logger.warn(
        `getAdSetTargeting failed for ${adSetId}: ${err.message}`,
      );
      return null;
    }
  }

  async updateAdSetPlacements(
    adSetId: string,
    placements: {
      publisherPlatforms: string[]; // e.g. ['facebook', 'instagram']
      facebookPositions?: string[]; // e.g. ['feed', 'video_feeds']
      instagramPositions?: string[]; // e.g. ['stream', 'reels']
      audienceNetworkPositions?: string[];
      messengerPositions?: string[];
    },
    accessToken: string,
  ): Promise<void> {
    if (!placements.publisherPlatforms?.length) {
      throw new Error(
        'updateAdSetPlacements: publisherPlatforms must be non-empty',
      );
    }

    // Fetch current targeting so we don't blow away age/geo/audience.
    const existing = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${adSetId}`,
      { fields: 'targeting', access_token: accessToken },
    );
    const currentTargeting: Record<string, any> = (existing?.data?.targeting ??
      existing?.targeting ??
      {}) as any;

    // Deep-clone existing, then overlay placement subfields. Remove position fields
    // that are no longer relevant (e.g. dropping audience_network from publisher_platforms
    // means audience_network_positions must also go, otherwise Meta rejects the call).
    const merged: Record<string, any> = JSON.parse(
      JSON.stringify(currentTargeting),
    );
    merged.publisher_platforms = placements.publisherPlatforms;

    const platformPositionMap: Record<string, string> = {
      facebook: 'facebook_positions',
      instagram: 'instagram_positions',
      audience_network: 'audience_network_positions',
      messenger: 'messenger_positions',
    };
    for (const [platform, posKey] of Object.entries(platformPositionMap)) {
      if (!placements.publisherPlatforms.includes(platform)) {
        delete merged[posKey];
      }
    }
    if (placements.facebookPositions)
      merged.facebook_positions = placements.facebookPositions;
    if (placements.instagramPositions)
      merged.instagram_positions = placements.instagramPositions;
    if (placements.audienceNetworkPositions)
      merged.audience_network_positions = placements.audienceNetworkPositions;
    if (placements.messengerPositions)
      merged.messenger_positions = placements.messengerPositions;

    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      targeting: merged,
      access_token: accessToken,
    });
    this.logger.log(
      `Ad set placements updated (merged into existing targeting): ${adSetId} → ${placements.publisherPlatforms.join(',')}`,
    );
  }

  /**
   * Set ad-set-level dayparting (adset_schedule). Each entry: {start_minute, end_minute, days}
   * where minute is 0-1440 (minutes from midnight) and days is [0..6] (Sun-Sat).
   *
   * IMPORTANT — TWO Meta gotchas:
   *   1. Without `pacing_type: ['day_parting']`, Meta accepts the call but ignores the schedule.
   *   2. `start_minute`/`end_minute` are interpreted in the AD ACCOUNT'S timezone, not UTC.
   *      Caller is responsible for ensuring the account timezone matches the schedule's intent.
   */
  async updateAdSetSchedule(
    adSetId: string,
    schedule: { startMinute: number; endMinute: number; days: number[] }[],
    accessToken: string,
  ): Promise<void> {
    if (!schedule.length) {
      throw new Error(
        'updateAdSetSchedule: schedule must have at least one slot (use empty pacing_type to clear)',
      );
    }
    for (const slot of schedule) {
      if (
        slot.startMinute < 0 ||
        slot.startMinute > 1440 ||
        slot.endMinute < 0 ||
        slot.endMinute > 1440
      ) {
        throw new Error(
          `updateAdSetSchedule: minutes must be 0-1440 (got ${slot.startMinute}-${slot.endMinute})`,
        );
      }
      if (slot.endMinute <= slot.startMinute) {
        throw new Error(
          `updateAdSetSchedule: endMinute must be > startMinute (slot ${slot.startMinute}-${slot.endMinute})`,
        );
      }
      if (!slot.days.every((d) => d >= 0 && d <= 6)) {
        throw new Error(
          `updateAdSetSchedule: days must be 0-6 (got ${slot.days})`,
        );
      }
    }

    const adset_schedule = schedule.map((s) => ({
      start_minute: s.startMinute,
      end_minute: s.endMinute,
      days: s.days,
    }));

    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      adset_schedule,
      pacing_type: ['day_parting'], // REQUIRED — Meta silently ignores adset_schedule without this
      access_token: accessToken,
    });
    this.logger.log(
      `Ad set schedule updated: ${adSetId} → ${schedule.length} slot(s)`,
    );
  }

  /**
   * Duplicate an ad set (deep copy — includes all child ads) and optionally swap the
   * audience on the copy. Used by `refresh_audience` to give a fatigued ad set a fresh
   * audience without losing the winning creative. The new ad set comes back PAUSED;
   * caller activates after any post-creation mutations.
   */
  async duplicateAdSetWithNewAudience(
    sourceAdSetId: string,
    accessToken: string,
    newAudience: {
      newAudienceId?: string; // existing Meta custom/lookalike audience to use
      useAdvantagePlus?: boolean; // alternative: switch to Advantage+ Audience
    },
  ): Promise<{ newAdSetId: string }> {
    if (!newAudience.newAudienceId && !newAudience.useAdvantagePlus) {
      throw new Error(
        'refresh_audience: must provide newAudienceId OR useAdvantagePlus=true',
      );
    }

    // 1) Deep-copy the source ad set (Meta /copies endpoint clones ads inside)
    const copyRes = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${sourceAdSetId}/copies`,
      {
        deep_copy: true,
        status_option: 'PAUSED',
        access_token: accessToken,
      },
    );
    const newAdSetId =
      copyRes?.data?.copied_adset_id ?? copyRes?.data?.ad_object_ids?.[0];
    if (!newAdSetId) {
      throw new Error(
        'refresh_audience: Meta /copies did not return a new adset id',
      );
    }

    // 2) Read existing targeting on the new copy and merge audience changes (read-modify-write
    //    so we don't blow away age/geo/excluded audiences — same pattern as updateAdSetPlacements).
    const existing = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${newAdSetId}`,
      { fields: 'targeting', access_token: accessToken },
    );
    const targeting: Record<string, any> = JSON.parse(
      JSON.stringify(existing?.data?.targeting ?? {}),
    );

    if (newAudience.useAdvantagePlus) {
      // Switch to Advantage+ Audience: clear custom audiences, enable advantage_audience flag
      delete targeting.custom_audiences;
      targeting.targeting_automation = {
        ...(targeting.targeting_automation ?? {}),
        advantage_audience: 1,
      };
    } else if (newAudience.newAudienceId) {
      targeting.custom_audiences = [{ id: newAudience.newAudienceId }];
      // Clear conflicting Advantage+ flag if it was set
      if (targeting.targeting_automation) {
        targeting.targeting_automation = {
          ...targeting.targeting_automation,
          advantage_audience: 0,
        };
      }
    }

    await this.metaApiCall('POST', `${META_API_BASE}/${newAdSetId}`, {
      targeting,
      access_token: accessToken,
    });

    // 3) Activate the new ad set
    await this.metaApiCall('POST', `${META_API_BASE}/${newAdSetId}`, {
      status: 'ACTIVE',
      access_token: accessToken,
    });

    this.logger.log(
      `refresh_audience: duplicated ${sourceAdSetId} → ${newAdSetId} with ${newAudience.useAdvantagePlus ? 'advantage_plus' : `audience ${newAudience.newAudienceId}`}`,
    );
    return { newAdSetId };
  }

  /**
   * Validate interest IDs against Meta's catalog before launch. Invalid IDs
   * previously shipped as-is — Meta either errors mid-launch (partial campaign)
   * or silently ignores them (ad set becomes accidental broad prospecting).
   * Uses /search?type=adinterestvalid with interest_fbid_list. Fails OPEN:
   * on lookup error every ID is reported valid — blocking launches because a
   * validation endpoint hiccuped would be worse than the rare bad ID.
   */
  async validateInterestIds(
    interestIds: string[],
    accessToken: string,
  ): Promise<{ valid: string[]; invalid: string[] }> {
    if (interestIds.length === 0) return { valid: [], invalid: [] };
    try {
      const res = await this.metaApiCall('GET', `${META_API_BASE}/search`, {
        type: 'adinterestvalid',
        interest_fbid_list: JSON.stringify(interestIds),
        access_token: accessToken,
      });
      const rows: any[] = res.data?.data ?? [];
      const validSet = new Set(
        rows.filter((r) => r.valid === true).map((r) => String(r.id)),
      );
      const valid = interestIds.filter((id) => validSet.has(String(id)));
      const invalid = interestIds.filter((id) => !validSet.has(String(id)));
      return { valid, invalid };
    } catch (err: any) {
      this.logger.warn(
        `Interest ID validation unavailable (proceeding unvalidated): ${err.message}`,
      );
      return { valid: interestIds, invalid: [] };
    }
  }

  /**
   * Keyword search for Meta detailed-targeting interests — powers the manual
   * Create Campaign form's interest picker. Returns real Meta interest IDs so
   * whatever the user picks passes validateInterestIds() unchanged at launch.
   */
  async searchInterests(
    query: string,
    accessToken: string,
  ): Promise<Array<{ id: string; name: string; audienceSize: number }>> {
    if (!query || query.trim().length < 2) return [];
    const res = await this.metaApiCall('GET', `${META_API_BASE}/search`, {
      type: 'adinterest',
      q: query.trim(),
      limit: 15,
      access_token: accessToken,
    });
    const rows: any[] = res.data?.data ?? [];
    const options = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      audienceSize: Number(r.audience_size_lower_bound ?? r.audience_size ?? 0),
    }));
    if (options.length === 0) return options;

    // Meta's two interest endpoints disagree: `adinterest` search happily
    // returns deprecated "Additional interests" (with real historical audience
    // sizes), while `adinterestvalid` reports them valid:false and launch
    // strips them. That gap is only discovered at launch — an operator picks
    // "Arranged marriage", sees it accepted, and finds out minutes into a
    // launch that it was never targetable. Validate here so dead interests are
    // never offered.
    //
    // Fails OPEN, like validateInterestIds itself: if the validity lookup
    // errors we return the unfiltered list rather than showing an empty picker.
    try {
      const { valid } = await this.validateInterestIds(
        options.map((o) => o.id),
        accessToken,
      );
      const validSet = new Set(valid);
      const usable = options.filter((o) => validSet.has(o.id));
      const dropped = options.length - usable.length;
      if (dropped > 0) {
        this.logger.log(
          `Interest search "${query.trim()}": hid ${dropped} of ${options.length} result(s) Meta reports as no longer targetable`,
        );
      }
      return usable;
    } catch (err: any) {
      this.logger.warn(
        `Interest validity filter unavailable for "${query.trim()}" (returning unfiltered): ${err.message}`,
      );
      return options;
    }
  }

  /**
   * Keyword search for Meta geo locations (regions/states + cities) — powers
   * the Create Campaign form's geo picker. Returns Meta region/city `key`
   * values, which is exactly what createAdSet() puts into
   * targeting.geo_locations.regions[].key / .cities[].key.
   *
   * Why this exists: the manual form could only target whole countries, so a
   * human-built campaign shipped `geo_locations.countries: ['IN']` and burned
   * budget on low-conversion states. The autonomous path had state targeting
   * (INDIA_TOP_ASTROLOGY_STATES in audience-targeting-resolver.ts) but those
   * keys were hand-verified via curl and hardcoded — this endpoint resolves
   * them live instead, so a key can never drift the way locale IDs did.
   */
  async searchGeoLocations(
    query: string,
    accessToken: string,
    opts: { type?: 'region' | 'city'; countryCode?: string } = {},
  ): Promise<
    Array<{
      key: string;
      name: string;
      type: string;
      region?: string;
      countryCode?: string;
    }>
  > {
    if (!query || query.trim().length < 2) return [];
    const res = await this.metaApiCall('GET', `${META_API_BASE}/search`, {
      type: 'adgeolocation',
      q: query.trim(),
      // Meta wants this as a JSON array string, not a repeated param.
      location_types: JSON.stringify([opts.type ?? 'region']),
      ...(opts.countryCode ? { country_code: opts.countryCode } : {}),
      limit: 25,
      access_token: accessToken,
    });
    const rows: any[] = res.data?.data ?? [];
    return rows.map((r) => ({
      key: String(r.key),
      name: String(r.name ?? ''),
      type: String(r.type ?? ''),
      region: r.region ? String(r.region) : undefined,
      countryCode: r.country_code ? String(r.country_code) : undefined,
    }));
  }

  /**
   * Resolve already-chosen geo keys back to display names via
   * /search?type=adgeolocationmeta. Needed because a saved campaign stores
   * bare keys ('1735'), and the geo search above only looks up BY NAME — so
   * without this, re-opening a campaign for edit shows "1735, 1738" instead
   * of "Maharashtra, Karnataka".
   *
   * Fails OPEN: any error, or a response shape Meta changes out from under
   * us, returns {} and the caller falls back to showing raw keys. A cosmetic
   * label lookup must never block editing a campaign.
   */
  async resolveGeoLocations(
    keys: { regions?: string[]; cities?: string[] },
    accessToken: string,
  ): Promise<Record<string, string>> {
    const regions = keys.regions ?? [];
    const cities = keys.cities ?? [];
    if (regions.length === 0 && cities.length === 0) return {};
    try {
      const res = await this.metaApiCall('GET', `${META_API_BASE}/search`, {
        type: 'adgeolocationmeta',
        ...(regions.length ? { regions: JSON.stringify(regions) } : {}),
        ...(cities.length ? { cities: JSON.stringify(cities) } : {}),
        access_token: accessToken,
      });
      const out: Record<string, string> = {};
      // Meta returns { data: { regions: { "<key>": {name, ...} }, cities: {...} } }.
      // Tolerate either that or a flat array — only `name` is actually used.
      const data = res.data?.data ?? res.data ?? {};
      for (const bucket of [data.regions, data.cities]) {
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [key, val] of Object.entries<any>(bucket)) {
          const name = val?.name ?? val?.region ?? val?.city;
          if (name) out[String(key)] = String(name);
        }
      }
      return out;
    } catch (err: any) {
      this.logger.warn(
        `Geo key label lookup unavailable (falling back to raw keys): ${err.message}`,
      );
      return {};
    }
  }

  // Locale lookups are stable per language; cache for the process lifetime so
  // repeated launches don't re-query Meta for the same name.
  private static readonly localeIdCache = new Map<string, number | null>();

  /**
   * Live-resolve a language name to its Meta locale ID via
   * /search?type=adlocale. This replaces the "verify each ID manually via
   * curl and update the table" workflow — only Marathi was ever verified, so
   * every other language silently shipped with zero locale targeting. Returns
   * null when Meta has no matching locale (caller skips that language).
   */
  async lookupLocaleId(
    languageName: string,
    accessToken: string,
  ): Promise<number | null> {
    const key = languageName.toLowerCase().trim();
    if (MetaAdsService.localeIdCache.has(key))
      return MetaAdsService.localeIdCache.get(key)!;
    try {
      const res = await this.metaApiCall('GET', `${META_API_BASE}/search`, {
        type: 'adlocale',
        q: key,
        access_token: accessToken,
      });
      const rows: any[] = res.data?.data ?? [];
      // Prefer exact name match ("Tamil"), else the language-only entry over
      // region variants ("Tamil (India)") — Meta returns both shapes.
      const exact = rows.find(
        (r) => String(r.name ?? '').toLowerCase() === key,
      );
      const prefix = rows.find((r) =>
        String(r.name ?? '')
          .toLowerCase()
          .startsWith(key),
      );
      const match = exact ?? prefix;
      const id = match?.key != null ? Number(match.key) : null;
      MetaAdsService.localeIdCache.set(key, id);
      if (id !== null) {
        this.logger.log(
          `Locale resolved live: ${key} → ${id} (${match.name}). Consider adding to META_LOCALE_IDS as verified.`,
        );
      } else {
        this.logger.warn(
          `Locale lookup found no Meta adlocale for "${key}" — language targeting skipped for it.`,
        );
      }
      return id;
    } catch (err: any) {
      this.logger.warn(
        `Locale lookup failed for "${key}" (language targeting skipped): ${err.message}`,
      );
      return null;
    }
  }

  /**
   * List ad accounts visible to the access token. Without `businessId`, hits
   * /me/adaccounts — every ad account the token's identity (user or system
   * user) can touch, across EVERY Business Manager it belongs to. For a
   * token shared by an agency managing multiple unrelated brands, that pulls
   * in every other brand's accounts too. Passing `businessId` scopes the
   * call to one Business Manager's owned_ad_accounts + client_ad_accounts
   * instead, matching what a human sees under that one business portfolio.
   */
  async listAdAccounts(accessToken: string, businessId?: string): Promise<MetaAdAccountSummary[]> {
    const fields = 'id,name,account_status,currency,timezone_name';
    let rows: any[];
    if (businessId) {
      const bizRef = businessId.trim();
      const [owned, client] = await Promise.all([
        this.paginateEdge(`${META_API_BASE}/${bizRef}/owned_ad_accounts`, {
          fields, access_token: accessToken, limit: 200,
        }),
        // client_ad_accounts = accounts other businesses shared INTO this one
        // (agency-managed clients). Own permission scope can lack visibility
        // here even when owned_ad_accounts works — don't let that 403 kill discovery.
        this.paginateEdge(`${META_API_BASE}/${bizRef}/client_ad_accounts`, {
          fields, access_token: accessToken, limit: 200,
        }).catch((err: any) => {
          this.logger.warn(`client_ad_accounts fetch failed for business ${bizRef}: ${err.message}`);
          return [];
        }),
      ]);
      const seen = new Set<string>();
      rows = [...owned, ...client].filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
    } else {
      rows = await this.paginateEdge(`${META_API_BASE}/me/adaccounts`, {
        fields, access_token: accessToken, limit: 200,
      });
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: META_ACCOUNT_STATUS[r.account_status] ?? 'other',
      currency: r.currency,
      timezoneName: r.timezone_name,
    }));
  }

  /**
   * List Facebook Pages available for ad identity (company.meta.pageId).
   * /me/accounts returns Pages the token can directly manage — these are
   * postable right now. When businessId is set, also cross-references the
   * Business Manager's owned_pages + client_pages so Pages the business owns
   * but hasn't granted this token a role on yet still show up (accessible:
   * false) instead of silently vanishing from the picker.
   *
   * When accountIds is set, also cross-references each ad account's own
   * promote_pages allowlist — the exact per-account gate Meta Ads Manager
   * enforces, tighter than "the Business owns it" or "the token can manage
   * it": a Page can pass both of those and still get rejected at launch if
   * it isn't authorized on the specific ad account being used.
   *
   * Added after a prod incident (2026-07-29) where company.meta.pageId was
   * hand-typed and silently pointed at the wrong Page under the same
   * Business Manager — there was no way to see/select from the real list.
   */
  async listPages(accessToken: string, businessId?: string, accountIds?: string[]): Promise<MetaPageSummary[]> {
    const fields = 'id,name,category';
    const managed = await this.paginateEdge(`${META_API_BASE}/me/accounts`, {
      fields, access_token: accessToken, limit: 200,
    });
    const seen = new Set<string>(managed.map((p) => p.id));
    const pages: MetaPageSummary[] = managed.map((p) => ({
      id: p.id, name: p.name, category: p.category, accessible: true, promotable: false,
    }));

    if (businessId) {
      const bizRef = businessId.trim();
      const [owned, client] = await Promise.all([
        this.paginateEdge(`${META_API_BASE}/${bizRef}/owned_pages`, {
          fields, access_token: accessToken, limit: 200,
        }).catch((err: any) => {
          this.logger.warn(`owned_pages fetch failed for business ${bizRef}: ${err.message}`);
          return [];
        }),
        this.paginateEdge(`${META_API_BASE}/${bizRef}/client_pages`, {
          fields, access_token: accessToken, limit: 200,
        }).catch((err: any) => {
          this.logger.warn(`client_pages fetch failed for business ${bizRef}: ${err.message}`);
          return [];
        }),
      ]);
      for (const p of [...owned, ...client]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        pages.push({ id: p.id, name: p.name, category: p.category, accessible: false, promotable: false });
      }
    }

    if (accountIds?.length) {
      const promotableResults = await Promise.all(accountIds.map((id) => {
        const acctRef = id.startsWith('act_') ? id : `act_${id}`;
        return this.paginateEdge(`${META_API_BASE}/${acctRef}/promote_pages`, {
          fields, access_token: accessToken, limit: 200,
        }).catch((err: any) => {
          this.logger.warn(`promote_pages fetch failed for ${acctRef}: ${err.message}`);
          return [];
        });
      }));
      for (const p of promotableResults.flat()) {
        const existing = pages.find((x) => x.id === p.id);
        if (existing) existing.promotable = true;
        else {
          seen.add(p.id);
          pages.push({ id: p.id, name: p.name, category: p.category, accessible: false, promotable: true });
        }
      }
    }

    return pages;
  }

  /**
   * Resolve a single Page's name/category by ID — used on the campaign
   * approval screen to show "this will post as <name>" instead of a bare ID
   * a human can't sanity-check. Returns null (never throws) if the ID is
   * invalid or the token can't see it, so the approval screen can surface
   * that as its own warning rather than failing to render.
   */
  async getPage(pageId: string, accessToken: string): Promise<{ id: string; name: string; category?: string } | null> {
    try {
      const res = await this.metaApiCall('GET', `${META_API_BASE}/${pageId}`, {
        fields: 'id,name,category', access_token: accessToken,
      });
      return res?.data ? { id: res.data.id, name: res.data.name, category: res.data.category } : null;
    } catch (err: any) {
      this.logger.warn(`getPage failed for ${pageId}: ${err.message}`);
      return null;
    }
  }

  /**
   * List every Business Manager ("business portfolio") the access token's
   * identity belongs to. Used to help a tenant find their Business ID for
   * company.meta.businessId, rather than digging through Meta's own UI.
   */
  async listBusinesses(accessToken: string): Promise<{ id: string; name: string }[]> {
    const res = await this.metaApiCall('GET', `${META_API_BASE}/me/businesses`, {
      fields: 'id,name',
      access_token: accessToken,
      limit: 200,
    });
    const rows: any[] = res?.data?.data ?? [];
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /**
   * Get the ad account's configured timezone (e.g. "Asia/Kolkata", "America/Los_Angeles").
   * Used to gate dayparting — schedules are interpreted in this TZ, not UTC.
   */
  async getAdAccountTimezone(
    accountId: string,
    accessToken: string,
  ): Promise<string | null> {
    const acctRef = accountId.startsWith('act_')
      ? accountId
      : `act_${accountId}`;
    try {
      const res = await this.metaApiCall('GET', `${META_API_BASE}/${acctRef}`, {
        fields: 'timezone_name',
        access_token: accessToken,
      });
      return res?.data?.timezone_name ?? null;
    } catch (err: any) {
      this.logger.warn(
        `getAdAccountTimezone failed for ${accountId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Follows `paging.next` until exhausted or maxPages is hit. Confirmed live
   * 2026-08-03: owned_pages on this account's Business Manager returned 24
   * rows on one call and 43 on the next with the identical request (limit=200
   * does not guarantee a single page) — a picker built on the un-paginated
   * first page silently hides real Pages/accounts, which is exactly the class
   * of bug this whole feature exists to close. maxPages is a runaway backstop,
   * not an expected limit — no Business Manager here is 2000+ objects deep.
   */
  private async paginateEdge(url: string, params: any, maxPages = 10): Promise<any[]> {
    const rows: any[] = [];
    let nextUrl: string | null = url;
    let nextParams: any = params;
    for (let i = 0; i < maxPages && nextUrl; i++) {
      const res = await this.metaApiCall('GET', nextUrl, nextParams);
      rows.push(...(res?.data?.data ?? []));
      nextUrl = res?.data?.paging?.next ?? null;
      nextParams = undefined; // paging.next is already a complete URL with its own query params
    }
    return rows;
  }

  // ─── Retry wrapper for transient Meta API errors ────────────────────────────

  private async metaApiCall(
    method: 'POST' | 'GET' | 'DELETE',
    url: string,
    data?: any,
  ): Promise<any> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (method === 'POST') {
          return await axios.post(url, data, { timeout: 30000 });
        } else if (method === 'GET') {
          return await axios.get(url, { params: data, timeout: 30000 });
        } else {
          return await axios.delete(url, { params: data, timeout: 30000 });
        }
      } catch (err: any) {
        const hasNoResponse = !(err as AxiosError)?.response;
        const metaErrorCode = (err as AxiosError)?.response?.data
          ? (err as AxiosError<any>).response!.data.error?.code
          : undefined;
        // A request that never got a Meta response at all — timeout,
        // connection reset/refused, DNS failure — is just as transient as
        // Meta's own retryable error codes and was previously NOT retried
        // (RETRYABLE_ERROR_CODES only matches codes Meta actually returned
        // in a response body; a bare network failure has none, so
        // `metaErrorCode` was always undefined and the whole request
        // aborted on the first attempt). Hit in production 2026-07-16: a
        // plain `timeout of 30000ms exceeded` on ad-set creation rolled
        // back and failed an entire otherwise-correct campaign launch.
        // Classify by shape, not by an allowlist of specific errno values.
        // The allowlist that used to live here named five codes, so anything
        // else the OS can throw on a socket — EADDRNOTAVAIL, ENETUNREACH,
        // EHOSTUNREACH, EPIPE, EAI_AGAIN — still aborted on the spot with
        // retries left in the budget (hit 2026-07-26: an ad-account listing
        // burned attempt 1 on a real 80004 rate limit, then threw away
        // attempts 3 and 4 because attempt 2 came back `read EADDRNOTAVAIL`).
        // Every Node/libuv syscall error is `E...`; axios's own non-transient
        // config errors are `ERR_...` (ERR_BAD_OPTION, ERR_FR_TOO_MANY_REDIRECTS)
        // and must stay non-retryable — retrying those can never succeed.
        const errCode: string = err.code ?? '';
        const isNetworkError =
          hasNoResponse &&
          ((errCode.startsWith('E') && !errCode.startsWith('ERR_')) ||
            /timeout/i.test(err.message ?? ''));
        const isRetryable =
          RETRYABLE_ERROR_CODES.includes(metaErrorCode) || isNetworkError;
        const isLastAttempt = attempt === MAX_RETRIES;

        if (isRetryable && !isLastAttempt) {
          const delay = RETRY_DELAYS[attempt - 1] ?? 4000;
          this.logger.warn(
            `Meta API ${isNetworkError ? `network error (${err.code ?? err.message})` : `error (code ${metaErrorCode})`}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Non-retryable or last attempt — throw
        const fullError = (err as AxiosError<any>)?.response?.data?.error;
        const errorMsg = fullError?.message ?? err.message;
        const errorSubcode = fullError?.error_subcode;
        // No response body means no Meta `error` object to dump — fall back to
        // the transport failure, otherwise this logs a bare empty string and
        // the operator learns nothing about why the call died.
        const errorDetail = fullError
          ? JSON.stringify(fullError)
          : `${method} ${url.replace(/access_token=[^&]+/, 'access_token=***')} failed with no response (${errCode || 'no code'}: ${err.message})`;
        this.logger.error(`Meta API full error: ${errorDetail}`);
        throw new Error(
          `Meta API error: ${errorMsg} (code: ${metaErrorCode ?? 'unknown'}, subcode: ${errorSubcode ?? 'none'})`,
        );
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private mapConversionEvent(event: string): string {
    const mapping: Record<string, string> = {
      Purchase: 'PURCHASE',
      Lead: 'LEAD',
      CompleteRegistration: 'COMPLETE_REGISTRATION',
      Subscribe: 'SUBSCRIBE',
      AddToCart: 'ADD_TO_CART',
      InitiateCheckout: 'INITIATE_CHECKOUT',
      ViewContent: 'VIEW_CONTENT',
    };
    return mapping[event] ?? 'OTHER';
  }

  private mapCta(ctaText: string): string {
    const lower = ctaText.toLowerCase();
    if (
      lower.includes('buy') ||
      lower.includes('shop') ||
      lower.includes('karo')
    )
      return 'SHOP_NOW';
    if (lower.includes('learn') || lower.includes('jaano')) return 'LEARN_MORE';
    if (lower.includes('sign') || lower.includes('register')) return 'SIGN_UP';
    if (lower.includes('book') || lower.includes('consult'))
      return 'BOOK_TRAVEL';
    if (lower.includes('download') || lower.includes('install'))
      return 'INSTALL_MOBILE_APP';
    if (lower.includes('order')) return 'SHOP_NOW';
    return 'SHOP_NOW';
  }
}
