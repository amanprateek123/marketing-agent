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
  fatiguedAdId: string;    // empty string = add_creative mode (create new ad, don't replace)
  fatiguedHook: string;
  replacementHook: string;
  adSetId: string;         // target ad set for add_creative mode
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
    const isAddMode = !fatiguedAdId; // add_creative vs replace_creative
    this.logger.log(`Creative ${isAddMode ? 'addition' : 'replacement'} starting: tenantId=${tenantId} hook=${replacementHook}`);

    const company = await this.companiesService.findByTenantId(tenantId);

    const updateReplacementStatus = async (status: 'producing' | 'complete' | 'failed') => {
      const filter = isAddMode
        ? { _id: campaignId, 'pendingActions.type': 'add_creative', 'pendingActions.targetId': adSetId }
        : { _id: campaignId, 'pendingActions.targetId': fatiguedAdId, 'pendingActions.type': 'replace_creative' };
      await this.campaignModel.updateOne(filter, { $set: { 'pendingActions.$.replacementStatus': status } });
    };

    // Load original brief
    const brief = await this.briefModel.findOne({ tenantId, briefId }).lean().exec();
    if (!brief) {
      this.logger.error(`Brief ${briefId} not found — cannot produce creative`);
      await updateReplacementStatus('failed');
      return;
    }

    await updateReplacementStatus('producing');

    // Produce new creative with the replacement hook
    const replacementBriefId = `${briefId}-${isAddMode ? 'add' : 'replace'}-${Date.now()}`;
    let creativePackage: any;
    try {
      creativePackage = await this.creativeProducer.produce(
        tenantId,
        replacementBriefId,
        `${isAddMode ? 'add' : 'replace'}-${fatiguedAdId || adSetId}`,
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
      this.logger.error(`Creative production failed: ${err.message}`);
      await updateReplacementStatus('failed');
      return;
    }

    if (!creativePackage || creativePackage.status === 'failed') {
      this.logger.error(`Creative production failed for ${isAddMode ? 'add' : 'replace'}`);
      await updateReplacementStatus('failed');
      return;
    }

    const accessToken = company.meta?.accessToken;
    if (!accessToken) {
      this.logger.error(`No Meta access token for tenantId=${tenantId}`);
      await updateReplacementStatus('failed');
      return;
    }

    const selectedIndex = creativePackage.copyPackage?.selectedIndex ?? 0;
    const campaign = await this.campaignModel.findOne({ _id: campaignId }).exec();

    if (isAddMode) {
      // ── ADD MODE: Create a new ad in the target ad set ──────────────────────
      const selectedVariant = creativePackage.copyVariants?.[selectedIndex];
      const selectedImage = (creativePackage.images ?? []).find((img: any) => img.variantIndex === selectedIndex);

      if (!selectedVariant || !selectedImage?.imageUrl) {
        this.logger.error(`No variant or image for add_creative — variant: ${!!selectedVariant}, image: ${!!selectedImage?.imageUrl}`);
        await updateReplacementStatus('failed');
        return;
      }

      try {
        const product = (company.products ?? []).find((p: any) => p.active);
        const { adId } = await this.metaAds.createAdInAdSet(
          adSetId,
          accessToken,
          `Ad (${replacementHook}) — added ${new Date().toISOString().split('T')[0]}`,
          { primaryText: selectedVariant.primaryText, headline: selectedVariant.headline, cta: selectedVariant.cta },
          selectedImage.imageUrl,
          company.meta?.pageId ?? '',
          product?.landingUrl ?? '',
        );

        // Add the new ad to the campaign document
        if (campaign) {
          const targetAdSet = (campaign as any).adSets?.find((as: any) => as.metaAdSetId === adSetId);
          if (targetAdSet) {
            if (!targetAdSet.ads) targetAdSet.ads = [];
            targetAdSet.ads.push({
              metaAdId: adId,
              copyVariantIndex: selectedIndex,
              hookStyle: replacementHook,
              status: 'active',
            });
            await this.campaignModel.updateOne({ _id: campaignId }, { adSets: (campaign as any).adSets });
          }
        }

        this.logger.log(`New ad created in ad set ${adSetId}: adId=${adId} hook=${replacementHook}`);
      } catch (err: any) {
        this.logger.error(`Failed to create ad in ad set: ${err.message}`);
        await updateReplacementStatus('failed');
        return;
      }
    } else {
      // ── REPLACE MODE: Swap creative on fatigued ad ─────────────────────────
      const newCreativeId = creativePackage.metaCreativeId;

      if (newCreativeId) {
        await this.metaAds.updateAdCreative(fatiguedAdId, newCreativeId, accessToken);
        await this.metaAds.updateAdStatus(fatiguedAdId, 'ACTIVE', accessToken);
        this.logger.log(`Ad ${fatiguedAdId} creative swapped to ${newCreativeId}`);
      }

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
    }

    await updateReplacementStatus('complete');

    // Notify Slack
    const slackWebhook = company.delivery?.slackWebhook;
    if (slackWebhook) {
      const msg = isAddMode
        ? `✅ *New Creative Added*\n\n*Campaign:* ${campaign?.name || campaignId}\n*Ad Set:* ${adSetId}\n*Hook:* ${replacementHook}\n*Variant:* ${selectedIndex}\n\nNew ad is live alongside existing ads.`
        : `✅ *Creative Replacement Complete*\n\n*Campaign:* ${campaign?.name || campaignId}\n*Ad:* ${fatiguedAdId}\n*Old Hook:* ${fatiguedHook || 'unknown'} → *New Hook:* ${replacementHook}\n*Variant:* ${selectedIndex}`;
      await this.slackService.sendMessage(slackWebhook, tenantId, msg);
    }

    this.logger.log(`Creative ${isAddMode ? 'addition' : 'replacement'} done: hook=${replacementHook}`);
  }
}
