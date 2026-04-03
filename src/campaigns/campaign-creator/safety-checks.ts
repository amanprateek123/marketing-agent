import { Company } from '../../companies/schemas/company.schema';
import { CreativeBrief } from '../../pipeline/schemas/creative-brief.schema';
import { CampaignsService } from '../campaigns.service';

export class BudgetCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetCapError';
  }
}

export class ForbiddenTopicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenTopicError';
  }
}

export class CampaignLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignLimitError';
  }
}

export class SafetyChecks {
  // Check 1: Weekly budget cap
  static async checkWeeklyBudget(
    tenantId: string,
    campaignBudget: number,
    company: Company,
    campaignsService: CampaignsService,
  ): Promise<void> {
    const currentWeeklySpend = await campaignsService.getWeeklySpend(tenantId);
    if (currentWeeklySpend + campaignBudget > company.weeklyBudgetCap) {
      throw new BudgetCapError(
        `Weekly budget cap reached: $${currentWeeklySpend} + $${campaignBudget} > $${company.weeklyBudgetCap}`,
      );
    }
  }

  // Check 2: Per-campaign budget cap
  static checkCampaignBudget(campaignBudget: number, company: Company): void {
    if (campaignBudget > company.maxBudgetPerCampaign) {
      throw new BudgetCapError(
        `Campaign budget $${campaignBudget} exceeds max $${company.maxBudgetPerCampaign}`,
      );
    }
  }

  // Check 3: Forbidden topics
  static checkForbiddenTopics(brief: CreativeBrief, company: Company): void {
    const forbidden = company.forbiddenTopics.find((t) =>
      brief.topic.toLowerCase().includes(t.toLowerCase()),
    );
    if (forbidden) {
      throw new ForbiddenTopicError(
        `Brief topic "${brief.topic}" matches forbidden topic "${forbidden}"`,
      );
    }
  }

  // Check 4: Campaigns per run limit
  static async checkCampaignsPerRun(
    tenantId: string,
    runId: string,
    company: Company,
    campaignsService: CampaignsService,
  ): Promise<void> {
    const launchedThisRun = await campaignsService.countByRunId(tenantId, runId);
    if (launchedThisRun >= company.campaignsPerRun) {
      throw new CampaignLimitError(
        `Already launched ${launchedThisRun}/${company.campaignsPerRun} campaigns this run`,
      );
    }
  }
}
