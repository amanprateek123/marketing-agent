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
  // campaignBudget = daily budget (₹/day). Project 7-day spend and add to current weekly spend.
  static async checkWeeklyBudget(
    tenantId: string,
    campaignBudget: number,
    company: Company,
    campaignsService: CampaignsService,
  ): Promise<void> {
    const currentWeeklySpend = await campaignsService.getWeeklySpend(tenantId);
    const projectedWeeklySpend = campaignBudget * 7; // daily → 7-day estimate
    if (currentWeeklySpend + projectedWeeklySpend > company.weeklyBudgetCap) {
      throw new BudgetCapError(
        `Weekly budget cap reached: ₹${currentWeeklySpend} already spent + ₹${projectedWeeklySpend} projected (₹${campaignBudget}/day × 7) > ₹${company.weeklyBudgetCap} cap`,
      );
    }
  }

  // Check 2: Per-campaign budget cap
  static checkCampaignBudget(campaignBudget: number, company: Company): void {
    if (campaignBudget > company.maxBudgetPerCampaign) {
      throw new BudgetCapError(
        `Campaign budget ₹${campaignBudget} exceeds max ₹${company.maxBudgetPerCampaign}`,
      );
    }
  }

  // Check 3: Forbidden topics — scan topic + hook + keyMessage
  static checkForbiddenTopics(brief: CreativeBrief, company: Company): void {
    const fieldsToCheck: { field: string; value: string }[] = [
      { field: 'topic', value: brief.topic ?? '' },
      { field: 'hook', value: (brief as any).hook ?? '' },
      { field: 'keyMessage', value: (brief as any).keyMessage ?? '' },
    ];

    for (const { field, value } of fieldsToCheck) {
      const forbidden = company.forbiddenTopics.find((t) =>
        value.toLowerCase().includes(t.toLowerCase()),
      );
      if (forbidden) {
        throw new ForbiddenTopicError(
          `Brief ${field} "${value}" matches forbidden topic "${forbidden}"`,
        );
      }
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
