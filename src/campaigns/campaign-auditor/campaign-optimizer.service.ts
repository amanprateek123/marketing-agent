import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../../claude/claude.types';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { SafetyChecks } from '../campaign-creator/safety-checks';
import { withUtmParams } from '../meta-ads/meta-utm.util';
import { tryResolveCampaignProduct } from '../campaign-creator/resolve-campaign-product';
import { GalleryService } from '../../gallery/gallery.service';
import { CreativePackage, CreativePackageDocument } from '../../creative/schemas/creative-package.schema';
import { PlacementPreset, resolvePlacementPreset } from '../meta-ads/placement-presets';

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

/** One ad's worth of media + copy — the unit createAdsForEntries fans out over. */
interface AdEntry {
  assetType: 'image' | 'video';
  mediaUrl: string;
  copy: { primaryText: string; headline: string; cta: string };
}

/** Result of creating N ads from N entries — some may fail without aborting the rest. */
interface CreateAdsResult {
  createdAds: Array<{ adId: string; creativeId: string; headline: string; assetType: 'image' | 'video' }>;
  failed: Array<{ headline?: string; error: string }>;
}

@Injectable()
export class CampaignOptimizerService {
  private readonly logger = new Logger(CampaignOptimizerService.name);

  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly metaAdsService: MetaAdsService,
    private readonly actionLogger: ActionLoggerService,
    private readonly galleryService: GalleryService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
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
   * Operator-driven direct budget set on one live ad set — "put ₹3,000/day
   * on this one" — as opposed to the AI's percent-based scale/shift/reduce
   * moves above. Same TS-side caps (maxBudgetPerCampaign, weeklyBudgetCap)
   * so a manual entry can't bypass the rails those enforce on AI changes;
   * a human can still type a number that blows the budget, so this checks
   * it the same way scaleAdSet does rather than trusting the input.
   */
  async setAdSetBudget(
    campaign: CampaignDocument,
    company: CompanyDocument,
    adSetId: string,
    newDailyBudget: number,
  ): Promise<{ oldDailyBudget: number; newDailyBudget: number; newCampaignBudget: number }> {
    const adSets = (campaign as any).metaAdSets ?? [];
    const adSet = adSets.find((a: any) => a.id === adSetId);
    if (!adSet) {
      throw new Error(`Ad set ${adSetId} not found on campaign ${campaign._id}`);
    }
    const oldDailyBudget = adSet.dailyBudget ?? 0;
    const delta = newDailyBudget - oldDailyBudget;

    // campaign.budget can drift from the sum of live ad-set budgets (manual
    // edits, partial scale failures) — reduce over the ad sets we actually
    // have rather than trust the stored total.
    const currentTotalBudget = adSets.reduce(
      (sum: number, a: any) => sum + (a.dailyBudget ?? 0),
      0,
    ) || campaign.budget || 0;
    const newTotalBudget = currentTotalBudget + delta;

    // Same per-campaign cap the launch/pre-launch-edit paths enforce.
    SafetyChecks.checkCampaignBudget(newTotalBudget, company);

    const currentWeeklySpend = await this.campaignsService.getWeeklySpend(company.tenantId);
    const weeklyCap = (company as any).weeklyBudgetCap ?? 0;
    if (weeklyCap && currentWeeklySpend + delta * 7 > weeklyCap) {
      throw new Error(
        `₹${currentWeeklySpend.toFixed(0)} already committed this week + ₹${(delta * 7).toFixed(0)} projected from this change would exceed the ₹${weeklyCap} weekly cap.`,
      );
    }

    await this.metaAdsService.updateAdSetBudget(
      adSetId,
      newDailyBudget,
      company.meta!.accessToken,
    );

    await this.campaignsService.updateBudget(
      company.tenantId,
      campaign._id.toString(),
      newTotalBudget,
    );

    this.logger.log(
      `Manual budget set: tenantId=${company.tenantId} adSet=${adSetId} ₹${oldDailyBudget}/day → ₹${newDailyBudget}/day (campaign total ₹${currentTotalBudget.toFixed(0)} → ₹${newTotalBudget.toFixed(0)})`,
    );

    return { oldDailyBudget, newDailyBudget, newCampaignBudget: newTotalBudget };
  }

  /**
   * Operator-driven placement change on one live ad set — "switch this to
   * Vertical + Feed" — the manual counterpart to the AI audit loop's
   * narrow_placement action (narrowAdSetPlacement below), but broadening as
   * well as narrowing, and resolved from a fixed preset rather than raw
   * position arrays an operator would have to get right by hand. Reuses
   * MetaAdsService.updateAdSetPlacements unchanged — no new Meta-API-facing
   * code. Logs via plain Logger, not ActionLoggerService, matching
   * setAdSetBudget above: ActionLoggerService's `agent` field is for
   * AI-attributed actions, and this is a human's PATCH.
   */
  async setAdSetPlacement(
    campaign: CampaignDocument,
    company: CompanyDocument,
    adSetId: string,
    placementPreset: PlacementPreset,
  ): Promise<{ adSetId: string; placementPreset: PlacementPreset }> {
    if (!campaign.metaCampaignId) {
      throw new Error(`Campaign ${campaign._id} was never launched on Meta`);
    }

    const resolved = resolvePlacementPreset(placementPreset);
    await this.metaAdsService.updateAdSetPlacements(
      adSetId,
      {
        publisherPlatforms: resolved.publisherPlatforms,
        facebookPositions: resolved.facebookPositions,
        instagramPositions: resolved.instagramPositions,
      },
      company.meta!.accessToken,
    );

    this.logger.log(
      `Manual placement set: tenantId=${company.tenantId} adSet=${adSetId} → ${placementPreset} (${resolved.facebookPositions.join(',')} / ${resolved.instagramPositions.join(',')})`,
    );

    return { adSetId, placementPreset };
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

  /**
   * Resolves a Gallery sheet into ad-ready entries — every non-carousel,
   * non-excluded asset in it, copy pulled from its source CreativePackage
   * (`copyVariants[variantIndex]`, falling back to the package's selected
   * variant) same as the frontend's ExistingCreativePicker/GalleryPicker
   * already do client-side, just moved server-side so this endpoint can
   * resolve a whole sheet from a bare sheetId. Carousel cards are skipped —
   * a card is a slide inside ONE multi-card ad, not a standalone ad, and out
   * of scope here (the existing campaigns/new GalleryPicker excludes them
   * the same way).
   */
  private async resolveSheetEntries(
    tenantId: string,
    sheetId: string,
    excludeAssetIds?: string[],
  ): Promise<{ entries: AdEntry[]; skippedCarousel: number }> {
    const assets = await this.galleryService.listSheetAssets(tenantId, sheetId);
    const excludeSet = new Set(excludeAssetIds ?? []);
    const skippedCarousel = assets.filter(
      (a) => a.assetType === 'carousel_card',
    ).length;
    const usable = assets.filter(
      (a) => a.assetType !== 'carousel_card' && !excludeSet.has(a._id),
    );

    const packageIds = [...new Set(usable.map((a) => a.sourcePackageId))];
    const packages = await this.creativePackageModel
      .find({ _id: { $in: packageIds } })
      .select('copyVariants selectedCopyIndex')
      .lean()
      .exec();
    const packageById = new Map(packages.map((p) => [p._id.toString(), p]));

    const entries: AdEntry[] = usable.map((a) => {
      const pkg = packageById.get(a.sourcePackageId);
      const variant =
        (pkg as any)?.copyVariants?.[a.variantIndex] ??
        (pkg as any)?.copyVariants?.[(pkg as any)?.selectedCopyIndex ?? 0];
      return {
        assetType: a.assetType as 'image' | 'video',
        mediaUrl: a.assetUrl,
        copy: {
          primaryText: variant?.primaryText ?? '',
          headline: variant?.headline ?? '',
          cta: variant?.cta || 'Shop Now',
        },
      };
    });

    return { entries, skippedCarousel };
  }

  /**
   * Fans out N ad-creation calls (one per entry) over the SAME existing,
   * unchanged MetaAdsService methods the single-creative paths already use —
   * no new Meta-API-facing code. Batched 4-at-a-time rather than one big
   * Promise.allSettled: metaApiCall already retries account-level throttling
   * (code 80004) with backoff, but a large sheet firing every ad-creation
   * POST at once would still burn that retry budget simultaneously. One bad
   * entry doesn't block the rest — same "isolate failures" spirit as
   * uploadCreativeBulk/addExistingAssets elsewhere in this codebase.
   */
  private async createAdsForEntries(
    adSetId: string,
    entries: AdEntry[],
    accessToken: string,
    adNameFor: (entry: AdEntry) => string,
    landingUrlFor: (adName: string) => string,
    pageId: string,
    specialAdCategories: string[],
  ): Promise<CreateAdsResult> {
    const createdAds: CreateAdsResult['createdAds'] = [];
    const failed: CreateAdsResult['failed'] = [];

    const BATCH_SIZE = 4;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((entry) => {
          const adName = adNameFor(entry);
          const landingUrl = landingUrlFor(adName);
          return entry.assetType === 'video'
            ? this.metaAdsService.createVideoAdInAdSet(
                adSetId,
                accessToken,
                adName,
                entry.copy,
                entry.mediaUrl,
                pageId,
                landingUrl,
                specialAdCategories,
              )
            : this.metaAdsService.createAdInAdSet(
                adSetId,
                accessToken,
                adName,
                entry.copy,
                entry.mediaUrl,
                pageId,
                landingUrl,
                specialAdCategories,
              );
        }),
      );
      results.forEach((result, idx) => {
        const entry = batch[idx];
        if (result.status === 'fulfilled') {
          createdAds.push({
            ...result.value,
            headline: entry.copy.headline,
            assetType: entry.assetType,
          });
        } else {
          failed.push({
            headline: entry.copy.headline,
            error: (result.reason as any)?.message ?? 'Ad creation failed',
          });
        }
      });
    }

    return { createdAds, failed };
  }

  /**
   * Operator-driven "add a new ad set to this live campaign" — same campaign,
   * a brand-new ad set inside it. This is the manual counterpart to the
   * auditor's automated `add_adset` action (campaign-auditor.service.ts):
   * same Meta API calls (createAdSetInCampaign → createAdInAdSet), same
   * carousel guard, same "resolve product strictly, never guess" rule — but
   * every choice here is the operator's (which existing ad's creative to
   * clone, which audience, how much budget), not an AI heuristic. Written as
   * fresh logic rather than refactoring the auditor's inline version, so a
   * bug here can't regress the automated path.
   *
   * Accepts EITHER one operator-supplied creative (unchanged from before) OR
   * a whole Gallery sheet (`sheetId`) — every usable asset in the sheet
   * becomes its own ad in the new ad set, copy pulled from each asset's own
   * source package. The ad set's budget is unaffected by which mode is used —
   * Meta ad set budget is per-ad-set, not per-ad, so it doesn't scale with
   * how many ads populate it.
   */
  async addAdSet(
    campaign: CampaignDocument,
    company: CompanyDocument,
    opts: {
      name?: string;
      audienceType: 'advantage_plus' | 'retarget' | 'lookalike';
      metaAudienceId?: string;
      dailyBudget: number;
      /** Which Meta surfaces the new ad set can serve on. Undefined -> 'vertical' (the long-standing default) — see placement-presets.ts. */
      placementPreset?: PlacementPreset;
    } & (
      | {
          assetType: 'image' | 'video';
          mediaUrl: string;
          copy: { primaryText: string; headline: string; cta: string };
        }
      | { sheetId: string; excludeAssetIds?: string[] }
    ),
  ): Promise<{
    newAdSetId: string;
    newAdId: string;
    newCampaignBudget: number;
    createdAds: CreateAdsResult['createdAds'];
    failed: CreateAdsResult['failed'];
    skippedCarousel: number;
  }> {
    if (!campaign.metaCampaignId) {
      throw new Error(`Campaign ${campaign._id} was never launched on Meta`);
    }
    if (opts.audienceType !== 'advantage_plus' && !opts.metaAudienceId) {
      throw new Error(
        `metaAudienceId is required for audienceType=${opts.audienceType}`,
      );
    }

    // Resolve product strictly from the campaign's own record — never fall
    // back to "the tenant's first active product," which is how a new ad set
    // could point at another product's landing page/pixel/conversion.
    const { resolution, error } = tryResolveCampaignProduct(
      company,
      campaign as any,
      null,
    );
    const product = resolution?.product;
    if (!product?.landingUrl) {
      throw new Error(
        error ??
          `Product "${product?.name}" has no Landing URL — set it before adding an ad set.`,
      );
    }
    const landingUrl = product.landingUrl;

    // Same TS-side caps as every other budget path — a human picking a
    // number doesn't get to skip the rails an AI-proposed change would.
    const adSets: any[] =
      (campaign as any).metaAdSets ?? (campaign as any).adSets ?? [];
    const currentTotalBudget =
      adSets.reduce((sum: number, a: any) => sum + (a.dailyBudget ?? 0), 0) ||
      campaign.budget ||
      0;
    const newTotalBudget = currentTotalBudget + opts.dailyBudget;
    SafetyChecks.checkCampaignBudget(newTotalBudget, company);
    const currentWeeklySpend = await this.campaignsService.getWeeklySpend(
      company.tenantId,
    );
    const weeklyCap = (company as any).weeklyBudgetCap ?? 0;
    if (weeklyCap && currentWeeklySpend + opts.dailyBudget * 7 > weeklyCap) {
      throw new Error(
        `₹${currentWeeklySpend.toFixed(0)} already committed this week + ₹${(opts.dailyBudget * 7).toFixed(0)} projected from this ad set would exceed the ₹${weeklyCap} weekly cap.`,
      );
    }

    // Resolve the sheet (if that's the mode) BEFORE creating anything on
    // Meta — an empty/all-excluded/all-carousel sheet must never leave
    // behind an orphaned, adless ad set.
    let entries: AdEntry[];
    let skippedCarousel = 0;
    let sheetName: string | undefined;
    if ('sheetId' in opts) {
      const resolved = await this.resolveSheetEntries(
        company.tenantId,
        opts.sheetId,
        opts.excludeAssetIds,
      );
      entries = resolved.entries;
      skippedCarousel = resolved.skippedCarousel;
      if (entries.length === 0) {
        throw new Error(
          'No usable creatives in this sheet — everything is a carousel card, excluded, or the sheet is empty.',
        );
      }
      sheetName = (
        await this.galleryService.getSheet(company.tenantId, opts.sheetId)
      )?.name;
    } else {
      entries = [
        { assetType: opts.assetType, mediaUrl: opts.mediaUrl, copy: opts.copy },
      ];
    }

    const adSetName =
      opts.name?.trim() ||
      sheetName ||
      `${opts.audienceType.toUpperCase()}_${new Date().toISOString().split('T')[0]}`;
    // Inherit the existing campaign's optimization goal — mixing OFFSITE_CONVERSIONS
    // and VALUE ad sets in one campaign splits the learning signal and confuses
    // ROAS comparison across ad sets.
    const inheritedOptimizationGoal =
      (campaign as any).campaignConfig?.adSets?.[0]?.optimizationGoal ??
      'OFFSITE_CONVERSIONS';

    const newAdSetId = await this.metaAdsService.createAdSetInCampaign(
      campaign.metaCampaignId,
      company.meta!.accessToken,
      {
        name: adSetName,
        budgetPercent: 100, // totalBudget below IS this ad set's budget, not the campaign's
        audienceType: opts.audienceType,
        optimizationGoal: inheritedOptimizationGoal,
        ads: [0], // bookkeeping only — not read by createAdSet's Meta payload; the ad(s) are created separately below
        placementPreset: opts.placementPreset,
        ...(opts.metaAudienceId ? { metaAudienceId: opts.metaAudienceId } : {}),
      },
      opts.dailyBudget,
      (campaign as any).campaignConfig?.conversionEvent ?? 'Purchase',
      product.pixelId ?? company.meta!.pixelId,
      product.customEventName,
      product.customConversionId,
    );

    const pageId = product.pageId ?? company.meta!.pageId ?? '';
    const specialAdCategories =
      (company.meta as any)?.specialAdCategories ?? [];
    const { createdAds, failed } = await this.createAdsForEntries(
      newAdSetId,
      entries,
      company.meta!.accessToken,
      (entry) => `${adSetName} — ${entry.copy.headline || 'ad'}`,
      (adName) =>
        withUtmParams(landingUrl, {
          campaignName: campaign.name ?? String(campaign._id),
          adSetName,
          adName,
        }),
      pageId,
      specialAdCategories,
    );

    // Every entry failed — mirror the pre-existing behavior where a single
    // createAdInAdSet throw aborted before activation/budget-commit.
    // Promise.allSettled never rejects the outer call, so this has to be
    // checked explicitly now that there can be more than one entry. The ad
    // set itself is left behind on Meta (PAUSED, adless) — acceptable, since
    // no budget was committed and nothing went live.
    if (createdAds.length === 0) {
      this.logger.warn(
        `addAdSet: every ad failed, leaving an empty PAUSED ad set on Meta: ${newAdSetId}`,
      );
      throw new Error(
        failed[0]?.error
          ? `Ad set was created but every ad failed: ${failed[0].error}`
          : 'Ad set was created but no ads could be created.',
      );
    }

    // The ad set itself defaults to PAUSED on creation (separate from each
    // ad, which createAdInAdSet/createVideoAdInAdSet already activate internally).
    await this.metaAdsService.updateAdStatus(
      newAdSetId,
      'ACTIVE',
      company.meta!.accessToken,
    );

    await this.campaignsService.updateBudget(
      company.tenantId,
      campaign._id.toString(),
      newTotalBudget,
    );

    this.logger.log(
      `Manual add_adset: tenantId=${company.tenantId} campaign=${campaign._id} newAdSet=${newAdSetId} created=${createdAds.length} failed=${failed.length} skippedCarousel=${skippedCarousel} ₹${opts.dailyBudget}/day`,
    );

    return {
      newAdSetId,
      newAdId: createdAds[0].adId,
      newCampaignBudget: newTotalBudget,
      createdAds,
      failed,
      skippedCarousel,
    };
  }

  /**
   * Operator-authored creative added to an EXISTING live ad set — a human
   * writes their own copy and supplies their own image/video, rather than
   * the AI generating something (add_creative/replace_creative) or backfill-
   * variants re-adding a variant already sitting in the package. The ad set
   * itself, its budget, and its audience are untouched — only new ad(s) join
   * it.
   *
   * mediaUrl is expected to already be hosted (e.g. via
   * POST /creative/:tenantId/upload-file) — this method doesn't accept raw
   * file bytes, matching how every other Meta-write path in this codebase
   * takes a URL, never a file.
   *
   * Accepts EITHER one operator-supplied creative (unchanged from before) OR
   * a whole Gallery sheet (`sheetId`) — every usable asset in the sheet
   * becomes its own new ad in this ad set.
   */
  async addCreativeToAdSet(
    campaign: CampaignDocument,
    company: CompanyDocument,
    opts: {
      adSetId: string;
      name?: string;
    } & (
      | {
          assetType: 'image' | 'video';
          mediaUrl: string;
          copy: { primaryText: string; headline: string; cta: string };
        }
      | { sheetId: string; excludeAssetIds?: string[] }
    ),
  ): Promise<{
    adId: string;
    creativeId: string;
    createdAds: CreateAdsResult['createdAds'];
    failed: CreateAdsResult['failed'];
    skippedCarousel: number;
  }> {
    if (!campaign.metaCampaignId) {
      throw new Error(`Campaign ${campaign._id} was never launched on Meta`);
    }

    // Resolve product strictly from the campaign's own record — never fall
    // back to "the tenant's first active product," same rule every other
    // ad-creation path in this codebase follows.
    const { resolution, error } = tryResolveCampaignProduct(
      company,
      campaign as any,
      null,
    );
    const product = resolution?.product;
    if (!product?.landingUrl) {
      throw new Error(
        error ??
          `Product "${product?.name}" has no Landing URL — set it before adding a creative.`,
      );
    }
    const landingUrl = product.landingUrl;

    const adSetName =
      ((campaign as any).metaAdSets ?? (campaign as any).adSets ?? []).find(
        (as: any) => (as.id ?? as.metaAdSetId) === opts.adSetId,
      )?.name ?? opts.adSetId;

    let entries: AdEntry[];
    let skippedCarousel = 0;
    if ('sheetId' in opts) {
      const resolved = await this.resolveSheetEntries(
        company.tenantId,
        opts.sheetId,
        opts.excludeAssetIds,
      );
      entries = resolved.entries;
      skippedCarousel = resolved.skippedCarousel;
      if (entries.length === 0) {
        throw new Error(
          'No usable creatives in this sheet — everything is a carousel card, excluded, or the sheet is empty.',
        );
      }
    } else {
      entries = [
        { assetType: opts.assetType, mediaUrl: opts.mediaUrl, copy: opts.copy },
      ];
    }

    const pageId = product.pageId ?? company.meta!.pageId ?? '';
    const specialAdCategories =
      (company.meta as any)?.specialAdCategories ?? [];

    // Single-creative mode keeps the EXACT historical fixed ad name (no
    // headline suffix) — only sheet mode (many ads at once, `name` doesn't
    // make sense per-ad) switches to a per-entry headline-based name.
    const fixedAdName =
      opts.name?.trim() ||
      `${adSetName} — manual ${new Date().toISOString().split('T')[0]}`;
    const adNameFor =
      'sheetId' in opts
        ? (entry: AdEntry) => `${adSetName} — ${entry.copy.headline || 'ad'}`
        : () => fixedAdName;

    const { createdAds, failed } = await this.createAdsForEntries(
      opts.adSetId,
      entries,
      company.meta!.accessToken,
      adNameFor,
      (adName) =>
        withUtmParams(landingUrl, {
          campaignName: campaign.name ?? String(campaign._id),
          adSetName,
          adName,
        }),
      pageId,
      specialAdCategories,
    );

    if (createdAds.length === 0) {
      throw new Error(
        failed[0]?.error
          ? `No ads could be created: ${failed[0].error}`
          : 'No ads could be created.',
      );
    }

    this.logger.log(
      `Manual creative added: tenantId=${company.tenantId} campaign=${campaign._id} adSet=${opts.adSetId} created=${createdAds.length} failed=${failed.length} skippedCarousel=${skippedCarousel}`,
    );

    return {
      adId: createdAds[0].adId,
      creativeId: createdAds[0].creativeId,
      createdAds,
      failed,
      skippedCarousel,
    };
  }
}
