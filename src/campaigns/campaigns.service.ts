import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign, CampaignDocument } from './schemas/campaign.schema';
import { CreativePackage, CreativePackageDocument } from '../creative/schemas/creative-package.schema';
import { CreativeBrief } from '../pipeline/schemas/creative-brief.schema';

@Injectable()
export class CampaignsService {
  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBrief>,
  ) {}

  async findCreativePackage(creativePackageId: string): Promise<CreativePackageDocument | null> {
    if (!creativePackageId) return null;
    return this.creativePackageModel.findById(creativePackageId).lean().exec() as any;
  }

  async findCreativeBrief(briefId: string): Promise<CreativeBrief | null> {
    if (!briefId) return null;
    return this.creativeBriefModel.findOne({ briefId }).lean().exec() as any;
  }

  async findAll(tenantId: string): Promise<any[]> {
    const campaigns = await this.campaignModel
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return this.enrichWithTopics(tenantId, campaigns);
  }

  async findById(tenantId: string, id: string): Promise<any | null> {
    const campaign = await this.campaignModel.findOne({ tenantId, _id: id }).lean().exec();
    if (!campaign) return null;
    const enriched = await this.enrichWithTopics(tenantId, [campaign]);
    return enriched[0];
  }

  private async enrichWithTopics(tenantId: string, campaigns: any[]): Promise<any[]> {
    const missing = campaigns.filter(c => !c.topic);
    if (missing.length === 0) return campaigns;

    const briefIds = [...new Set(missing.map(c => c.briefId).filter(Boolean))];
    const runIds = [...new Set(missing.map(c => c.runId).filter(Boolean))];

    const briefs = await this.creativeBriefModel
      .find({ tenantId, $or: [{ briefId: { $in: briefIds } }, { runId: { $in: runIds } }] })
      .lean()
      .exec();

    const briefMap = new Map(briefs.map(b => [`${b.runId}:${b.briefId}`, b]));

    return campaigns.map(c => {
      if (c.topic) return c;
      const brief = briefMap.get(`${c.runId}:${c.briefId}`);
      return {
        ...c,
        topic: brief?.topic ?? '',
        angle: brief?.angle ?? '',
      };
    });
  }

  async findActive(tenantId: string): Promise<CampaignDocument[]> {
    return this.campaignModel.find({ tenantId, status: 'active' }).lean().exec();
  }

  async getWeeklySpend(tenantId: string): Promise<number> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const campaigns = await this.campaignModel
      .find({ tenantId, launchedAt: { $gte: weekAgo } })
      .lean()
      .exec();
    return campaigns.reduce((sum, c) => sum + (c.budget ?? 0), 0);
  }

  async findByRunId(tenantId: string, runId: string): Promise<CampaignDocument | null> {
    return this.campaignModel.findOne({ tenantId, runId }).lean().exec();
  }

  async countByRunId(tenantId: string, runId: string): Promise<number> {
    return this.campaignModel.countDocuments({ tenantId, runId });
  }

  async reject(tenantId: string, campaignId: string, reason: string): Promise<void> {
    await this.campaignModel.updateOne(
      { tenantId, _id: campaignId },
      { status: 'failed', pauseReason: reason, pausedAt: new Date() },
    );
  }

  async pause(tenantId: string, campaignId: string, reason: string): Promise<CampaignDocument | null> {
    return this.campaignModel
      .findOneAndUpdate(
        { tenantId, _id: campaignId },
        { status: 'paused', pausedAt: new Date(), pauseReason: reason },
        { new: true },
      )
      .lean()
      .exec();
  }

  async updateBudget(campaignId: string, newBudget: number): Promise<void> {
    await this.campaignModel.updateOne({ _id: campaignId }, { budget: newBudget });
  }

  async updateMetrics(
    campaignId: string,
    metrics: {
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      roas: number;
      ctr: number;
      cpc: number;
    },
  ): Promise<void> {
    await this.campaignModel.updateOne(
      { _id: campaignId },
      { ...metrics, lastAuditedAt: new Date() },
    );
  }

  async executeAction(
    tenantId: string,
    campaignId: string,
    actionId: string,
  ): Promise<{ type: string; targetName: string }> {
    const campaign = await this.campaignModel.findOne({ tenantId, _id: campaignId }).exec();
    if (!campaign) throw new Error('Campaign not found');

    const pendingActions = (campaign as any).pendingActions ?? [];
    const action = pendingActions.find((a: any) => a.actionId === actionId);
    if (!action) throw new Error('Action not found');
    if (action.status !== 'pending') throw new Error(`Action already ${action.status}`);

    // Mark as executed — actual Meta API call happens in auditor's executePendingActions
    action.status = 'executed';
    action.executedAt = new Date();
    action.executeAt = new Date(); // trigger immediate execution on next audit

    await this.campaignModel.updateOne(
      { tenantId, _id: campaignId },
      { pendingActions },
    );

    return { type: action.type, targetName: action.targetName };
  }

  async overrideAction(
    tenantId: string,
    campaignId: string,
    actionId: string,
  ): Promise<void> {
    const campaign = await this.campaignModel.findOne({ tenantId, _id: campaignId }).exec();
    if (!campaign) throw new Error('Campaign not found');

    const pendingActions = (campaign as any).pendingActions ?? [];
    const action = pendingActions.find((a: any) => a.actionId === actionId);
    if (!action) throw new Error('Action not found');
    if (action.status !== 'pending') throw new Error(`Action already ${action.status}`);

    action.status = 'overridden';

    await this.campaignModel.updateOne(
      { tenantId, _id: campaignId },
      { pendingActions },
    );
  }
}
