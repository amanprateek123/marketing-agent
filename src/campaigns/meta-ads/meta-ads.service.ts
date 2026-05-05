import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { checkCopySafety, formatSafetyError } from '../../common/safety/copy-safety-checker.util';
import { withUtmParams } from './meta-utm.util';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// Meta error codes that are safe to retry
const RETRYABLE_ERROR_CODES = [2, 17, 341, 368];
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

export interface MetaLaunchResult {
  campaignId: string;
  adSets: {
    adSetId: string;
    name: string;
    ads: {
      adId: string;
      creativeId: string;
      copyVariantIndex: number;
      format: 'video' | 'image';   // populated at launch — required to measure mixed-format ad sets
    }[];
  }[];
}

export interface MetaAdSetConfig {
  name: string;
  budgetPercent: number;
  audienceType: string;
  creativeFormat?: 'video' | 'image' | 'both' | 'mixed';
  // 'mixed' = the selected variant ships as a video ad, all OTHER variants in adSet.ads
  // ship as image ads. Lets a single ad set test 1 video + N images side-by-side
  // (Meta-recommended creative diversity within one optimization bucket) without
  // duplicating the same video across N copy variants the way 'both' does.
  metaAudienceId?: string;
  excludeAudienceIds?: string[];
  ageMin?: number;
  ageMax?: number;
  gender?: string;
  geoLocations?: string[];   // ISO country codes (e.g. ['IN'])
  geoStates?: string[];      // Meta region keys (e.g. ['480'] for Maharashtra)
  geoCities?: string[];      // Meta city keys (e.g. ['2295411'] for Mumbai)
  interests?: string[];      // Meta interest IDs from the interest catalog (NOT names — names are rejected by API)
  optimizationGoal: string;
  ads: number[];
}

export interface MetaCampaignConfig {
  accountId: string;
  accessToken: string;
  pageId?: string;
  pixelId?: string;
  campaignName: string;
  budget: number;                   // in INR (full rupees, not paise)
  objective: string;
  conversionEvent: string;
  customEventName?: string;      // used when conversionEvent === 'CustomEvent'
  customConversionId?: string;   // Meta Custom Conversion ID — takes priority over conversionEvent
  adSets: MetaAdSetConfig[];
  copyVariants: { primaryText: string; headline: string; cta: string }[];
  imageHashes?: Record<number, string>; // per-variant image hashes (variantIndex → hash)
  videoThumbnailHash?: string;          // thumbnail extracted from video (used only in video ads)
  videoId?: string;                     // Meta video ID (uploaded before launch)
  selectedCopyIndex?: number;           // which copy variant the video matches (for 'mixed' format)
  landingUrl: string;
  declaredSpecialAdCategories?: string[];  // for safety check on regulated copy
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
      this.logger.log(`Downloading image for base64 upload: ${imageUrl.slice(0, 80)}...`);
      const imgResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
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

    this.logger.log(`Video uploaded: videoId=${videoId} — waiting for Meta processing`);

    // Poll until Meta finishes processing the video (async on their side)
    const deadline = Date.now() + 3 * 60 * 1000; // 3 min max
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await this.metaApiCall(
        'GET',
        `${META_API_BASE}/${videoId}?fields=status&access_token=${accessToken}`,
        {},
      );
      const status = statusRes.data?.status?.processing_progress ?? statusRes.data?.status;
      this.logger.log(`Meta video processing: videoId=${videoId} status=${JSON.stringify(status)}`);
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
    this.logger.warn(`Meta video processing timeout — proceeding anyway: videoId=${videoId}`);
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
      const preferred = thumbnails.find((t: any) => t.is_preferred) ?? thumbnails[0];
      const thumbUrl = preferred?.uri;
      if (!thumbUrl) return undefined;

      // Upload the thumbnail URL as an image to Meta and get the hash
      const imgResponse = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 30000 });
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
    for (let i = 0; i < config.copyVariants.length; i++) {
      const v = config.copyVariants[i];
      const safety = checkCopySafety({
        primaryText: v.primaryText,
        headline: v.headline,
        cta: v.cta,
        declaredSpecialAdCategories: config.declaredSpecialAdCategories,
      });
      if (!safety.safe) {
        const errorMsg = `${formatSafetyError(safety)}\n(failed on copyVariant index ${i} of campaign "${config.campaignName}")`;
        this.logger.error(`Refusing to launch campaign — ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }

    const created: CreatedObjects = {
      campaignId: null,
      adSetIds: [],
      creativeIds: [],
      adIds: [],
    };

    const expectedAdCount = config.adSets.reduce((sum, as) => sum + as.ads.length, 0);

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
        );
        created.adSetIds.push(adSetId);

        // Create ads (one per copy variant)
        const adResults: MetaLaunchResult['adSets'][0]['ads'] = [];
        const creativeFormat = adSetConfig.creativeFormat ?? 'image';
        const selectedCopyIndex = config.selectedCopyIndex ?? 0;

        const buildLandingUrl = (adName: string) => withUtmParams(config.landingUrl, {
          campaignName: config.campaignName,
          adSetName: adSetConfig.name,
          adName,
        });

        for (const variantIndex of adSetConfig.ads) {
          const variant = config.copyVariants[variantIndex];
          if (!variant) continue;

          // hookStyle in ad name for Meta UI clarity + downstream attribution by name
          const hookStyle = (variant as any).hookStyle ? ` (${(variant as any).hookStyle})` : '';
          const adName = `${adSetConfig.name} — Variant ${variantIndex + 1}${hookStyle}`;

          // Resolve per-variant image hash
          const variantImageHash = config.imageHashes?.[variantIndex];

          // 'mixed': only the selected variant gets video; rest get image ads
          //   -> single video ad (matched to its hookStyle) competes with N image ads in one bucket
          //   -> Meta optimizes across both formats inside the same ad set
          if (creativeFormat === 'mixed') {
            const isSelected = variantIndex === selectedCopyIndex;
            if (isSelected && config.videoId) {
              const videoAdName = `${adName} (video)`;
              const { adId, creativeId } = await this.createVideoAd(
                config.accountId,
                config.accessToken,
                adSetId,
                videoAdName,
                variant,
                config.videoId,
                config.pageId!,
                buildLandingUrl(videoAdName),
                config.videoThumbnailHash ?? variantImageHash,
              );
              created.creativeIds.push(creativeId);
              created.adIds.push(adId);
              adResults.push({ adId, creativeId, copyVariantIndex: variantIndex, format: 'video' });
            } else if (variantImageHash) {
              const { adId, creativeId } = await this.createAd(
                config.accountId,
                config.accessToken,
                adSetId,
                adName,
                variant,
                variantImageHash,
                config.pageId ?? '',
                buildLandingUrl(adName),
              );
              created.creativeIds.push(creativeId);
              created.adIds.push(adId);
              adResults.push({ adId, creativeId, copyVariantIndex: variantIndex, format: 'image' });
            }
            continue;
          }

          // video-only or both → create video ad if videoId available
          if ((creativeFormat === 'video' || creativeFormat === 'both') && config.videoId) {
            const videoAdName = `${adName} (video)`;
            const { adId, creativeId } = await this.createVideoAd(
              config.accountId,
              config.accessToken,
              adSetId,
              videoAdName,
              variant,
              config.videoId,
              config.pageId!,
              buildLandingUrl(videoAdName),
              config.videoThumbnailHash ?? variantImageHash, // thumbnail for video ads only
            );
            created.creativeIds.push(creativeId);
            created.adIds.push(adId);
            adResults.push({ adId, creativeId, copyVariantIndex: variantIndex, format: 'video' });
          }

          // image-only or both → create image ad using variant-specific hash
          if ((creativeFormat === 'image' || creativeFormat === 'both') && variantImageHash) {
            const adName2 = creativeFormat === 'both' ? `${adName} (image)` : adName;
            const { adId, creativeId } = await this.createAd(
              config.accountId,
              config.accessToken,
              adSetId,
              adName2,
              variant,
              variantImageHash,
              config.pageId ?? '',
              buildLandingUrl(adName2),
            );
            created.creativeIds.push(creativeId);
            created.adIds.push(adId);
            adResults.push({ adId, creativeId, copyVariantIndex: variantIndex, format: 'image' });
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
      this.logger.error(`Campaign launch failed — rolling back: ${err.message}`);
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
    await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${campaignId}`,
      { status: 'ACTIVE', access_token: accessToken },
    );
    this.logger.log(`Campaign activated: ${campaignId}`);

    // Activate all ad sets
    for (const adSet of launchResult.adSets) {
      await this.metaApiCall(
        'POST',
        `${META_API_BASE}/${adSet.adSetId}`,
        { status: 'ACTIVE', access_token: accessToken },
      );
      this.logger.log(`Ad set activated: ${adSet.adSetId} (${adSet.name})`);

      // Activate all ads within each ad set
      for (const ad of adSet.ads) {
        await this.metaApiCall(
          'POST',
          `${META_API_BASE}/${ad.adId}`,
          { status: 'ACTIVE', access_token: accessToken },
        );
        this.logger.log(`Ad activated: ${ad.adId}`);
      }
    }
  }

  // ─── Private: Meta API methods ──────────────────────────────────────────────

  private async createCampaign(
    accountId: string,
    accessToken: string,
    name: string,
    objective: string,
    specialAdCategories: string[],
  ): Promise<string> {
    this.logger.log(`Creating campaign: ${name}${specialAdCategories.length ? ` | special_ad_categories: ${specialAdCategories.join(',')}` : ''}`);

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
  ): Promise<string> {
    // ABO: budget at ad set level for testing new creatives/audiences
    const dailyBudgetPaise = Math.round((totalBudget * config.budgetPercent / 100) * 100);

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
      geoLocations.cities = config.geoCities!.map((key) => ({ key, radius: 25, distance_unit: 'kilometer' }));
    }
    if (!hasStates && !hasCities) {
      geoLocations.countries = config.geoLocations ?? ['IN'];
    }
    const targeting: any = { geo_locations: geoLocations };

    // Audience type specific targeting
    if (['lookalike', 'retarget', 'custom'].includes(config.audienceType) && config.metaAudienceId) {
      targeting.custom_audiences = [{ id: config.metaAudienceId }];
      targeting.targeting_automation = { advantage_audience: 0 };
      if (config.ageMin) targeting.age_min = config.ageMin;
      if (config.ageMax) targeting.age_max = config.ageMax;
      if (config.gender === 'male') targeting.genders = [1];
      else if (config.gender === 'female') targeting.genders = [2];
    } else if (config.audienceType === 'advantage_plus') {
      // Meta requires age_max >= 65 for Advantage+ — omit age/gender constraints entirely
      targeting.targeting_automation = { advantage_audience: 1 };
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
      targeting.flexible_spec = [{
        interests: config.interests.map((id) => ({ id, name: id })),
      }];
    }

    // Exclude audiences (past buyers)
    if (config.excludeAudienceIds && config.excludeAudienceIds.length > 0) {
      targeting.excluded_custom_audiences = config.excludeAudienceIds.map(id => ({ id }));
    }

    // Skip Audience Network by default — for Indian DTC, AN is mostly garbage
    // app-install clicks. 5-15% of budget historically burned there before the
    // auditor caught it. Meta's `narrowAdSetPlacements` helper can still expand
    // back to AN later if data warrants. Override only if config explicitly sets
    // publisher_platforms (some retargeting flows do want AN).
    if (!(config as any).publisherPlatforms) {
      targeting.publisher_platforms = ['facebook', 'instagram'];
      // When publisher_platforms is set, Meta requires explicit positions per platform
      // 'video_feeds' was deprecated in v21.0 (subcode 2490562). Reels-style
      // surface lives under 'facebook_reels' now.
      targeting.facebook_positions = ['feed', 'facebook_reels', 'story', 'instream_video', 'marketplace'];
      targeting.instagram_positions = ['stream', 'story', 'reels', 'explore'];
    } else {
      targeting.publisher_platforms = (config as any).publisherPlatforms;
    }

    const adSetData: any = {
      name: config.name,
      campaign_id: campaignId,
      daily_budget: dailyBudgetPaise,
      billing_event: 'IMPRESSIONS',
      optimization_goal: config.optimizationGoal || 'OFFSITE_CONVERSIONS',
      destination_type: 'WEBSITE',
      // Pin bid strategy at ad set level (we run ABO — campaign-level
      // bid_strategy is rejected without CBO budget). LOWEST_COST_WITHOUT_CAP
      // = Meta auto-bids to spend the full daily budget at the lowest CPA,
      // no bid_amount required. Switch to COST_CAP (with bid_amount) once a
      // CPA target is validated by data.
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting,
      status: 'PAUSED',
      access_token: accessToken,
    };

    // Attribution: 7-day click + 1-day view — view-through captures 15-25% more
    // attributed conversions for video-heavy creative. Click-only under-counts
    // video performance and biases the audit loop's format-comparison toward image.
    adSetData.attribution_spec = [
      { event_type: 'CLICK_THROUGH', window_days: 7 },
      { event_type: 'VIEW_THROUGH', window_days: 1 },
    ];

    // Pixel for conversion optimization
    if (customConversionId) {
      // Custom Conversion — custom_conversion_id alone is sufficient.
      // Sending pixel_id alongside triggers subcode 1885014 ("invalid
      // combination of parameters") because Meta derives the pixel from
      // the custom conversion internally.
      adSetData.promoted_object = {
        custom_conversion_id: customConversionId,
      };
    } else if (pixelId && conversionEvent) {
      // Standard or custom event
      adSetData.promoted_object = {
        pixel_id: pixelId,
        custom_event_type: this.mapConversionEvent(conversionEvent),
      };
      // Custom events need custom_event_str with the actual event name
      if (conversionEvent === 'CustomEvent') {
        adSetData.promoted_object.custom_event_str = customEventName ?? conversionEvent;
      } else if (!['Purchase', 'Lead', 'CompleteRegistration', 'Subscribe'].includes(conversionEvent)) {
        adSetData.promoted_object.custom_event_str = conversionEvent;
      }
    }

    this.logger.log(`Creating ad set: ${config.name} | payload: ${JSON.stringify({ ...adSetData, access_token: '[REDACTED]' })}`);

    try {
      const response = await this.metaApiCall(
        'POST',
        `${META_API_BASE}/${accountId}/adsets`,
        adSetData,
      );

      const adSetId = response.data?.id;
      if (!adSetId) throw new Error(`No ad set ID in response for ${config.name}`);

      this.logger.log(`Ad set created: ${adSetId}`);
      return adSetId;
    } catch (err: any) {
      // Custom audience expired/deleted — retry as advantage_plus
      // Catch audience errors — Meta returns "Invalid parameter" with error_subcode 1359207 for expired audiences
      // We only retry if we actually set custom_audiences in targeting
      const hasAnyAudiences = targeting.custom_audiences || targeting.excluded_custom_audiences;
      // Match on Meta error subcode 1359207 (expired audience) or code 100 with audiences present
      const isAudienceError = hasAnyAudiences && (
        err.message?.includes('subcode: 1359207') ||
        err.message?.includes('subcode: 3858504') ||
        (err.message?.includes('code: 100') && err.message?.includes('Invalid parameter'))
      );
      if (isAudienceError) {
        this.logger.warn(`Audience unavailable for "${config.name}" (custom: ${config.metaAudienceId ?? 'none'}, excludes: ${config.excludeAudienceIds?.join(',') ?? 'none'}) — retrying without audiences.`);
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
        if (!adSetId) throw new Error(`No ad set ID in retry response for ${config.name}`);
        this.logger.log(`Ad set created (advantage_plus fallback): ${adSetId}`);
        return adSetId;
      }
      throw err;
    }
  }

  private async createAd(
    accountId: string,
    accessToken: string,
    adSetId: string,
    adName: string,
    copy: { primaryText: string; headline: string; cta: string },
    imageHash: string | undefined,
    pageId: string,
    landingUrl: string,
  ): Promise<{ adId: string; creativeId: string }> {
    // Step 1: Create ad creative
    const creativeData: any = {
      name: `Creative — ${adName}`,
      object_story_spec: {
        page_id: pageId,
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

    if (imageHash) {
      creativeData.object_story_spec.link_data.image_hash = imageHash;
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
      throw new Error(`No ad ID for ${adName} (dangling creative: ${creativeId})`);
    }

    this.logger.log(`Ad created: ${adId} (${adName})`);
    return { adId, creativeId };
  }

  private async createVideoAd(
    accountId: string,
    accessToken: string,
    adSetId: string,
    adName: string,
    copy: { primaryText: string; headline: string; cta: string },
    videoId: string,
    pageId: string,
    landingUrl: string,
    imageHash?: string,
  ): Promise<{ adId: string; creativeId: string }> {
    const videoData: any = {
      video_id: videoId,
      message: copy.primaryText,
      call_to_action: {
        type: this.mapCta(copy.cta),
        value: { link: landingUrl },
      },
      title: copy.headline,
    };

    // Thumbnail is required by Meta for video ads
    if (imageHash) {
      videoData.image_hash = imageHash;
    }

    const creativeData: any = {
      name: `Creative — ${adName}`,
      object_story_spec: {
        page_id: pageId,
        video_data: videoData,
      },
      access_token: accessToken,
    };

    this.logger.log(`Creating video creative: ${JSON.stringify({ ...creativeData, access_token: '[REDACTED]' })}`);

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
    if (!adId) throw new Error(`No ad ID for video ad ${adName} (dangling creative: ${creativeId})`);

    this.logger.log(`Video ad created: ${adId} (${adName})`);
    return { adId, creativeId };
  }

  // ─── Rollback: clean up on partial failure ──────────────────────────────────

  private async rollback(created: CreatedObjects, accessToken: string): Promise<void> {
    // Deleting the campaign cascades to all child ad sets and ads
    if (created.campaignId) {
      try {
        await axios.delete(
          `${META_API_BASE}/${created.campaignId}`,
          { params: { access_token: accessToken }, timeout: 15000 },
        );
        this.logger.log(`Rollback: deleted campaign ${created.campaignId} (cascades to ad sets + ads)`);
      } catch (err: any) {
        this.logger.error(`Rollback failed for campaign ${created.campaignId}: ${err.message}`);
      }
    }

    // Clean up any dangling creatives that weren't attached to ads
    for (const creativeId of created.creativeIds) {
      try {
        await axios.delete(
          `${META_API_BASE}/${creativeId}`,
          { params: { access_token: accessToken }, timeout: 10000 },
        );
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
    const response = await this.metaApiCall('POST', `${META_API_BASE}/${accountId}/customaudiences`, {
      name,
      retention_days: rule.retentionDays,
      rule: JSON.stringify({
        inclusions: {
          operator: 'or',
          rules: [{
            event_sources: [{ id: pixelId, type: 'pixel' }],
            retention_seconds: rule.retentionDays * 86400,
            filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: rule.event }] },
          }],
        },
      }),
      access_token: accessToken,
    });
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
    ratio: number,  // 0.01 = 1%, 0.02 = 2%
  ): Promise<string> {
    const response = await this.metaApiCall('POST', `${META_API_BASE}/${accountId}/customaudiences`, {
      name,
      subtype: 'LOOKALIKE',
      origin_audience_id: sourceAudienceId,
      lookalike_spec: { country, ratio },
      access_token: accessToken,
    });
    const id = response.data?.id;
    if (!id) throw new Error(`Failed to create lookalike "${name}"`);
    this.logger.log(`Lookalike audience created: ${name} (${id})`);
    return id;
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
   * Create a new ad set in an existing campaign (used by auditor for retarget/narrowed ad sets).
   */
  async createAdSetInCampaign(
    campaignId: string,
    accessToken: string,
    config: MetaAdSetConfig,
    totalBudget: number,
    conversionEvent: string,
    pixelId?: string,
  ): Promise<string> {
    // Need accountId from campaign — fetch it
    const campaignRes = await this.metaApiCall('GET', `${META_API_BASE}/${campaignId}`, {
      fields: 'account_id',
      access_token: accessToken,
    });
    const accountId = `act_${campaignRes.data?.account_id}`;

    return this.createAdSet(
      accountId,
      accessToken,
      campaignId,
      config,
      totalBudget,
      conversionEvent,
      pixelId,
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
    const adSetRes = await this.metaApiCall('GET', `${META_API_BASE}/${adSetId}`, {
      fields: 'account_id',
      access_token: accessToken,
    });
    const accountId = `act_${adSetRes.data?.account_id}`;

    // Upload image
    const imageHash = await this.uploadImage(imageUrl, accountId, accessToken);

    // Create ad + creative
    const result = await this.createAd(accountId, accessToken, adSetId, adName, copy, imageHash, pageId, landingUrl);

    // Activate the ad
    await this.updateAdStatus(result.adId, 'ACTIVE', accessToken);

    return result;
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
    this.logger.log(`Ad set budget updated: ${adSetId} → ₹${newDailyBudgetINR}/day`);
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
  async updateAdSetPlacements(
    adSetId: string,
    placements: {
      publisherPlatforms: string[];                    // e.g. ['facebook', 'instagram']
      facebookPositions?: string[];                    // e.g. ['feed', 'video_feeds']
      instagramPositions?: string[];                   // e.g. ['stream', 'reels']
      audienceNetworkPositions?: string[];
      messengerPositions?: string[];
    },
    accessToken: string,
  ): Promise<void> {
    if (!placements.publisherPlatforms?.length) {
      throw new Error('updateAdSetPlacements: publisherPlatforms must be non-empty');
    }

    // Fetch current targeting so we don't blow away age/geo/audience.
    const existing = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${adSetId}`,
      { fields: 'targeting', access_token: accessToken },
    );
    const currentTargeting: Record<string, any> = (existing?.data?.targeting ?? existing?.targeting ?? {}) as any;

    // Deep-clone existing, then overlay placement subfields. Remove position fields
    // that are no longer relevant (e.g. dropping audience_network from publisher_platforms
    // means audience_network_positions must also go, otherwise Meta rejects the call).
    const merged: Record<string, any> = JSON.parse(JSON.stringify(currentTargeting));
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
    if (placements.facebookPositions) merged.facebook_positions = placements.facebookPositions;
    if (placements.instagramPositions) merged.instagram_positions = placements.instagramPositions;
    if (placements.audienceNetworkPositions) merged.audience_network_positions = placements.audienceNetworkPositions;
    if (placements.messengerPositions) merged.messenger_positions = placements.messengerPositions;

    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      targeting: merged,
      access_token: accessToken,
    });
    this.logger.log(`Ad set placements updated (merged into existing targeting): ${adSetId} → ${placements.publisherPlatforms.join(',')}`);
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
      throw new Error('updateAdSetSchedule: schedule must have at least one slot (use empty pacing_type to clear)');
    }
    for (const slot of schedule) {
      if (slot.startMinute < 0 || slot.startMinute > 1440 || slot.endMinute < 0 || slot.endMinute > 1440) {
        throw new Error(`updateAdSetSchedule: minutes must be 0-1440 (got ${slot.startMinute}-${slot.endMinute})`);
      }
      if (slot.endMinute <= slot.startMinute) {
        throw new Error(`updateAdSetSchedule: endMinute must be > startMinute (slot ${slot.startMinute}-${slot.endMinute})`);
      }
      if (!slot.days.every(d => d >= 0 && d <= 6)) {
        throw new Error(`updateAdSetSchedule: days must be 0-6 (got ${slot.days})`);
      }
    }

    const adset_schedule = schedule.map(s => ({
      start_minute: s.startMinute,
      end_minute: s.endMinute,
      days: s.days,
    }));

    await this.metaApiCall('POST', `${META_API_BASE}/${adSetId}`, {
      adset_schedule,
      pacing_type: ['day_parting'],   // REQUIRED — Meta silently ignores adset_schedule without this
      access_token: accessToken,
    });
    this.logger.log(`Ad set schedule updated: ${adSetId} → ${schedule.length} slot(s)`);
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
      newAudienceId?: string;        // existing Meta custom/lookalike audience to use
      useAdvantagePlus?: boolean;    // alternative: switch to Advantage+ Audience
    },
  ): Promise<{ newAdSetId: string }> {
    if (!newAudience.newAudienceId && !newAudience.useAdvantagePlus) {
      throw new Error('refresh_audience: must provide newAudienceId OR useAdvantagePlus=true');
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
    const newAdSetId = copyRes?.data?.copied_adset_id ?? copyRes?.data?.ad_object_ids?.[0];
    if (!newAdSetId) {
      throw new Error('refresh_audience: Meta /copies did not return a new adset id');
    }

    // 2) Read existing targeting on the new copy and merge audience changes (read-modify-write
    //    so we don't blow away age/geo/excluded audiences — same pattern as updateAdSetPlacements).
    const existing = await this.metaApiCall(
      'GET',
      `${META_API_BASE}/${newAdSetId}`,
      { fields: 'targeting', access_token: accessToken },
    );
    const targeting: Record<string, any> = JSON.parse(JSON.stringify(existing?.data?.targeting ?? {}));

    if (newAudience.useAdvantagePlus) {
      // Switch to Advantage+ Audience: clear custom audiences, enable advantage_audience flag
      delete targeting.custom_audiences;
      targeting.targeting_automation = { ...(targeting.targeting_automation ?? {}), advantage_audience: 1 };
    } else if (newAudience.newAudienceId) {
      targeting.custom_audiences = [{ id: newAudience.newAudienceId }];
      // Clear conflicting Advantage+ flag if it was set
      if (targeting.targeting_automation) {
        targeting.targeting_automation = { ...targeting.targeting_automation, advantage_audience: 0 };
      }
    }

    await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${newAdSetId}`,
      { targeting, access_token: accessToken },
    );

    // 3) Activate the new ad set
    await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${newAdSetId}`,
      { status: 'ACTIVE', access_token: accessToken },
    );

    this.logger.log(
      `refresh_audience: duplicated ${sourceAdSetId} → ${newAdSetId} with ${newAudience.useAdvantagePlus ? 'advantage_plus' : `audience ${newAudience.newAudienceId}`}`,
    );
    return { newAdSetId };
  }

  /**
   * Get the ad account's configured timezone (e.g. "Asia/Kolkata", "America/Los_Angeles").
   * Used to gate dayparting — schedules are interpreted in this TZ, not UTC.
   */
  async getAdAccountTimezone(accountId: string, accessToken: string): Promise<string | null> {
    const acctRef = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    try {
      const res = await this.metaApiCall('GET', `${META_API_BASE}/${acctRef}`, {
        fields: 'timezone_name',
        access_token: accessToken,
      });
      return res?.data?.timezone_name ?? null;
    } catch (err: any) {
      this.logger.warn(`getAdAccountTimezone failed for ${accountId}: ${err.message}`);
      return null;
    }
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
        const metaErrorCode = (err as AxiosError)?.response?.data
          ? (err as AxiosError<any>).response!.data.error?.code
          : undefined;
        const isRetryable = RETRYABLE_ERROR_CODES.includes(metaErrorCode);
        const isLastAttempt = attempt === MAX_RETRIES;

        if (isRetryable && !isLastAttempt) {
          const delay = RETRY_DELAYS[attempt - 1] ?? 4000;
          this.logger.warn(
            `Meta API error (code ${metaErrorCode}), retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        // Non-retryable or last attempt — throw
        const fullError = (err as AxiosError<any>)?.response?.data?.error;
        const errorMsg = fullError?.message ?? err.message;
        const errorSubcode = fullError?.error_subcode;
        const errorDetail = fullError ? JSON.stringify(fullError) : '';
        this.logger.error(`Meta API full error: ${errorDetail}`);
        throw new Error(`Meta API error: ${errorMsg} (code: ${metaErrorCode ?? 'unknown'}, subcode: ${errorSubcode ?? 'none'})`);
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private mapConversionEvent(event: string): string {
    const mapping: Record<string, string> = {
      'Purchase': 'PURCHASE',
      'Lead': 'LEAD',
      'CompleteRegistration': 'COMPLETE_REGISTRATION',
      'Subscribe': 'SUBSCRIBE',
      'AddToCart': 'ADD_TO_CART',
      'InitiateCheckout': 'INITIATE_CHECKOUT',
      'ViewContent': 'VIEW_CONTENT',
    };
    return mapping[event] ?? 'OTHER';
  }

  private mapCta(ctaText: string): string {
    const lower = ctaText.toLowerCase();
    if (lower.includes('buy') || lower.includes('shop') || lower.includes('karo')) return 'SHOP_NOW';
    if (lower.includes('learn') || lower.includes('jaano')) return 'LEARN_MORE';
    if (lower.includes('sign') || lower.includes('register')) return 'SIGN_UP';
    if (lower.includes('book') || lower.includes('consult')) return 'BOOK_TRAVEL';
    if (lower.includes('download') || lower.includes('install')) return 'INSTALL_MOBILE_APP';
    if (lower.includes('order')) return 'SHOP_NOW';
    return 'SHOP_NOW';
  }
}
