import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
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
    private readonly claudeService: ClaudeService,
    private readonly campaignsService: CampaignsService,
    private readonly actionLogger: ActionLoggerService,
  ) {}

  async scaleBudget(
    campaign: CampaignDocument,
    company: CompanyDocument,
    metrics: CampaignMetrics,
  ): Promise<void> {
    // HARDCODED SCALE LIMIT — TypeScript level, Claude cannot override
    const maxIncrease = campaign.budget * (company.maxBudgetScalePercent / 100);
    const suggestedNewBudget = campaign.budget * 1.2; // 20% increase
    const newBudget = Math.min(suggestedNewBudget, campaign.budget + maxIncrease);

    // Check weekly cap before scaling
    const currentWeeklySpend = await this.campaignsService.getWeeklySpend(company.tenantId);
    const budgetDelta = newBudget - campaign.budget;

    if (currentWeeklySpend + budgetDelta > company.weeklyBudgetCap) {
      await this.actionLogger.log({
        tenantId: company.tenantId,
        agent: AgentType.CAMPAIGN_AUDITOR,
        action: 'scale_blocked',
        reason: `ROAS ${metrics.roas}x qualifies for scale but weekly cap would be exceeded ($${currentWeeklySpend} + $${budgetDelta} > $${company.weeklyBudgetCap})`,
        outcome: 'No action taken',
        metadata: { metaCampaignId: campaign.metaCampaignId },
      });
      this.logger.log(
        `Scale blocked by weekly cap: tenantId=${company.tenantId} metaCampaignId=${campaign.metaCampaignId}`,
      );
      return;
    }

    // Call Claude with Meta Ads MCP to update the budget
    await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: AgentType.CAMPAIGN_AUDITOR,
      systemPrompt: 'You are a Meta Ads campaign manager. Update campaign budgets using the Meta Ads MCP tools when instructed.',
      liveContext: '',
      userMessage: `Update the daily budget for Meta campaign ID "${campaign.metaCampaignId}" to $${newBudget.toFixed(2)}. Confirm the update was successful.`,
      maxTurns: 5,
    });

    await this.campaignsService.updateBudget(company.tenantId, campaign._id.toString(), newBudget);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'budget_scaled',
      reason: `ROAS ${metrics.roas}x exceeds ${company.scaleIfROASAbove}x threshold`,
      outcome: `Budget increased from $${campaign.budget} to $${newBudget.toFixed(2)}`,
      metadata: { metaCampaignId: campaign.metaCampaignId, oldBudget: campaign.budget, newBudget },
    });

    this.logger.log(
      `Budget scaled: tenantId=${company.tenantId} metaCampaignId=${campaign.metaCampaignId} $${campaign.budget} → $${newBudget.toFixed(2)}`,
    );
  }
}
