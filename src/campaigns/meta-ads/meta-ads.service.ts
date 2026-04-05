import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

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
    }[];
  }[];
}

export interface MetaAdSetConfig {
  name: string;
  budgetPercent: number;
  audienceType: string;
  metaAudienceId?: string;
  excludeAudienceIds?: string[];
  ageMin?: number;
  ageMax?: number;
  gender?: string;
  geoLocations?: string[];
  interests?: string[];
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
  adSets: MetaAdSetConfig[];
  copyVariants: { primaryText: string; headline: string; cta: string }[];
  imageHash?: string;
  landingUrl: string;
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

    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/adimages`,
      { url: imageUrl, access_token: accessToken },
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
   * Full launch: campaign → ad sets → ads.
   * Everything starts PAUSED. Call activateCampaign() to go live.
   * On partial failure, rolls back all created objects.
   */
  async launchCampaign(config: MetaCampaignConfig): Promise<MetaLaunchResult> {
    this.logger.log(
      `Launching campaign: ${config.campaignName} | budget: ₹${config.budget} | adSets: ${config.adSets.length}`,
    );

    const created: CreatedObjects = {
      campaignId: null,
      adSetIds: [],
      creativeIds: [],
      adIds: [],
    };

    const expectedAdCount = config.adSets.reduce((sum, as) => sum + as.ads.length, 0);

    try {
      // Step 1: Create campaign (PAUSED)
      created.campaignId = await this.createCampaign(
        config.accountId,
        config.accessToken,
        config.campaignName,
        config.objective,
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
        );
        created.adSetIds.push(adSetId);

        // Create ads (one per copy variant)
        const adResults: MetaLaunchResult['adSets'][0]['ads'] = [];

        for (const variantIndex of adSetConfig.ads) {
          const variant = config.copyVariants[variantIndex];
          if (!variant) continue;

          const adName = `${adSetConfig.name} — Variant ${variantIndex + 1}`;
          const { adId, creativeId } = await this.createAd(
            config.accountId,
            config.accessToken,
            adSetId,
            adName,
            variant,
            config.imageHash,
            config.pageId ?? '',
            config.landingUrl,
          );
          created.creativeIds.push(creativeId);
          created.adIds.push(adId);

          adResults.push({ adId, creativeId, copyVariantIndex: variantIndex });
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
  async activateCampaign(campaignId: string, accessToken: string): Promise<void> {
    await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${campaignId}`,
      { status: 'ACTIVE', access_token: accessToken },
    );
    this.logger.log(`Campaign activated: ${campaignId}`);
  }

  // ─── Private: Meta API methods ──────────────────────────────────────────────

  private async createCampaign(
    accountId: string,
    accessToken: string,
    name: string,
    objective: string,
  ): Promise<string> {
    this.logger.log(`Creating campaign: ${name}`);

    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/campaigns`,
      {
        name,
        objective,
        status: 'PAUSED',
        special_ad_categories: [],
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
  ): Promise<string> {
    // Budget: INR rupees → paise (Meta expects smallest currency unit)
    const dailyBudgetPaise = Math.round((totalBudget * config.budgetPercent / 100) * 100);

    const targeting: any = {
      geo_locations: {
        countries: config.geoLocations ?? ['IN'],
        location_types: ['home', 'recent'],
      },
    };

    if (config.ageMin) targeting.age_min = config.ageMin;
    if (config.ageMax) targeting.age_max = config.ageMax;
    if (config.gender === 'male') targeting.genders = [1];
    else if (config.gender === 'female') targeting.genders = [2];

    // Audience type specific targeting
    if (['lookalike', 'retarget', 'custom'].includes(config.audienceType) && config.metaAudienceId) {
      targeting.custom_audiences = [{ id: config.metaAudienceId }];
    } else if (config.audienceType === 'advantage_plus') {
      targeting.targeting_automation = { advantage_audience: 1 };
    }

    // Interest targeting
    if (config.interests && config.interests.length > 0) {
      targeting.flexible_spec = [{
        interests: config.interests.map(i => ({ name: i })),
      }];
    }

    // Exclude audiences (past buyers)
    if (config.excludeAudienceIds && config.excludeAudienceIds.length > 0) {
      targeting.excluded_custom_audiences = config.excludeAudienceIds.map(id => ({ id }));
    }

    const adSetData: any = {
      name: config.name,
      campaign_id: campaignId,
      daily_budget: dailyBudgetPaise,
      billing_event: 'IMPRESSIONS',
      optimization_goal: config.optimizationGoal || 'OFFSITE_CONVERSIONS',
      destination_type: 'WEBSITE',
      targeting,
      status: 'PAUSED',
      access_token: accessToken,
    };

    // Pixel for conversion optimization
    if (pixelId && conversionEvent) {
      adSetData.promoted_object = {
        pixel_id: pixelId,
        custom_event_type: this.mapConversionEvent(conversionEvent),
      };
      // Custom events need custom_event_str
      if (!['Purchase', 'Lead', 'CompleteRegistration', 'Subscribe'].includes(conversionEvent)) {
        adSetData.promoted_object.custom_event_str = conversionEvent;
      }
    }

    this.logger.log(`Creating ad set: ${config.name} | daily budget: ₹${totalBudget * config.budgetPercent / 100}`);

    const response = await this.metaApiCall(
      'POST',
      `${META_API_BASE}/${accountId}/adsets`,
      adSetData,
    );

    const adSetId = response.data?.id;
    if (!adSetId) throw new Error(`No ad set ID in response for ${config.name}`);

    this.logger.log(`Ad set created: ${adSetId}`);
    return adSetId;
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
        const errorMsg = (err as AxiosError<any>)?.response?.data?.error?.message ?? err.message;
        throw new Error(`Meta API error: ${errorMsg} (code: ${metaErrorCode ?? 'unknown'})`);
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
    return 'LEARN_MORE';
  }
}
