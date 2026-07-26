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

export class BudgetCapIncoherentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetCapIncoherentError';
  }
}

/** Result of the cap-coherence check — returned by the non-throwing variant. */
export interface CapCoherence {
  ok: boolean;
  dailyBudget: number;
  plannedDays: number;
  projectedSpend: number;
  cap: number;
  overrunBy: number;
  /** Cap that WOULD make this schedule coherent. */
  suggestedCap: number;
  /** Daily budget that would fit the existing cap. */
  suggestedDailyBudget: number;
  message: string;
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

  /**
   * Check 5: Lifetime spend cap must be able to accommodate the schedule.
   *
   * A lifetime cap below dailyBudget x plannedDays is not a risk, it is a
   * guaranteed breach — the campaign either halts early or trips the cap and
   * gets force-paused mid-flight, in both cases ending on a schedule nobody
   * chose. This account paid to discover it: a ₹20,000 cap against a
   * ₹2,500/day budget over 10 days projects to ₹25,000 and blew up around
   * day 8, which the learning loop then wrote up as a performance insight.
   * It was never a performance question — it is arithmetic that is knowable
   * before launch, so it belongs here with the other TypeScript-side gates
   * that Claude cannot talk its way around.
   *
   * Returns the analysis rather than throwing so callers can choose between
   * blocking (launch) and warning (dashboard, pre-launch preview).
   */
  static evaluateCapCoherence(opts: {
    dailyBudget: number;
    /** Lifetime/spend cap in account currency. 0 or undefined = uncapped. */
    cap?: number | null;
    /** Planned run length. Derived from start/stop when not passed. */
    plannedDays?: number | null;
    startTime?: Date | string | null;
    stopTime?: Date | string | null;
  }): CapCoherence | null {
    const dailyBudget = Number(opts.dailyBudget);
    const cap = Number(opts.cap ?? 0);
    if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) return null;
    if (!Number.isFinite(cap) || cap <= 0) return null; // uncapped — nothing to breach

    let plannedDays = Number(opts.plannedDays ?? 0);
    if (!Number.isFinite(plannedDays) || plannedDays <= 0) {
      const start = opts.startTime ? new Date(opts.startTime) : null;
      const stop = opts.stopTime ? new Date(opts.stopTime) : null;
      if (!start || !stop || Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
        return null; // open-ended run — the cap IS the stop condition, which is coherent
      }
      plannedDays = Math.ceil((stop.getTime() - start.getTime()) / 864e5);
    }
    if (plannedDays <= 0) return null;

    const projectedSpend = dailyBudget * plannedDays;
    const overrunBy = projectedSpend - cap;
    const ok = overrunBy <= 0;

    return {
      ok,
      dailyBudget,
      plannedDays,
      projectedSpend,
      cap,
      overrunBy: Math.max(0, overrunBy),
      suggestedCap: Math.ceil(projectedSpend),
      suggestedDailyBudget: Math.floor(cap / plannedDays),
      message: ok
        ? `Cap ₹${cap.toLocaleString('en-IN')} covers ₹${dailyBudget.toLocaleString('en-IN')}/day × ${plannedDays} days (₹${projectedSpend.toLocaleString('en-IN')}).`
        : `Spend cap ₹${cap.toLocaleString('en-IN')} cannot cover this schedule: ₹${dailyBudget.toLocaleString('en-IN')}/day × ${plannedDays} days = ₹${projectedSpend.toLocaleString('en-IN')}, an overrun of ₹${overrunBy.toLocaleString('en-IN')}. ` +
          `Raise the cap to ₹${Math.ceil(projectedSpend).toLocaleString('en-IN')} or lower the daily budget to ₹${Math.floor(cap / plannedDays).toLocaleString('en-IN')}.`,
    };
  }

  /** Blocking variant used on the launch path. */
  static checkCapCoherence(opts: Parameters<typeof SafetyChecks.evaluateCapCoherence>[0]): void {
    const result = SafetyChecks.evaluateCapCoherence(opts);
    if (result && !result.ok) {
      throw new BudgetCapIncoherentError(result.message);
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
