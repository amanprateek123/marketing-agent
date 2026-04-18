import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { extractConversions } from './conversion-extractor.util';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

const META_TO_INTERNAL_STATUS: Record<string, string> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'completed',
  COMPLETED: 'completed',
  DELETED: 'completed',
  CAMPAIGN_PAUSED: 'paused',
  PENDING_REVIEW: 'pending_approval',
  DISAPPROVED: 'failed',
};

/**
 * CampaignSyncService — two-way sync between Meta and our campaigns collection.
 *
 * - Campaigns launched by our agent: source='agent', already in DB, gets metrics updated
 * - Campaigns created manually by tenant: source='manual', upserted from Meta data
 *
 * Called from:
 * 1. finalizeImport() — sync all 1yr historical campaigns after learning import
 * 2. Cron every 6h — sync only ACTIVE/PAUSED campaigns for real-time metrics
 */
@Injectable()
export class CampaignSyncService {
  private readonly logger = new Logger(CampaignSyncService.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  /**
   * Sync a list of enriched campaigns (already fetched during learning import).
   * Reuses data we already have — no extra Meta API calls.
   */
  async syncFromEnrichedData(
    tenantId: string,
    enrichedCampaigns: any[],
    conversionTypes: Set<string>,
  ): Promise<{ synced: number; created: number }> {
    let synced = 0;
    let created = 0;

    for (const campaign of enrichedCampaigns) {
      const insights = campaign.insights ?? {};
      const spend = parseFloat(insights.spend ?? '0');
      const impressions = parseInt(insights.impressions ?? '0', 10);
      const clicks = parseInt(insights.clicks ?? '0', 10);
      const ctr = parseFloat(insights.ctr ?? '0');
      const cpc = parseFloat(insights.cpc ?? '0');
      const conversions = this.extractConversions(insights.actions, conversionTypes);

      const metaStatus = campaign.status ?? 'PAUSED';
      const internalStatus = META_TO_INTERNAL_STATUS[metaStatus] ?? 'paused';

      // Build metaAdSets from enriched data
      const metaAdSets = this.buildMetaAdSets(campaign, conversionTypes);

      const roas = spend > 0 && conversions > 0 ? (conversions * 1) / spend : 0; // approximate

      const existing = await this.campaignModel.findOne({
        tenantId,
        metaCampaignId: campaign.id,
      }).exec();

      if (existing) {
        await this.campaignModel.updateOne(
          { _id: existing._id },
          {
            $set: {
              name: campaign.name ?? '',
              status: internalStatus,
              spend, impressions, clicks, conversions, roas, ctr, cpc,
              metaAdSets,
              syncedAt: new Date(),
            },
          },
        );
        synced++;
      } else {
        await this.campaignModel.create({
          tenantId,
          name: campaign.name ?? '',
          runId: '',
          briefId: '',
          source: 'manual',
          metaCampaignId: campaign.id,
          topic: '',
          angle: '',
          status: internalStatus,
          budget: parseFloat(campaign.daily_budget ?? campaign.lifetime_budget ?? '0') / 100,
          objective: campaign.objective ?? '',
          launchedAt: campaign.start_time ? new Date(campaign.start_time) : undefined,
          spend, impressions, clicks, conversions, roas, ctr, cpc,
          metaAdSets,
          syncedAt: new Date(),
        });
        created++;
      }
    }

    this.logger.log(`Sync complete: ${synced} updated, ${created} new manual campaigns for ${tenantId}`);
    return { synced, created };
  }

  /**
   * Sync only ACTIVE/PAUSED campaigns from Meta — for the 6h cron job.
   * Fast call — only fetches running campaigns with current metrics.
   */
  async syncActiveCampaigns(company: CompanyDocument): Promise<{ synced: number }> {
    const tenantId = company.tenantId;
    const { accessToken } = company.meta!;

    const normalizeAccountId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
    const accountIds = ((company.meta!.accountIds?.length ?? 0) > 0
      ? company.meta!.accountIds!
      : [company.meta!.accountId]
    ).map(normalizeAccountId);

    const conversionTypes = new Set<string>([
      'purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
      'offsite_conversion.fb_pixel_lead', 'complete_registration',
    ]);

    let totalSynced = 0;

    for (const accountId of accountIds) {
      try {
        // Fetch only active/paused campaigns with insights in one call
        const filtering = JSON.stringify([
          { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
        ]);

        const res = await axios.get(`${META_API_BASE}/${accountId}/campaigns`, {
          params: {
            fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time',
            filtering,
            limit: '200',
            access_token: accessToken,
          },
          timeout: 60000,
        });

        const campaigns: any[] = res.data?.data ?? [];

        // Fetch insights for these campaigns in one bulk call
        const campaignIds = campaigns.map(c => c.id);
        if (campaignIds.length === 0) continue;

        const insightsRes = await axios.get(`${META_API_BASE}/${accountId}/insights`, {
          params: {
            fields: 'campaign_id,spend,impressions,clicks,ctr,cpc,actions',
            level: 'campaign',
            date_preset: 'maximum',
            filtering: JSON.stringify([
              { field: 'campaign.id', operator: 'IN', value: campaignIds },
            ]),
            limit: '200',
            access_token: accessToken,
          },
          timeout: 60000,
        }).catch(() => ({ data: { data: [] } }));

        const insightsMap = new Map<string, any>();
        for (const row of insightsRes.data?.data ?? []) {
          insightsMap.set(row.campaign_id, row);
        }

        for (const campaign of campaigns) {
          const insights = insightsMap.get(campaign.id) ?? {};
          const spend = parseFloat(insights.spend ?? '0');
          const impressions = parseInt(insights.impressions ?? '0', 10);
          const clicks = parseInt(insights.clicks ?? '0', 10);
          const ctr = parseFloat(insights.ctr ?? '0');
          const cpc = parseFloat(insights.cpc ?? '0');
          const conversions = this.extractConversions(insights.actions, conversionTypes);
          const internalStatus = META_TO_INTERNAL_STATUS[campaign.status] ?? 'active';

          await this.campaignModel.updateOne(
            { tenantId, metaCampaignId: campaign.id },
            {
              $set: {
                name: campaign.name ?? '',
                status: internalStatus,
                spend, impressions, clicks, conversions, ctr, cpc,
                syncedAt: new Date(),
              },
              $setOnInsert: {
                tenantId,
                runId: '',
                briefId: '',
                source: 'manual',
                metaCampaignId: campaign.id,
                topic: '',
                angle: '',
                budget: parseFloat(campaign.daily_budget ?? campaign.lifetime_budget ?? '0') / 100,
                objective: campaign.objective ?? '',
                launchedAt: campaign.start_time ? new Date(campaign.start_time) : undefined,
              },
            },
            { upsert: true },
          );
          totalSynced++;
        }

        this.logger.log(`Active campaign sync: ${campaigns.length} campaigns from ${accountId}`);
      } catch (err: any) {
        this.logger.warn(`Active sync failed for ${accountId}: ${err.message}`);
      }
    }

    return { synced: totalSynced };
  }

  private buildMetaAdSets(campaign: any, conversionTypes: Set<string>): any[] {
    const adSets: any[] = campaign.adSets ?? [];
    const adSetInsights: any[] = campaign.adSetInsights ?? [];
    const adInsights: any[] = campaign.adInsights ?? [];
    const ads: any[] = campaign.ads ?? [];

    // Build raw adset lookup by ID for supplementary data (budget, optimization_goal)
    const rawAdSetById = new Map<string, any>();
    const rawAdSetByName = new Map<string, any>();
    for (const adSet of adSets) {
      if (adSet.id) rawAdSetById.set(String(adSet.id), adSet);
      if (adSet.name) rawAdSetByName.set(adSet.name, adSet);
    }

    // Iterate over adSetInsights as source of truth — only adsets with actual spend/activity
    return adSetInsights.map((insight: any) => {
      const adsetId = String(insight.adset_id ?? '');
      const adsetName = insight.adset_name ?? '';

      // Get supplementary data from raw adsets (budget, optimization_goal)
      const raw = rawAdSetById.get(adsetId) ?? rawAdSetByName.get(adsetName) ?? {};

      const spend = parseFloat(insight.spend ?? '0');
      const impressions = parseInt(insight.impressions ?? '0', 10);
      const clicks = parseInt(insight.clicks ?? '0', 10);
      const ctr = parseFloat(insight.ctr ?? '0');
      const frequency = parseFloat(insight.frequency ?? '0');
      const conversions = this.extractConversions(insight.actions, conversionTypes);
      const cpa = conversions > 0 ? spend / conversions : 0;
      const audienceType = this.inferAudienceType(adsetName);

      // Build ads for this adset — matched by adset_id
      const adSetAds = adInsights
        .filter((ad: any) => String(ad.adset_id) === adsetId)
        .map((ad: any) => {
          const creative = ads.find((a: any) => a.name === ad.ad_name);
          const format = this.inferFormatFromCreative(creative?.creative, ad.ad_name ?? '');
          const hookStyle = this.inferHookStyle(
            ad.ad_name ?? '',
            creative?.creative?.object_story_spec?.link_data?.message ?? creative?.creative?.object_story_spec?.video_data?.message ?? '',
            '',
          );
          return {
            id: ad.ad_id ?? '',
            name: ad.ad_name ?? '',
            hookStyle,
            format,
            spend: parseFloat(ad.spend ?? '0'),
            impressions: parseInt(ad.impressions ?? '0', 10),
            clicks: parseInt(ad.clicks ?? '0', 10),
            ctr: parseFloat(ad.ctr ?? '0'),
            cpc: parseFloat(ad.cpc ?? '0'),
          };
        });

      return {
        id: adsetId,
        name: adsetName,
        status: raw.status ?? '',
        audienceType,
        dailyBudget: parseFloat(raw.daily_budget ?? '0') / 100,
        lifetimeBudget: parseFloat(raw.lifetime_budget ?? '0') / 100,
        optimizationGoal: raw.optimization_goal ?? '',
        spend, impressions, clicks, conversions, ctr, cpa, frequency,
        ads: adSetAds,
      };
    });
  }

  private inferAudienceType(adSetName: string): string {
    const lower = adSetName.toLowerCase();
    if (lower.includes('lookalike') || lower.includes('lal') || lower.includes('lla')) return 'lookalike';
    if (lower.includes('advantage') || lower.includes('a+')) return 'advantage_plus';
    if (lower.includes('retarget') || lower.includes('remarket')) return 'retarget';
    if (lower.includes('interest') || lower.includes('inmarket')) return 'interest';
    if (lower.includes('broad')) return 'broad';
    if (lower.includes('performing')) return 'performing_export';
    if (lower.includes('custom')) return 'custom';
    return 'other';
  }

  private inferFormatFromCreative(creative: any, adName: string): string {
    if (creative?.object_story_spec?.video_data) return 'video';
    if (creative?.object_story_spec?.link_data?.child_attachments?.length > 0) return 'carousel';
    if (creative?.object_story_spec?.link_data) return 'image';
    const name = adName.toLowerCase();
    if (name.includes('reel')) return 'reel';
    if (name.includes('story') || name.includes('stories')) return 'story';
    if (name.includes('video')) return 'video';
    if (name.includes('carousel')) return 'carousel';
    return 'image';
  }

  private inferHookStyle(adName: string, copyBody: string, copyTitle: string): string {
    const combined = `${adName} ${copyBody} ${copyTitle}`.toLowerCase();
    if (/ugc|testimonial|real customer|meri kahani/.test(combined)) return 'ugc';
    if (/\d+[\s,]*(?:lakh|lac|k)\+?\s*(?:customer|log|review)/.test(combined)) return 'social_proof';
    if (/\?|kya aap|kyun|kaise|did you know|are you/.test(combined)) return 'question';
    if (/problem|pareshaan|tension|dard|dosha|sade sati/.test(combined)) return 'fear_then_relief';
    if (/secret|jaano|discover|raaz|khulasa/.test(combined)) return 'curiosity';
    if (/sirf aaj|limited|abhi|last chance|jaldi/.test(combined)) return 'urgency';
    if (/guaranteed|100%|proven|sabse|best|#1/.test(combined)) return 'bold_claim';
    if (/meri|mera|maine|my story|i was|personal/.test(combined)) return 'personal_story';
    return 'unknown';
  }

  private extractConversions(actions: any[] | undefined, conversionTypes: Set<string>): number {
    return extractConversions(actions, conversionTypes);
  }
}
