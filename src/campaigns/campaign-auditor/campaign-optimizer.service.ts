import { Injectable, Logger } from '@nestjs/common';
import { AgentType } from '../../claude/claude.types';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';

export interface CampaignMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  roas: number;
  ctr: number;
  cpc: number;
  frequency: number;
}

@Injectable()
export class CampaignOptimizerService {
  private readonly logger = new Logger(CampaignOptimizerService.name);

  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly metaAdsService: MetaAdsService,
    private readonly actionLogger: ActionLoggerService,
  ) {}

  /**
   * Scale a specific ad set's budget on Meta + update MongoDB.
   * Called from executePendingActions when a scale_adset action is approved.
   */
  async scaleAdSet(
    campaign: CampaignDocument,
    company: CompanyDocument,
    adSetId: string,
    metrics: CampaignMetrics,
  ): Promise<{ oldBudget: number; newBudget: number }> {
    // HARDCODED SCALE LIMIT — TypeScript level, Claude cannot override
    const scalePercent = company.maxBudgetScalePercent ?? 20;
    const maxIncrease = campaign.budget * (scalePercent / 100);
    const suggestedNewBudget = campaign.budget * 1.2; // 20% increase
    const newBudget = Math.min(suggestedNewBudget, campaign.budget + maxIncrease);

    // Check weekly cap before scaling
    const currentWeeklySpend = await this.campaignsService.getWeeklySpend(company.tenantId);
    const budgetDelta = newBudget - campaign.budget;

    if (currentWeeklySpend + (budgetDelta * 7) > company.weeklyBudgetCap) {
      await this.actionLogger.log({
        tenantId: company.tenantId,
        agent: AgentType.CAMPAIGN_AUDITOR,
        action: 'scale_blocked',
        reason: `ROAS ${metrics.roas}x qualifies for scale but weekly cap would be exceeded (₹${currentWeeklySpend} + ₹${budgetDelta * 7} projected > ₹${company.weeklyBudgetCap})`,
        outcome: 'No action taken',
        metadata: { metaCampaignId: campaign.metaCampaignId },
      });
      this.logger.log(
        `Scale blocked by weekly cap: tenantId=${company.tenantId} metaCampaignId=${campaign.metaCampaignId}`,
      );
      throw new Error('Scale blocked by weekly budget cap');
    }

    // Calculate ad set's share of the new budget
    const adSet = ((campaign as any).adSets ?? []).find((a: any) => a.metaAdSetId === adSetId);
    const budgetPercent = adSet?.budgetPercent ?? 100;
    const adSetNewDailyBudget = newBudget * (budgetPercent / 100);

    // Update on Meta via Graph API
    await this.metaAdsService.updateAdSetBudget(
      adSetId,
      adSetNewDailyBudget,
      company.meta!.accessToken,
    );

    // Update campaign-level budget in MongoDB
    await this.campaignsService.updateBudget(company.tenantId, campaign._id.toString(), newBudget);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'budget_scaled',
      reason: `ROAS ${metrics.roas}x exceeds ${company.scaleIfROASAbove}x threshold`,
      outcome: `Daily budget increased from ₹${campaign.budget}/day to ₹${newBudget.toFixed(0)}/day (ad set ${adSetId} → ₹${adSetNewDailyBudget.toFixed(0)}/day)`,
      metadata: { metaCampaignId: campaign.metaCampaignId, adSetId, oldBudget: campaign.budget, newBudget },
    });

    this.logger.log(
      `Budget scaled: tenantId=${company.tenantId} adSet=${adSetId} ₹${campaign.budget}/day → ₹${newBudget.toFixed(0)}/day`,
    );

    return { oldBudget: campaign.budget, newBudget };
  }
}
