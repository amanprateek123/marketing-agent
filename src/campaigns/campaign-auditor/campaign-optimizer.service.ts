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

  /**
   * Shift budget % between two ad sets in the same campaign. Total campaign budget
   * is unchanged — this is pure redistribution. The donor's allocation goes down,
   * the recipient's goes up.
   *
   * Safety rails (TS-enforced, agent cannot override):
   *   - shiftPercent clamped to (0, 50] — max half the donor's CURRENT allocation per call.
   *   - donor cannot drop below MIN_DONOR_FLOOR_PCT — keeps Meta delivery alive on the donor.
   *   - recipient cannot exceed MAX_RECIPIENT_PCT — prevents allocation overflow.
   *   - movePoints rounded DOWN (Math.floor) so we never overshoot.
   */
  async shiftBudgetBetweenAdSets(
    campaign: CampaignDocument,
    company: CompanyDocument,
    fromAdSetId: string,
    toAdSetId: string,
    requestedShiftPercent: number,
  ): Promise<{ from: { id: string; oldPercent: number; newPercent: number }; to: { id: string; oldPercent: number; newPercent: number } }> {
    const MIN_DONOR_FLOOR_PCT = 10;     // donor stays ≥10% — pause if you want it lower
    const MAX_RECIPIENT_PCT = 90;        // recipient stays ≤90% — leaves headroom for other ad sets

    if (fromAdSetId === toAdSetId) {
      throw new Error('shift_budget: donor and recipient ad sets must differ');
    }
    const shiftPercent = Math.max(0, Math.min(50, Number(requestedShiftPercent) || 0));
    if (shiftPercent <= 0) {
      throw new Error('shift_budget: shiftPercent must be > 0 (clamped to ≤50)');
    }

    const adSets = ((campaign as any).adSets ?? []) as any[];
    const donor = adSets.find(a => a.metaAdSetId === fromAdSetId);
    const recipient = adSets.find(a => a.metaAdSetId === toAdSetId);
    if (!donor) throw new Error(`shift_budget: donor ad set ${fromAdSetId} not found in campaign`);
    if (!recipient) throw new Error(`shift_budget: recipient ad set ${toAdSetId} not found in campaign`);

    const donorOldPct = Number(donor.budgetPercent) || 0;
    const recipientOldPct = Number(recipient.budgetPercent) || 0;
    if (donorOldPct <= MIN_DONOR_FLOOR_PCT) {
      throw new Error(`shift_budget: donor at ${donorOldPct}% is already at/below floor (${MIN_DONOR_FLOOR_PCT}%) — pause it instead`);
    }

    // Move shiftPercent OF the donor's CURRENT allocation, then clamp by donor floor + recipient cap.
    // e.g. donor 40% with shiftPercent 50 → naive 20pp move → check both ends.
    const naiveMovePoints = Math.floor(donorOldPct * (shiftPercent / 100));
    const maxByDonorFloor = donorOldPct - MIN_DONOR_FLOOR_PCT;
    const maxByRecipientCap = MAX_RECIPIENT_PCT - recipientOldPct;
    const movePoints = Math.min(naiveMovePoints, maxByDonorFloor, maxByRecipientCap);

    if (movePoints <= 0) {
      throw new Error(
        `shift_budget: no headroom (donor ${donorOldPct}% floor ${MIN_DONOR_FLOOR_PCT}%, recipient ${recipientOldPct}% cap ${MAX_RECIPIENT_PCT}%, requested ${shiftPercent}%)`,
      );
    }

    donor.budgetPercent = donorOldPct - movePoints;
    recipient.budgetPercent = recipientOldPct + movePoints;

    const totalDailyBudget = campaign.budget;
    const donorNewDaily = totalDailyBudget * (donor.budgetPercent / 100);
    const recipientNewDaily = totalDailyBudget * (recipient.budgetPercent / 100);

    // Apply on Meta. If the second call fails, revert the first to avoid drift between Meta and Mongo.
    await this.metaAdsService.updateAdSetBudget(fromAdSetId, donorNewDaily, company.meta!.accessToken);
    try {
      await this.metaAdsService.updateAdSetBudget(toAdSetId, recipientNewDaily, company.meta!.accessToken);
    } catch (err) {
      const donorRevertDaily = totalDailyBudget * (donorOldPct / 100);
      try {
        await this.metaAdsService.updateAdSetBudget(fromAdSetId, donorRevertDaily, company.meta!.accessToken);
      } catch (revertErr: any) {
        this.logger.error(`shift_budget revert failed on donor ${fromAdSetId}: ${revertErr.message}`);
      }
      donor.budgetPercent = donorOldPct;
      recipient.budgetPercent = recipientOldPct;
      throw err;
    }

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'budget_shifted',
      reason: `Redistributed ${movePoints}pp from ${fromAdSetId} to ${toAdSetId} (requested ${shiftPercent}% of donor)`,
      outcome: `Donor ${donorOldPct}% → ${donor.budgetPercent}% (₹${donorNewDaily.toFixed(0)}/day) | Recipient ${recipientOldPct}% → ${recipient.budgetPercent}% (₹${recipientNewDaily.toFixed(0)}/day)`,
      metadata: { metaCampaignId: campaign.metaCampaignId, fromAdSetId, toAdSetId, movePoints },
    });

    this.logger.log(
      `Budget shifted: tenantId=${company.tenantId} ${fromAdSetId} ${donorOldPct}%→${donor.budgetPercent}% | ${toAdSetId} ${recipientOldPct}%→${recipient.budgetPercent}%`,
    );

    return {
      from: { id: fromAdSetId, oldPercent: donorOldPct, newPercent: donor.budgetPercent },
      to:   { id: toAdSetId,   oldPercent: recipientOldPct, newPercent: recipient.budgetPercent },
    };
  }

  /**
   * Reduce the campaign's daily budget — mirror of scaleAdSet, downward. Use when
   * a campaign is overspending or showing softness but isn't bad enough to pause.
   * Throttle without killing. Capped at 50% reduction per call to prevent shock.
   *
   * Reverts already-applied ad-set budgets if a later one fails, to keep Meta and Mongo
   * in sync. If revert itself fails, the per-ad-set state is logged so an operator can reconcile.
   */
  async reduceTotalBudget(
    campaign: CampaignDocument,
    company: CompanyDocument,
    requestedReductionPercent: number,
  ): Promise<{ oldBudget: number; newBudget: number }> {
    const MAX_REDUCTION_PCT = 50;
    const reductionPct = Math.max(0, Math.min(MAX_REDUCTION_PCT, Number(requestedReductionPercent) || 0));
    if (reductionPct <= 0) {
      throw new Error('reduce_total_budget: reductionPercent must be > 0');
    }

    const oldBudget = campaign.budget;
    const newBudget = Math.round(oldBudget * (1 - reductionPct / 100));
    if (newBudget <= 0) {
      throw new Error(`reduce_total_budget: newBudget would be ${newBudget} — pause campaign instead`);
    }

    // Capture per-ad-set old daily budgets so we can roll back on partial failure.
    const adSets = ((campaign as any).adSets ?? []) as any[];
    const activeAdSets = adSets.filter(a => a.status === 'active');
    const updates: { adSetId: string; oldDaily: number; newDaily: number }[] = activeAdSets.map(as => {
      const pct = (Number(as.budgetPercent) || 0) / 100;
      return {
        adSetId: as.metaAdSetId,
        oldDaily: oldBudget * pct,
        newDaily: newBudget * pct,
      };
    });

    const applied: { adSetId: string; oldDaily: number }[] = [];
    try {
      for (const u of updates) {
        if (u.newDaily > 0) {
          await this.metaAdsService.updateAdSetBudget(u.adSetId, u.newDaily, company.meta!.accessToken);
          applied.push({ adSetId: u.adSetId, oldDaily: u.oldDaily });
        }
      }
    } catch (err: any) {
      this.logger.error(
        `reduce_total_budget: failed mid-loop on adSetId=${err?.metaAdSetId ?? '?'} after ${applied.length} successful updates — rolling back`,
      );
      for (const a of applied) {
        try {
          await this.metaAdsService.updateAdSetBudget(a.adSetId, a.oldDaily, company.meta!.accessToken);
        } catch (revertErr: any) {
          this.logger.error(
            `reduce_total_budget revert failed for adSetId=${a.adSetId} (oldDaily=₹${a.oldDaily}): ${revertErr.message} — operator must reconcile manually`,
          );
        }
      }
      throw err;
    }
    await this.campaignsService.updateBudget(company.tenantId, campaign._id.toString(), newBudget);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'budget_reduced',
      reason: `Throttled by ${reductionPct}% — softening performance without pausing`,
      outcome: `Daily budget ₹${oldBudget} → ₹${newBudget}`,
      metadata: { metaCampaignId: campaign.metaCampaignId, oldBudget, newBudget },
    });

    this.logger.log(
      `Budget reduced: tenantId=${company.tenantId} ${campaign.metaCampaignId} ₹${oldBudget} → ₹${newBudget}`,
    );

    return { oldBudget, newBudget };
  }

  /**
   * Narrow an ad set's placements — pull off Audience Network / Stories etc. when
   * those placements are bleeding without taking down the whole ad set.
   */
  async narrowAdSetPlacement(
    campaign: CampaignDocument,
    company: CompanyDocument,
    adSetId: string,
    placements: {
      publisherPlatforms: string[];
      facebookPositions?: string[];
      instagramPositions?: string[];
      audienceNetworkPositions?: string[];
      messengerPositions?: string[];
    },
  ): Promise<void> {
    await this.metaAdsService.updateAdSetPlacements(adSetId, placements, company.meta!.accessToken);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'placement_narrowed',
      reason: `Narrowed to ${placements.publisherPlatforms.join(',')} — pulled off bleeding inventory`,
      outcome: `Ad set ${adSetId} now restricted to ${placements.publisherPlatforms.join(',')}`,
      metadata: { metaCampaignId: campaign.metaCampaignId, adSetId, placements },
    });
  }

  /**
   * Set dayparting on an ad set. India peak windows: 9pm-12am IST = minute 1260-1440;
   * morning commute 8-10am = 480-600. Days: 0-6 (Sun-Sat).
   *
   * Meta interprets adset_schedule in the AD ACCOUNT's timezone. Our prompt advertises
   * IST minutes — so we refuse the action if the ad account isn't Asia/Kolkata (caller
   * sees an explicit error rather than silent wrong-hour delivery).
   */
  async daypartAdSet(
    campaign: CampaignDocument,
    company: CompanyDocument,
    adSetId: string,
    schedule: { startMinute: number; endMinute: number; days: number[] }[],
  ): Promise<void> {
    if (!schedule.length) {
      throw new Error('dayparting: schedule must have at least one slot');
    }

    // TZ guard — refuse non-IST accounts. The prompt teaches the LLM in IST minutes.
    if (company.meta?.accountId) {
      const accountTz = await this.metaAdsService.getAdAccountTimezone(
        company.meta.accountId,
        company.meta.accessToken,
      );
      if (accountTz && accountTz !== 'Asia/Kolkata') {
        throw new Error(
          `dayparting refused: ad account TZ is "${accountTz}", schedule was specified in IST. ` +
          `Either change the ad account TZ to Asia/Kolkata, or implement TZ translation before calling this action.`,
        );
      }
    }

    await this.metaAdsService.updateAdSetSchedule(adSetId, schedule, company.meta!.accessToken);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'dayparting_applied',
      reason: `Restricted delivery to ${schedule.length} time slot(s) per week`,
      outcome: `Ad set ${adSetId} dayparted`,
      metadata: { metaCampaignId: campaign.metaCampaignId, adSetId, schedule },
    });
  }

  /**
   * Duplicate a fatigued ad set with a fresh audience, keeping the same creative.
   * The senior-buyer move when frequency is high but the creative is still good:
   * resets Meta's learning phase on the new audience, lets the proven creative
   * keep running. Source ad set is paused after duplication.
   *
   * Validation gates (TS-enforced):
   *   - source ad set must have frequency > 4.5 (otherwise no fatigue justification)
   *   - source ad set's CTR trend must NOT be declining (if it is, the creative is
   *     the problem, not the audience — agent should use replace_creative)
   *   - newAudienceId or useAdvantagePlus must be provided
   */
  async refreshAudience(
    campaign: CampaignDocument,
    company: CompanyDocument,
    sourceAdSetId: string,
    newAudience: { newAudienceId?: string; useAdvantagePlus?: boolean },
    sourceMetrics: { frequency: number; ctrTrend: 'improving' | 'stable' | 'declining' | 'insufficient_data' },
  ): Promise<{ newAdSetId: string; sourcePaused: boolean }> {
    const MIN_FREQUENCY_FOR_REFRESH = 4.5;

    if (sourceMetrics.frequency < MIN_FREQUENCY_FOR_REFRESH) {
      throw new Error(
        `refresh_audience refused: source ad set frequency ${sourceMetrics.frequency.toFixed(1)} is below ${MIN_FREQUENCY_FOR_REFRESH} — not yet fatigued. Wait or use a different action.`,
      );
    }
    if (sourceMetrics.ctrTrend === 'declining') {
      throw new Error(
        `refresh_audience refused: source ad set CTR is declining — the creative is the problem, not the audience. Use replace_creative instead.`,
      );
    }
    if (!newAudience.newAudienceId && !newAudience.useAdvantagePlus) {
      throw new Error('refresh_audience: provide either newAudienceId or useAdvantagePlus=true');
    }

    // ── Retarget guard ────────────────────────────────────────────────────
    // Retarget pods naturally run at frequency 6-8 (warm audience, repeat exposure works) —
    // the fatigue detector applies a 1.75× multiplier to suppress false alarms there. But
    // refreshAudience's flat 4.5 floor doesn't know that, so a healthy retarget pod at freq
    // 7 with good CTR could fall into the refresh path. Duplicating a retarget pod into a
    // different audience strips it of its website-visitor seed → ROAS collapse.
    // Block when source is retarget/custom unless the operator explicitly wants Advantage+
    // (which doesn't make sense for retarget either, but is at least an explicit choice).
    const sourceAdSetForGuard = ((campaign as any).adSets ?? []).find((a: any) => a.metaAdSetId === sourceAdSetId);
    const sourceAudienceType = sourceAdSetForGuard?.audienceType ?? 'unknown';
    if ((sourceAudienceType === 'retarget' || sourceAudienceType === 'custom') && !newAudience.useAdvantagePlus) {
      throw new Error(
        `refresh_audience refused: source ad set is retarget/custom (audience seeded by website visitors). Duplicating into a different audience strips the seed and collapses ROAS. ` +
        `For retarget fatigue, prefer extending the lookback window (e.g. visitors_30d → visitors_60d) or pausing this pod and creating a fresh one with add_adset.`,
      );
    }

    const { newAdSetId } = await this.metaAdsService.duplicateAdSetWithNewAudience(
      sourceAdSetId, company.meta!.accessToken, newAudience,
    );

    // Pause the source ad set
    let sourcePaused = false;
    try {
      await this.metaAdsService.pauseAdSet(sourceAdSetId, company.meta!.accessToken);
      sourcePaused = true;
    } catch (err: any) {
      this.logger.error(`refresh_audience: created ${newAdSetId} but failed to pause source ${sourceAdSetId}: ${err.message}`);
    }

    // Track in campaign document
    const adSets = ((campaign as any).adSets ?? []) as any[];
    const sourceAdSet = adSets.find(a => a.metaAdSetId === sourceAdSetId);
    if (sourceAdSet) sourceAdSet.status = 'paused';
    adSets.push({
      metaAdSetId: newAdSetId,
      name: `Refresh of ${sourceAdSet?.name ?? sourceAdSetId}`,
      audienceType: newAudience.useAdvantagePlus ? 'advantage_plus' : 'custom',
      status: 'active',
      ads: [],   // /copies brought ads over server-side; we'll discover them on next audit
      budgetPercent: sourceAdSet?.budgetPercent ?? 0,
    });

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'audience_refreshed',
      reason: `Source freq ${sourceMetrics.frequency.toFixed(1)} ≥ ${MIN_FREQUENCY_FOR_REFRESH} with healthy CTR trend (${sourceMetrics.ctrTrend}) — duplicating with fresh audience`,
      outcome: `New ad set ${newAdSetId} active with ${newAudience.useAdvantagePlus ? 'Advantage+' : `audience ${newAudience.newAudienceId}`}; source ${sourceAdSetId} ${sourcePaused ? 'paused' : 'pause failed (see logs)'}`,
      metadata: { metaCampaignId: campaign.metaCampaignId, sourceAdSetId, newAdSetId, newAudience, sourcePaused },
    });

    return { newAdSetId, sourcePaused };
  }
}
