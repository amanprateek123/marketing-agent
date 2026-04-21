import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import { CreativeProducerService } from '../creative/creative-producer/creative-producer.service';
import { MetaAdsService } from '../campaigns/meta-ads/meta-ads.service';
import { CompaniesService } from '../companies/companies.service';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { SlackService } from '../delivery/slack.service';
import { QUEUES } from './queue.constants';

interface ReplacementJobData {
  tenantId: string;
  campaignId: string;
  briefId: string;
  fatiguedAdId: string;
  fatiguedHook: string;
  replacementHook: string;
  adSetId: string;
}

@Processor(QUEUES.CREATIVE_PRODUCTION)
export class CreativeReplacementProcessor extends WorkerHost {
  private readonly logger = new Logger(CreativeReplacementProcessor.name);

  constructor(
    private readonly creativeProducer: CreativeProducerService,
    private readonly metaAds: MetaAdsService,
    private readonly companiesService: CompaniesService,
    private readonly slackService: SlackService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {
    super();
  }

  async process(job: Job<ReplacementJobData>): Promise<void> {
    const { tenantId, campaignId, briefId, fatiguedAdId, fatiguedHook, replacementHook, adSetId } = job.data;
    this.logger.log(`Creative replacement starting: tenantId=${tenantId} ad=${fatiguedAdId} hook=${replacementHook}`);

    const company = await this.companiesService.findByTenantId(tenantId);

    // Helper to update replacementStatus on the pending action
    const updateReplacementStatus = async (status: 'producing' | 'complete' | 'failed') => {
      await this.campaignModel.updateOne(
        { _id: campaignId, 'pendingActions.targetId': fatiguedAdId, 'pendingActions.type': 'replace_creative' },
        { $set: { 'pendingActions.$.replacementStatus': status } },
      );
    };

    // Load original brief to rebuild BriefData with new hook
    const brief = await this.briefModel.findOne({ tenantId, briefId }).lean().exec();
    if (!brief) {
      this.logger.error(`Brief ${briefId} not found — cannot produce replacement`);
      await updateReplacementStatus('failed');
      return;
    }

    await updateReplacementStatus('producing');

    // Produce new creative with the replacement hook
    const replacementBriefId = `${briefId}-replace-${Date.now()}`;
    let creativePackage: any;
    try {
      creativePackage = await this.creativeProducer.produce(
        tenantId,
        replacementBriefId,
        `replace-${fatiguedAdId}`,
        {
          topic: (brief as any).topic,
          angle: (brief as any).angle,
          platform: (brief as any).platform,
          format: (brief as any).format,
          audience: (brief as any).audience,
          hook: replacementHook,
          keyMessage: (brief as any).keyMessage,
          conversionBridge: (brief as any).conversionBridge,
          product: (brief as any).product,
          targetSegment: (brief as any).targetSegment,
        },
      );
    } catch (err: any) {
      this.logger.error(`Creative production failed for ad ${fatiguedAdId}: ${err.message}`);
      await updateReplacementStatus('failed');
      return;
    }

    if (!creativePackage || creativePackage.status === 'failed') {
      this.logger.error(`Creative production failed for replacement of ad ${fatiguedAdId}`);
      await updateReplacementStatus('failed');
      return;
    }

    // Upload new creative to Meta and swap on the fatigued ad
    const accessToken = company.meta?.accessToken;
    if (!accessToken) {
      this.logger.error(`No Meta access token for tenantId=${tenantId}`);
      await updateReplacementStatus('failed');
      return;
    }

    const selectedIndex = creativePackage.copyPackage?.selectedIndex ?? 0;
    const newCreativeId = creativePackage.metaCreativeId;

    if (newCreativeId) {
      await this.metaAds.updateAdCreative(fatiguedAdId, newCreativeId, accessToken);
      await this.metaAds.updateAdStatus(fatiguedAdId, 'ACTIVE', accessToken);
      this.logger.log(`Ad ${fatiguedAdId} creative swapped to ${newCreativeId}`);
    }

    // Update campaign document — mark ad with new hookStyle + replacement history
    const campaign = await this.campaignModel.findOne({ _id: campaignId }).exec();
    if (campaign) {
      for (const as of (campaign as any).adSets ?? []) {
        const ad = as.ads?.find((a: any) => a.metaAdId === fatiguedAdId);
        if (ad) {
          if (!ad.replacementHistory) ad.replacementHistory = [];
          ad.replacementHistory.push({
            oldHook: fatiguedHook || ad.hookStyle || '',
            newHook: replacementHook,
            replacedAt: new Date(),
            reason: 'Creative fatigue — CTR drop triggered replacement',
          });

          ad.hookStyle = replacementHook;
          ad.status = newCreativeId ? 'active' : 'pending_creative_swap';
          ad.ctrBaseline = undefined;
          ad.baselineSetAt = undefined;
        }
      }
      await this.campaignModel.updateOne({ _id: campaignId }, { adSets: (campaign as any).adSets });
    }

    await updateReplacementStatus('complete');

    // Notify Slack
    const slackWebhook = company.delivery?.slackWebhook;
    if (slackWebhook) {
      const swapStatus = newCreativeId ? 'swapped and reactivated' : 'produced (pending manual swap)';
      await this.slackService.sendMessage(
        slackWebhook,
        tenantId,
        `✅ *Creative Replacement Complete*\n\n*Campaign:* ${campaign?.name || campaignId}\n*Ad:* ${fatiguedAdId}\n*Old Hook:* ${fatiguedHook || 'unknown'} → *New Hook:* ${replacementHook}\n*Status:* ${swapStatus}\n*Selected Variant:* ${selectedIndex}`,
      );
    }

    this.logger.log(`Creative replacement done: ad=${fatiguedAdId} hook=${replacementHook}`);
  }
}
