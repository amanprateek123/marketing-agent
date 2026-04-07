import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';

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
      const roas = spend > 0 && conversions > 0 ? (conversions * 1) / spend : 0; // approximate

      const metaStatus = campaign.status ?? 'PAUSED';
      const internalStatus = META_TO_INTERNAL_STATUS[metaStatus] ?? 'paused';

      const existing = await this.campaignModel.findOne({
        tenantId,
        metaCampaignId: campaign.id,
      }).exec();

      if (existing) {
        // Update metrics — preserve source/runId/briefId if already set by agent
        await this.campaignModel.updateOne(
          { _id: existing._id },
          {
            $set: {
              status: internalStatus,
              spend, impressions, clicks, conversions, roas, ctr, cpc,
              syncedAt: new Date(),
            },
          },
        );
        synced++;
      } else {
        // New campaign — manually created by tenant on Meta
        await this.campaignModel.create({
          tenantId,
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
          timeout: 30000,
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
          timeout: 30000,
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

  private extractConversions(actions: any[] | undefined, conversionTypes: Set<string>): number {
    if (!actions || actions.length === 0) return 0;

    const customActions = actions.filter(
      a => a.action_type.startsWith('offsite_conversion.custom.') && conversionTypes.has(a.action_type),
    );
    if (customActions.length > 0) {
      return customActions.reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
    }

    // Custom pixel events (e.g. NADI_REPORT_PURCHASE_COMPLETED)
    const STANDARD_EVENTS = new Set(['purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
      'offsite_conversion.fb_pixel_lead', 'complete_registration', 'submit_application', 'subscribe', 'start_trial']);
    const customEventActions = actions.filter(
      a => !a.action_type.startsWith('offsite_conversion.custom.')
        && !STANDARD_EVENTS.has(a.action_type)
        && conversionTypes.has(a.action_type),
    );
    if (customEventActions.length > 0) {
      return customEventActions.reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
    }

    const PRIORITY = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
      'offsite_conversion.fb_pixel_lead', 'complete_registration'];
    for (const type of PRIORITY) {
      if (!conversionTypes.has(type)) continue;
      const action = actions.find(a => a.action_type === type);
      if (action && parseInt(action.value ?? '0', 10) > 0) return parseInt(action.value, 10);
    }
    return 0;
  }
}
