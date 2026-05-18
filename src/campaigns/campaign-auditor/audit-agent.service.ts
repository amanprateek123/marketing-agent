import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { buildSkillBlock, skillsForAgent } from '../../common/skills/agent-skill-map';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { AuditSignalPacket } from './signal-detector.service';
import { AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';
import { ShadowActionService } from '../../learning/shadow-action.service';

export interface AuditVerdict {
  verdict: 'watch' | 'act' | 'no_action';
  urgency: 'immediate' | '48h' | '7d' | null;
  contextInsight: string;       // Why this verdict — the "so what" in plain English
  watchSignals: string[];        // Signals to monitor next audit
  recommendedActions: {
    type:
      | 'pause_ad'
      | 'pause_adset'
      | 'scale_adset'
      | 'replace_creative'
      | 'add_creative'
      | 'add_adset'
      | 'shift_budget_between_adsets'
      | 'reduce_total_budget'
      | 'narrow_placement'
      | 'dayparting'
      | 'refresh_audience';
    targetId: string;
    targetName: string;
    reason: string;
    priority: 'high' | 'medium' | 'low';
    params?: Record<string, any>;  // action-specific params
  }[];
}

const buildDefaultAuditSystemPrompt = (companyName: string) => `You are a senior performance marketing analyst at ${companyName} auditing a live Meta Ads campaign. You have full visibility at CAMPAIGN, AD SET, and AD level — just like Ads Manager.

You receive:
1. Campaign-level metrics (total spend, CTR, ROAS, conversions)
2. Per-ad-set breakdown (each ad set's spend, conversions, CTR, CPA, ROAS, frequency, audience type)
3. Per-ad breakdown (each ad's spend, conversions, CTR, CPC, hookStyle)
4. Hook style performance summary (which creative angle is working)
5. Funnel diagnostic (high clicks + zero conversions = landing page problem, not creative)
6. Trend signals, benchmarks, anomalies, and opportunities

Your job is to produce a structured verdict:
- "no_action": Campaign is performing within expectations, no changes needed
- "watch": Concerning signals but not yet critical — flag for next audit
- "act": Clear problem OR opportunity requiring action

PROBLEM actions (cut waste):
- "pause_ad": Pause a specific ad with zero conversions and high spend
- "pause_adset": Pause an entire ad set burning budget with no return
- "replace_creative": Swap out a fatigued creative (CTR dropped >35% from baseline)

GROWTH actions (scale winners):
- "scale_adset": Increase budget on a winning ad set (ROAS > 1.5x, 2+ conversions)
- "add_creative": Add a FRESH ad to a winning ad set that shows early fatigue (CTR declining but still converting). Keep existing ads running — this adds alongside them, not replaces.
- "add_adset": Add a new ad set to the campaign. Use when: (a) retargeting — campaign has >100 clicks but low conversions after 7+ days, add retarget ad set for website visitors; (b) narrowing — winning demographic identified, add targeted ad set

REBALANCE actions (no extra spend, redistribute within the same campaign):
- "shift_budget_between_adsets": Move budget % from a losing ad set to a winning one INSIDE the same campaign. Total campaign budget unchanged. Use this BEFORE pausing a losing ad set if a clear winner exists in the same campaign — you keep both alive, just feed the winner more. Set targetId = fromAdSetId (the losing/donor ad set), params.toAdSetId = the winning/recipient ad set, params.shiftPercent = how much of the donor's CURRENT budget % to move (e.g. 50 means move half of the donor's allocation to the recipient). Cap: TS will clamp to ≤50% per shift. Recipient must have ≥10 conversions (TS will drop the action otherwise).

THROTTLE actions (less drastic than pause — prefer these BEFORE pausing):
- "reduce_total_budget": Cut the campaign's daily budget by a percentage. Use when overall ROAS is degrading but the campaign isn't broken — throttle without killing. Set targetId = campaign metaCampaignId, params.reductionPercent = 20-50. Cap: TS clamps at 50% reduction.
- "narrow_placement": Disable bleeding placements without pausing the whole ad set. Common patterns:
    - Reels-only Instagram: publisherPlatforms=['instagram'], instagramPositions=['reels']
    - Feed-only across both: publisherPlatforms=['facebook','instagram'], facebookPositions=['feed'], instagramPositions=['stream']
    - Drop Audience Network (most common bleeder): publisherPlatforms=['facebook','instagram'] (omit audience_network)
    - No Stories: publisherPlatforms=['facebook','instagram'], facebookPositions=['feed','video_feeds','marketplace'], instagramPositions=['stream','reels','explore']
  Set targetId = ad set ID. Allowed publisherPlatforms values: 'facebook','instagram','audience_network','messenger'.
- "dayparting": Restrict delivery to specific hours/days. Times are in IST (the agent only runs against Asia/Kolkata ad accounts; non-IST accounts will refuse the action). Use when off-peak hours (1am-6am IST) burn budget without converting, OR when a B2B/edtech audience converts only during work hours. Set targetId = ad set ID, params.schedule = array of {startMinute, endMinute, days}. Minutes are 0-1440 from midnight IST. Days are 0-6 (Sun-Sat). Useful patterns:
    - India consumer peak (9pm-12am IST): {startMinute: 1260, endMinute: 1440, days: [0,1,2,3,4,5,6]}
    - Morning commute (8-10am IST): {startMinute: 480, endMinute: 600, days: [0,1,2,3,4,5,6]}
    - B2B work hours (10am-7pm, Mon-Fri): {startMinute: 600, endMinute: 1140, days: [1,2,3,4,5]}
    - To span midnight, USE TWO SLOTS — Meta does not accept startMinute > endMinute. e.g. 10pm-2am = [{1320, 1440, days}, {0, 120, days}].

REFRESH actions (when audience is fatigued but creative is good):
- "refresh_audience": Duplicate a fatigued ad set with a fresh audience, keeping the same creative. Use when frequency is high (>4.5) but CTR is NOT declining (meaning the creative is still performing — it's the audience that's saturated). Resets Meta's learning phase on the new audience while preserving the proven creative. Set targetId = source (fatigued) ad set ID, EITHER params.newAudienceId = numeric Meta custom/lookalike audience ID OR params.useAdvantagePlus = true (switch to Advantage+ targeting). TS will REFUSE the action if frequency < 4.5 OR CTR is declining (in those cases use replace_creative or pause_adset).

═══ ACTION PRIORITY ORDER ═══
When multiple actions could fit the same problem, prefer LESS DESTRUCTIVE first:
1. THROTTLE (narrow_placement / dayparting / reduce_total_budget) before PAUSE (pause_ad / pause_adset).
2. REBALANCE (shift_budget_between_adsets) before PAUSE — if a clear winner exists in the same campaign with ≥10 conversions, move budget to it instead of pausing the loser.
3. PROBLEM (cut waste) before GROWTH (scale).
4. The most reversible action that addresses the root cause wins.

Concrete triage when CTR is okay but CPA is creeping up:
  → If a placement is the cause, narrow_placement.
  → If off-hours/wrong days are the cause, dayparting.
  → If account-wide CPMs are spiking (see MARKET ENVIRONMENT block), reduce_total_budget — the cause is exogenous, don't blame the creative.
  → If cause is genuinely unclear and CPA < 1.5× benchmark, reduce_total_budget at 30%.
  → Only pause_adset if CPA > 2× benchmark AND none of the above apply.

Guidelines:
TIMING RULES — respect these strictly:
- Day 0-3 (first 72h): WATCH ONLY. Do NOT recommend pause or act. Zero conversions is NORMAL — the campaign hasn't spent enough for a statistically meaningful result. Only exception: safety rail breaches (budget cap, weekly cap).
- Day 3-7: Watch + pause losing ads/ad sets (zero conversions after 3x CPA spent on that ad set). No growth actions yet.
- Day 7+: Growth actions unlock (add_creative, add_adset, scale_adset).

ACTION TRIGGERS:
- Creative fatigue with >35% CTR drop → replace_creative (day 3+)
- Winning ad set with 15-35% CTR decline but still converting → add_creative (day 7+)
- >100 clicks + <3 conversions after 7 days → add_adset retarget (day 7+)
- Ad set at >1.5x ROAS with 2+ conversions → scale_adset (day 7+)
- Ad set spent >3x expected CPA with zero conversions → pause_adset (day 3+, NOT before)
- NEVER pause an entire campaign in the first 72 hours unless a safety rail is breached

ANALYSIS FRAMEWORK (check in this order):
1. FUNNEL CHECK: High CTR + zero conversions = landing page / pixel problem, NOT creative or audience. Flag this clearly — don't recommend pausing ads when the issue is post-click.
2. AD SET LEVEL: Compare ad sets. Which is winning? Which is bleeding? At day 3+, pause bleeders. At day 7+, scale winners.
3. AD LEVEL: Within each ad set, which hookStyle has the best CTR and conversions? Which ads are dead weight? Pause individual ads before pausing entire ad sets.
4. CREATIVE DIAGNOSIS: If one hookStyle consistently outperforms across ad sets, recommend add_creative with that style in other ad sets. If a hook is dying everywhere, it's the creative, not the audience.
5. BUDGET EFFICIENCY: Is spend concentrated on the right ads/ad sets, or is Meta spreading thin across losers?

Output ONLY valid JSON in this exact format:
{
  "verdict": "watch" | "act" | "no_action",
  "urgency": "immediate" | "48h" | "7d" | null,
  "contextInsight": "one or two sentences explaining the key finding",
  "watchSignals": ["signal 1", "signal 2"],
  "recommendedActions": [
    {
      "type": "pause_ad" | "pause_adset" | "scale_adset" | "replace_creative" | "add_creative" | "add_adset" | "shift_budget_between_adsets" | "reduce_total_budget" | "narrow_placement" | "dayparting" | "refresh_audience",
      "targetId": "EXACT numeric Meta ID from the data above (e.g. 120241731996240278) — NOT a slug or name. For add_adset and reduce_total_budget use the campaign ID. For shift_budget_between_adsets use the DONOR (losing) ad set ID. For refresh_audience use the SOURCE (fatigued) ad set ID.",
      "targetName": "human readable name",
      "reason": "specific reason for this action",
      "priority": "high" | "medium" | "low",
      "params": {
        "// For add_creative": "hookStyle: string (new hook to use)",
        "// For add_adset": "audienceType: 'retarget' | 'narrowed', targeting: { ageMin, ageMax, geoLocations }",
        "// For shift_budget_between_adsets": "toAdSetId: string (recipient ad set), shiftPercent: number (1-50, % of donor's current budget % to move)",
        "// For reduce_total_budget": "reductionPercent: number (1-50, % of total daily budget to cut)",
        "// For narrow_placement": "publisherPlatforms: string[] (e.g. ['facebook','instagram']), optional: facebookPositions, instagramPositions, audienceNetworkPositions arrays",
        "// For dayparting": "schedule: array of { startMinute: 0-1440, endMinute: 0-1440, days: number[] (0-6, Sun-Sat) }",
        "// For refresh_audience": "EITHER newAudienceId: string (numeric Meta audience ID — use a DIFFERENT lookalike % or custom audience than the source), OR useAdvantagePlus: true (switch source to Advantage+ targeting)"
      }
    }
  ]
}`;

/**
 * Pick the LAST balanced JSON object out of LLM output. Handles three failure modes
 * the previous greedy regex didn't:
 *   1. Multiple objects (commentary + verdict): returns the final one.
 *   2. Strings containing braces: skips braces inside JSON string literals.
 *   3. Fenced ```json blocks: still works because we scan the raw text.
 */
function extractLastJsonObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastStart = -1;
  let lastEnd = -1;
  let currentStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) currentStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && currentStart >= 0) {
        lastStart = currentStart;
        lastEnd = i;
        currentStart = -1;
      } else if (depth < 0) {
        depth = 0;       // recover from a stray closing brace
        currentStart = -1;
      }
    }
  }

  if (lastStart >= 0 && lastEnd > lastStart) {
    return text.slice(lastStart, lastEnd + 1);
  }
  return null;
}

@Injectable()
export class AuditAgentService {
  private readonly logger = new Logger(AuditAgentService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly shadowActions: ShadowActionService,
  ) {}

  async analyze(
    campaign: any,
    signals: AuditSignalPacket,
    snapshots: AuditSnapshotDocument[],
    company: CompanyDocument,
    liveSnapshot?: any,  // snapshotData with per-ad-set and per-ad metrics
  ): Promise<AuditVerdict> {
    const learnings = company.learnings;
    const caseStudies = (company as any).caseStudies ?? [];

    const context = this.buildContext(campaign, signals, snapshots, company, learnings, caseStudies, liveSnapshot);
    // Skill directive prepended so the LLM applies paid-ads + ab-test-setup
    // frameworks when reasoning about pause/scale/replace verdicts. Otherwise
    // the auditor defaults to generic CTR/ROAS thresholds and ignores
    // statistical guards (Wilson LB, learning-phase floors).
    const systemPrompt =
      buildSkillBlock('AUDIT_AGENT')
      + ((company.prompts as any)?.campaignAuditor || buildDefaultAuditSystemPrompt(company.name));
    // Tenant context goes in the user message (prepended under "## TENANT CONTEXT"), not the
    // system prompt. Keeps instructions vs data separated and prevents prompt-injection-style
    // bleed-through from tenant fields like calendarContext.
    const userContext = this.liveContextBuilder.build(company);

    try {
      const result = await this.claudeService.runAgent({
        tenantId: company.tenantId,
        agentType: AgentType.CAMPAIGN_AUDITOR,
        systemPrompt,
        liveContext: '',
        userContext,
        userMessage: context,
        maxTurns: 1,
        // Hidden CoT before emitting JSON-only verdict. Lets the model reason about
        // sample sizes, prior decisions, and alternatives without breaking the JSON contract.
        thinking: { type: 'enabled', budgetTokens: 4000 },
        skills: skillsForAgent('AUDIT_AGENT'),   // paid-ads + ab-test-setup loaded into auditor context
      });

      const verdict = this.parseVerdict(result.content);
      return this.applyBusinessGuards(verdict, liveSnapshot, campaign, company, signals);
    } catch (err: any) {
      this.logger.error(`Audit agent failed: ${err.message} — defaulting to watch`);
      return this.safeDefault(signals);
    }
  }

  /**
   * Post-parse business guards: drop actions whose semantics are valid JSON but
   * marketing-domain wrong. Today: shift_budget recipients must have ≥10 conversions
   * in the live snapshot, otherwise we'd be moving budget into noise.
   *
   * Every dropped action is logged as a shadow action so we can later evaluate
   * whether the block was correct (regret tracking — Phase 6 step 4).
   */
  private applyBusinessGuards(
    verdict: AuditVerdict,
    liveSnapshot: any,
    campaign: any,
    company: CompanyDocument,
    signals: AuditSignalPacket,
  ): AuditVerdict {
    const MIN_RECIPIENT_CONVERSIONS = 10;
    const liveAdSets = (liveSnapshot?.adSets ?? []) as any[];
    const liveCampaign = liveSnapshot ?? {};
    const banditLeaderId = signals.banditAllocation?.leader?.adSetId;
    const banditLeaderConfidence = signals.banditAllocation?.leaderConfidence ?? 0;

    const filtered = verdict.recommendedActions.filter(a => {
      if (a.type !== 'shift_budget_between_adsets') return true;
      const toAdSetId = a.params?.toAdSetId;
      const recipient = liveAdSets.find(as => as.metaAdSetId === toAdSetId);
      const recipientConv = Number(recipient?.conversions) || 0;
      if (recipientConv < MIN_RECIPIENT_CONVERSIONS) {
        this.logger.warn(
          `Dropping shift_budget action — recipient ${toAdSetId} has ${recipientConv} conversions (< ${MIN_RECIPIENT_CONVERSIONS}). Won't move budget into noise.`,
        );
        void this.shadowActions.recordBlocked({
          tenantId: company.tenantId,
          campaignId: campaign?._id?.toString() ?? campaign?.campaignId ?? '',
          metaCampaignId: campaign?.metaCampaignId ?? liveCampaign.metaCampaignId ?? '',
          proposedAction: {
            type: a.type, targetId: a.targetId, targetName: a.targetName,
            reason: a.reason, priority: a.priority, params: a.params,
          },
          blockedReason: 'recipient_thin_evidence',
          metricsAtT: this.snapshotToMetrics(liveCampaign),
        });
        return false;
      }

      // LLM-vs-bandit disagreement: action still runs (LLM may have context the bandit lacks),
      // but log the disagreement so we can later evaluate whose pick was correct.
      // Threshold: only log when the bandit had a confident leader (>=55%) AND the LLM picked
      // a different recipient. Below 55% confidence the bandit isn't confident either, so it's
      // not a real disagreement.
      if (banditLeaderId && banditLeaderConfidence >= 0.55 && String(toAdSetId) !== String(banditLeaderId)) {
        this.logger.log(
          `Bandit disagreement: LLM picked recipient ${toAdSetId}, bandit leader was ${banditLeaderId} (confidence ${(banditLeaderConfidence * 100).toFixed(0)}%) — action runs, disagreement logged`,
        );
        void this.shadowActions.recordBlocked({
          tenantId: company.tenantId,
          campaignId: campaign?._id?.toString() ?? campaign?.campaignId ?? '',
          metaCampaignId: campaign?.metaCampaignId ?? liveCampaign.metaCampaignId ?? '',
          proposedAction: {
            type: a.type, targetId: a.targetId, targetName: a.targetName,
            reason: a.reason, priority: a.priority,
            params: { ...a.params, banditLeaderId, banditLeaderConfidence },
          },
          blockedReason: 'bandit_disagreement',
          metricsAtT: this.snapshotToMetrics(liveCampaign),
        });
        // Don't filter — let the action through. Disagreement is data, not a veto.
      }

      return true;
    });
    return { ...verdict, recommendedActions: filtered };
  }

  private snapshotToMetrics(snapshot: any): any {
    return {
      spend: snapshot?.metrics?.spend ?? snapshot?.spend ?? 0,
      impressions: snapshot?.metrics?.impressions ?? snapshot?.impressions ?? 0,
      clicks: snapshot?.metrics?.clicks ?? snapshot?.clicks ?? 0,
      conversions: snapshot?.metrics?.conversions ?? snapshot?.conversions ?? 0,
      ctr: snapshot?.metrics?.ctr ?? snapshot?.ctr ?? 0,
      cpc: snapshot?.metrics?.cpc ?? snapshot?.cpc ?? 0,
      cpa: snapshot?.metrics?.cpa ?? snapshot?.cpa ?? 0,
      roas: snapshot?.metrics?.roas ?? snapshot?.roas ?? 0,
      frequency: snapshot?.metrics?.frequency ?? snapshot?.frequency ?? 0,
      // Per-ad-set baseline — needed for shift_budget regret evaluation at +72h
      // (recipient's conversion delta vs. baseline tells us if the LLM's pick was right).
      adSets: Array.isArray(snapshot?.adSets) ? snapshot.adSets.map((as: any) => ({
        adSetId: as.metaAdSetId ?? as.adSetId,
        spend: as.spend ?? 0,
        clicks: as.clicks ?? 0,
        conversions: as.conversions ?? 0,
        ctr: as.ctr ?? 0,
        cpa: as.cpa ?? 0,
      })) : [],
    };
  }

  private buildContext(
    campaign: any,
    signals: AuditSignalPacket,
    snapshots: AuditSnapshotDocument[],
    company: CompanyDocument,
    learnings: any,
    caseStudies: any[],
    liveSnapshot?: any,
  ): string {
    const age = signals.campaignAge;
    const curr = campaign;

    // ── Per-ad-set breakdown (like Ads Manager view) ──────────────────────────
    const adSetLines = (liveSnapshot?.adSets ?? []).map((as: any) => {
      const verdict = as.conversions > 0 && as.roas > 1.5 ? '🟢 WINNING'
        : as.conversions === 0 && as.spend > 500 ? '🔴 ZERO CONV'
        : as.roas > 0 && as.roas < 0.8 ? '🟡 LOW ROAS'
        : '⚪ LEARNING';
      return `  ${verdict} | ${as.name} [${as.metaAdSetId}]
    Audience: ${as.audienceType || 'advantage_plus'} | Spend: ₹${as.spend?.toFixed(0)} | Conv: ${as.conversions} | CTR: ${as.ctr?.toFixed(2)}% | CPA: ₹${as.cpa?.toFixed(0) || '∞'} | ROAS: ${as.roas?.toFixed(2) || '0.00'}x | Freq: ${as.frequency?.toFixed(1)}`;
    }).join('\n');

    // ── Per-ad breakdown (creative performance) ──────────────────────────────
    const adLines = (liveSnapshot?.ads ?? []).map((ad: any) => {
      const hookLabel = ad.hookStyle ? `(${ad.hookStyle})` : '';
      const convLabel = ad.conversions > 0 ? `🟢 ${ad.conversions} conv` : ad.spend > 300 ? '🔴 0 conv' : '⚪ testing';
      return `  ${ad.name} ${hookLabel} [${ad.metaAdId}] → adSet ${ad.adSetId}
    ${convLabel} | Spend: ₹${ad.spend?.toFixed(0)} | CTR: ${ad.ctr?.toFixed(2)}% | CPC: ₹${ad.cpc?.toFixed(0)}`;
    }).join('\n');

    // ── Hook style performance summary ───────────────────────────────────────
    const hookMap = new Map<string, { spend: number; clicks: number; conversions: number; impressions: number }>();
    for (const ad of liveSnapshot?.ads ?? []) {
      const hook = ad.hookStyle || 'unknown';
      const entry = hookMap.get(hook) ?? { spend: 0, clicks: 0, conversions: 0, impressions: 0 };
      entry.spend += ad.spend ?? 0;
      entry.conversions += ad.conversions ?? 0;
      // Estimate clicks from CTR and impressions if not directly available
      hookMap.set(hook, entry);
    }
    const hookSummary = [...hookMap.entries()]
      .filter(([h]) => h !== 'unknown')
      .map(([hook, d]) => `  ${hook}: ₹${d.spend.toFixed(0)} spent, ${d.conversions} conversions`)
      .join('\n');

    // ── Diagnostic: creative problem vs funnel problem ────────────────────────
    const totalClicks = signals.opportunities.totalClicks;
    const totalConv = curr.conversions ?? 0;
    const clickToConvRate = totalClicks > 0 ? (totalConv / totalClicks * 100).toFixed(1) : '0.0';
    const diagnosticLine = totalClicks > 50 && totalConv === 0
      ? `⚠ FUNNEL ISSUE: ${totalClicks} clicks but 0 conversions — CTR is healthy (${curr.ctr?.toFixed(2)}%), problem is likely post-click (landing page, pixel firing, checkout flow)`
      : totalClicks > 50 && totalConv > 0
      ? `Click→Conv rate: ${clickToConvRate}% (${totalConv}/${totalClicks})`
      : '';

    // ── Anomalies ────────────────────────────────────────────────────────────
    const anomalies = signals.anomalies;
    const anomalyLines: string[] = [];
    if (anomalies.highSpendZeroConversions.length > 0) {
      anomalyLines.push(`HIGH SPEND ZERO CONVERSIONS: ${anomalies.highSpendZeroConversions.map(a => `${a.adSetName} [${a.adSetId}] (₹${a.spend})`).join(', ')}`);
    }
    if (anomalies.creativeFatigue.length > 0) {
      anomalyLines.push(`CREATIVE FATIGUE: ${anomalies.creativeFatigue.map(a => `${a.adId} [${a.hookStyle}] CTR dropped ${a.ctrDrop}% (residual after market adjustment: ${a.residualDrop}%)`).join(', ')}`);
    }
    if (anomalies.audienceFatigue.length > 0) {
      anomalyLines.push(`AUDIENCE FATIGUE: ${anomalies.audienceFatigue.map(a => `${a.adSetName} [${a.adSetId}] freq=${a.frequency.toFixed(1)}`).join(', ')}`);
    }
    if (anomalies.campaignZeroConversions) anomalyLines.push(`ZERO CONVERSIONS: ₹${campaign.spend?.toFixed(0) ?? 0} spent (>1 day budget) with 0 conversions`);
    if (anomalies.stuckInLearning) anomalyLines.push('STUCK IN LEARNING: 0 conversions after learning phase');
    if (anomalies.budgetExhaustionRisk) anomalyLines.push('BUDGET EXHAUSTION: spending >15% above expected daily pace');
    if (anomalies.unprofitableAfterDay3) {
      const be = signals.breakeven;
      anomalyLines.push(
        `CHRONIC UNPROFITABLE: observed ROAS ${campaign.roas?.toFixed(2) ?? 0} on ₹${campaign.spend?.toFixed(0) ?? 0} spend; ` +
        `breakeven ROAS for this product is ${be.breakevenROAS.toFixed(2)} (margin ${(be.margin * 100).toFixed(0)}%, source: ${be.source}). ` +
        `Shrunken + upper 95% ROAS both below breakeven with ≥3 conversions of data — not noise. ` +
        `Action: pause the worst-ROAS ad set first; if CTR is below benchmark, replace_creative instead of pausing the whole campaign.`,
      );
    }
    if (anomalies.conversionDataIntegrity?.missingConversionValue) {
      anomalyLines.push(
        `DATA INTEGRITY (blocks profitability check): product "${anomalies.conversionDataIntegrity.productName ?? 'active'}" has no conversionValue set, ` +
        `so ROAS is uncomputable on ₹${anomalies.conversionDataIntegrity.spend.toFixed(0)} of spend. ` +
        `Verdict should be no_action with contextInsight flagging the config gap — do not pause until value is set.`,
      );
    }

    // ── Snapshot history (with prior verdicts so the agent isn't stateless) ──
    // Filter out synthetic verdicts written by the cooldown / all-green short-circuits.
    // Those weren't real Claude decisions — feeding them into the consistency nudge
    // would anchor the agent to "no_action" purely because the recent history was quiet.
    const isSyntheticVerdict = (s: AuditSnapshotDocument) => {
      const insight = s.verdict?.contextInsight ?? '';
      return /\| Cooldown — | No anomalies — agent skipped$/.test(insight);
    };
    const snapshotSummary = snapshots
      .filter(s => !isSyntheticVerdict(s))
      .slice(0, 5)
      .map((s, i) => {
        const d = new Date(s.auditedAt);
        const metricsLine = `spend=₹${s.metrics.spend.toFixed(0)} ctr=${s.metrics.ctr.toFixed(2)}% roas=${s.metrics.roas.toFixed(2)}x conv=${s.metrics.conversions}`;
        if (!s.verdict) {
          return `  Audit ${i + 1} (${d.toLocaleDateString()}): ${metricsLine} | verdict=none`;
        }
        const v = s.verdict;
        const actionSummary = v.recommendedActions?.length
          ? v.recommendedActions.map((a) => {
              const target = a.targetName || a.targetId;
              if (a.type === 'shift_budget_between_adsets' && a.params) {
                const toRef = a.params.toAdSetId ?? '?';
                const pct = a.params.shiftPercent ?? '?';
                return `${a.type}: ${target}→${toRef} @${pct}%`;
              }
              return `${a.type}→${target}`;
            }).join(', ')
          : 'no actions';
        const insight = v.contextInsight ? ` — "${v.contextInsight.slice(0, 140)}"` : '';
        return `  Audit ${i + 1} (${d.toLocaleDateString()}): ${metricsLine}\n    verdict=${v.verdict}${v.urgency ? `/${v.urgency}` : ''} | ${actionSummary}${insight}`;
      })
      .join('\n') || '  No prior snapshots';

    // ── Case studies ─────────────────────────────────────────────────────────
    const relevantCases = caseStudies
      .filter((cs: any) => cs.verdict === 'act' || cs.outcome === 'paused' || cs.outcome === 'scaled')
      .slice(0, 3)
      .map((cs: any) => `  - ${cs.topic ?? ''}: ${cs.contextInsight ?? cs.summary ?? ''}`)
      .join('\n');

    return `=== CAMPAIGN AUDIT ===

CAMPAIGN: ${campaign.name ?? campaign.metaCampaignId}
Meta Campaign ID: ${campaign.metaCampaignId}
Objective: ${campaign.objective}
Age: ${age.hours}h (${age.days} days) | ${age.inLearningPhase ? 'IN LEARNING PHASE' : 'POST LEARNING PHASE'}
Daily Budget: ₹${campaign.budget}/day | Spend pace: ${signals.trends.spendPace}
Historical CPA: ₹${(company.products ?? []).find((p: any) => p.active)?.performance?.avgCPA ?? 'unknown'}

━━━ CAMPAIGN METRICS (live) ━━━
  Spend: ₹${curr.spend?.toFixed(0) ?? 0} | Impressions: ${curr.impressions ?? 0} | Clicks: ${totalClicks}
  CTR: ${curr.ctr?.toFixed(2) ?? 0}% | CPC: ₹${curr.cpc?.toFixed(0) ?? 0}
  Conversions: ${totalConv} | ROAS: ${curr.roas?.toFixed(2) ?? 0}x | Frequency: ${curr.frequency?.toFixed(1) ?? 0}
${diagnosticLine ? `\n  ${diagnosticLine}` : ''}

━━━ AD SET BREAKDOWN (${(liveSnapshot?.adSets ?? []).length} ad sets) ━━━
${adSetLines || '  No ad set data'}

━━━ AD / CREATIVE BREAKDOWN (${(liveSnapshot?.ads ?? []).length} ads) ━━━
${adLines || '  No ad data'}

${hookSummary ? `━━━ HOOK STYLE PERFORMANCE ━━━\n${hookSummary}\n` : ''}
━━━ TRENDS (last 3 audits) ━━━
  CTR: ${signals.trends.ctrTrend} | ROAS: ${signals.trends.roasTrend} | Frequency: ${signals.trends.frequencyTrend}

${signals.marketEnvironment ? `━━━ MARKET ENVIRONMENT (account-level, last 7d vs prior 7d) ━━━
  CPM: ₹${signals.marketEnvironment.last7CPM.toFixed(0)} vs ₹${signals.marketEnvironment.prior7CPM.toFixed(0)} (${signals.marketEnvironment.cpmChangePct >= 0 ? '+' : ''}${signals.marketEnvironment.cpmChangePct.toFixed(0)}%) | trend: ${signals.marketEnvironment.trend}
  CPC change: ${signals.marketEnvironment.cpcChangePct >= 0 ? '+' : ''}${signals.marketEnvironment.cpcChangePct.toFixed(0)}%
  CTR change: ${signals.marketEnvironment.ctrChangePct >= 0 ? '+' : ''}${signals.marketEnvironment.ctrChangePct.toFixed(0)}% (account-level, last 7d vs prior 7d)
  RULE: If trend == 'spiking' OR 'rising', CPM/CTR degradation is at least partly EXOGENOUS (auction got harder for everyone). In that case:
    - DO NOT pause_ad / pause_adset on degradation alone — the creative isn't broken, the auction is.
    - Prefer reduce_total_budget (20-30%) to ride out the spike, or narrow_placement to drop expensive inventory.
    - Only override this rule if CPA > 2.5× benchmark (truly broken regardless of market).
  RULE: If trend == 'falling', CPMs are crashing — this is a green light to scale winners aggressively.
  RULE (DiD on creative fatigue): If account CTR change is meaningfully negative (≤ -15%), the account-wide audience is just less responsive this week. Do NOT recommend replace_creative on CTR drop alone — the residual after market adjustment is what matters. The CREATIVE FATIGUE anomaly already shows the residual; trust it, not the raw drop %.
` : ''}━━━ BENCHMARKS (${company.name} | vertical: ${company.industry || 'unknown'}) ━━━
  Expected CTR: ${signals.benchmarks.expectedCTRRange ? `${signals.benchmarks.expectedCTRRange.min.toFixed(2)}–${signals.benchmarks.expectedCTRRange.max.toFixed(2)}%` : 'no benchmark'} | current: ${signals.benchmarks.currentCTRVsBenchmark}
  Expected CPA: ${signals.benchmarks.expectedCPARange ? `₹${signals.benchmarks.expectedCPARange.min.toFixed(0)}–₹${signals.benchmarks.expectedCPARange.max.toFixed(0)}` : 'no benchmark'} | current: ${signals.benchmarks.currentCPAVsBenchmark}
  Best audience type: ${signals.benchmarks.bestAudienceType ?? 'unknown'}
  Evidence floors (vertical-derived): ≥${signals.evidenceFloors.impressionsForCtrSignal} impressions for CTR signal, ≥${signals.evidenceFloors.clicksForZeroConvSignal} clicks before "zero-conv" is meaningful, ≥${signals.evidenceFloors.clicksForRetargetTrigger} clicks before retarget. Below these the data is too noisy to act on.
  (Winning hooks and other learnings are in the TENANT CONTEXT block above.)

━━━ ANOMALIES ━━━
${anomalyLines.length > 0 ? anomalyLines.map(l => `  ⚠ ${l}`).join('\n') : '  None'}

━━━ OPPORTUNITIES ━━━
${signals.opportunities.winningAdSets.length > 0 ? signals.opportunities.winningAdSets.map(w => `  ✅ WINNING: ${w.adSetName} (${w.adSetId}) — observed ROAS ${w.roas.toFixed(2)}x, shrunken ${w.shrunkenROAS.toFixed(2)}x (lower 95: ${w.lowerROAS.toFixed(2)}x), CTR ${w.ctr.toFixed(2)}%, ${w.conversions} conv`).join('\n') : '  No winning ad sets yet (posterior-based: requires shrunken ROAS > scale threshold AND lower 95% > 1.0x)'}

${signals.banditAllocation ? `━━━ THOMPSON ALLOCATION (bandit recommendation across ${signals.banditAllocation.allocations.length} active ad sets, ${signals.banditAllocation.trials} Monte Carlo trials) ━━━
${signals.banditAllocation.allocations.map(a => `  ${a.adSetName} (${a.adSetId}): pBest ${(a.pBest * 100).toFixed(0)}% → recommended ${a.recommendedPct}% of campaign budget | E[ROAS] ${a.expectedROAS.toFixed(2)}x | posterior CVR ${(a.posteriorMeanCVR * 100).toFixed(2)}%`).join('\n')}
  Leader: ${signals.banditAllocation.leader?.adSetName ?? 'none'} (confidence ${(signals.banditAllocation.leaderConfidence * 100).toFixed(0)}%)
  RULE: When proposing shift_budget_between_adsets, the recipient (params.toAdSetId) SHOULD match the bandit's leader unless you have a specific reason to override (e.g. seasonal context, recent major change). If you override, state the reason explicitly in the action's reason field — disagreements are logged for review.
  RULE: If leaderConfidence < 55%, the bandit is uncertain — exploration matters more than exploitation. PREFER continuing to observe over a shift_budget action this cycle.
` : ''}
${signals.opportunities.earlyFatigue.length > 0 ? signals.opportunities.earlyFatigue.map(f => `  ⚡ EARLY FATIGUE: ${f.adSetName} (${f.adSetId}) — CTR declining ${f.ctrDrop}%`).join('\n') : ''}
${signals.opportunities.readyForRetarget ? `  🎯 RETARGET READY: ${totalClicks} clicks, ${totalConv} conv after ${age.days} days` : ''}

${signals.breakdowns.byPlacement.length > 0 ? `━━━ PLACEMENT BREAKDOWN (top 5 by spend) ━━━
${signals.breakdowns.byPlacement
  .slice()
  .sort((a, b) => b.spend - a.spend)
  .slice(0, 5)
  .map(p => {
    const verdict = p.conversions > 0 && p.cpa > 0 && p.cpa < (signals.benchmarks.expectedCPARange?.max ?? Infinity) ? '🟢'
      : p.conversions === 0 && p.spend > 300 ? '🔴'
      : '⚪';
    return `  ${verdict} ${p.publisherPlatform}/${p.platformPosition}: ₹${p.spend.toFixed(0)} | ${p.clicks} clicks | ${p.conversions} conv | CTR ${p.ctr.toFixed(2)}% | CPA ${p.cpa > 0 ? `₹${p.cpa.toFixed(0)}` : '∞'}`;
  })
  .join('\n')}
  RULE: When proposing narrow_placement, base it on this data. If a 🔴 placement has spent >₹500 with 0 conv, exclude it. If one 🟢 placement is dominating conversions, narrow to it.
` : ''}
${signals.breakdowns.byHour.length > 0 ? `━━━ HOURLY BREAKDOWN (last 14d, top 6 by spend; ad-account TZ) ━━━
${signals.breakdowns.byHour
  .slice()
  .sort((a, b) => b.spend - a.spend)
  .slice(0, 6)
  .map(h => `  ${h.hourOfDay}: ₹${h.spend.toFixed(0)} | ${h.clicks} clicks | ${h.conversions} conv | CTR ${h.ctr.toFixed(2)}% | CPA ${h.cpa > 0 ? `₹${h.cpa.toFixed(0)}` : '∞'}`)
  .join('\n')}
  RULE: When proposing dayparting, identify the loss hours (high spend, 0 conv, low CTR) and exclude them. Don't dayparting based on prompt examples — use this data.
` : ''}
${signals.hookSaturation.length > 0 ? (() => {
  // Group by audienceType for compact rendering. Show audiences with ≥1k impressions
  // (smaller pools have unreliable saturation %).
  const byAudience = new Map<string, typeof signals.hookSaturation>();
  for (const h of signals.hookSaturation) {
    if (h.audienceTotalImpressions < 1000) continue;
    const list = byAudience.get(h.audienceType) ?? [];
    list.push(h);
    byAudience.set(h.audienceType, list);
  }
  if (byAudience.size === 0) return '';
  const lines: string[] = ['━━━ HOOK SATURATION (% of audience impressions per hookStyle) ━━━'];
  for (const [audience, hooks] of byAudience.entries()) {
    const total = hooks[0].audienceTotalImpressions;
    const formatted = hooks
      .sort((a, b) => b.saturationPct - a.saturationPct)
      .map(h => {
        const tag = h.saturationPct >= 70 ? ' ⚠ SATURATED'
          : h.saturationPct >= 40 ? ' (heavy)'
          : h.saturationPct <= 15 ? ' (fresh)'
          : '';
        return `${h.hookStyle} ${h.saturationPct}%${tag}`;
      })
      .join(', ');
    lines.push(`  ${audience} (${total.toLocaleString()} imp): ${formatted}`);
  }
  lines.push(`  RULE: When proposing replace_creative or add_creative, prefer a hookStyle marked (fresh) on the target audience. Avoid SATURATED hooks (≥70%) — the audience has been hammered with that angle and conversion will degrade even if individual ad CTR still looks fine. Hook diversity beats hook depth.`);
  return lines.join('\n') + '\n';
})() : ''}
${signals.breakdowns.byDayOfWeek.length > 0 ? (() => {
  // Compute campaign-average CVR to flag strong/weak days as ratios.
  const totalConv = signals.breakdowns.byDayOfWeek.reduce((s, d) => s + d.conversions, 0);
  const totalClicks = signals.breakdowns.byDayOfWeek.reduce((s, d) => s + d.clicks, 0);
  const avgCVR = totalClicks > 0 ? (totalConv / totalClicks) * 100 : 0;
  // Use the vertical-aware click floor — same threshold the system uses for
  // "zero conversions is meaningful" elsewhere. For fintech (~99 clicks) we need
  // more evidence per DOW than spirituality (~49 clicks).
  const dowEvidenceFloor = signals.evidenceFloors.clicksForZeroConvSignal;
  return `━━━ DAY-OF-WEEK PATTERN (last 14d aggregate; ad-account TZ) ━━━
${signals.breakdowns.byDayOfWeek.map(d => {
  const cvrRatio = avgCVR > 0 ? d.cvr / avgCVR : 1;
  const tag = cvrRatio >= 1.5 ? '🟢 STRONG'
    : cvrRatio <= 0.5 && d.clicks >= dowEvidenceFloor ? '🔴 WEAK'
    : '⚪';
  return `  ${tag} ${d.dayLabel}: ₹${d.spend.toFixed(0)} | ${d.clicks} clicks | ${d.conversions} conv | CVR ${d.cvr.toFixed(2)}% (${cvrRatio.toFixed(2)}× avg) | CPA ${d.cpa > 0 ? `₹${d.cpa.toFixed(0)}` : '∞'}`;
}).join('\n')}
  Campaign avg CVR: ${avgCVR.toFixed(2)}% | DOW evidence floor: ${dowEvidenceFloor} clicks
  RULE: When proposing dayparting, the schedule's days array MUST reflect this pattern. STRONG days (≥1.5× avg CVR) should always be included; WEAK days (≤0.5× avg with ≥${dowEvidenceFloor} clicks of evidence) should be excluded. Defer to observed data; ignore prior assumptions about the vertical's "auspicious" days.
`;
})() : ''}
━━━ PRIOR AUDIT DECISIONS (most recent first; cooldown/skip entries excluded) ━━━
${snapshotSummary}
  (In the contextInsight, briefly state whether your verdict aligns with or reverses the prior decisions, and why. Both directions need explanation — do not default to consistency.)

${relevantCases ? `━━━ CASE STUDIES ━━━\n${relevantCases}\n` : ''}
=== END AUDIT DATA ===

Analyze at CAMPAIGN, AD SET, and AD level. Produce your verdict JSON.`;
  }

  private parseVerdict(output: string): AuditVerdict {
    try {
      const jsonText = extractLastJsonObject(output);
      if (!jsonText) throw new Error('No JSON object found in output');
      const parsed = JSON.parse(jsonText);

      return {
        verdict: ['watch', 'act', 'no_action'].includes(parsed.verdict) ? parsed.verdict : 'watch',
        urgency: ['immediate', '48h', '7d', null].includes(parsed.urgency) ? parsed.urgency : null,
        contextInsight: typeof parsed.contextInsight === 'string' ? parsed.contextInsight : '',
        watchSignals: Array.isArray(parsed.watchSignals) ? parsed.watchSignals : [],
        recommendedActions: Array.isArray(parsed.recommendedActions)
          ? parsed.recommendedActions
            .filter((a: any) => {
              if (!a.type || !a.targetId) return false;
              if (!/^\d+$/.test(String(a.targetId))) {
                this.logger.warn(`Dropping action with invalid targetId: "${a.targetId}" (expected numeric Meta ID)`);
                return false;
              }
              if (a.type === 'shift_budget_between_adsets') {
                const toId = a.params?.toAdSetId;
                const shiftPct = Number(a.params?.shiftPercent);
                if (!toId || !/^\d+$/.test(String(toId))) {
                  this.logger.warn(`Dropping shift_budget action — missing/invalid params.toAdSetId`);
                  return false;
                }
                if (String(toId) === String(a.targetId)) {
                  this.logger.warn(`Dropping shift_budget action — donor and recipient are the same ad set`);
                  return false;
                }
                if (!Number.isFinite(shiftPct) || shiftPct <= 0 || shiftPct > 50) {
                  this.logger.warn(`Dropping shift_budget action — params.shiftPercent must be in (0, 50], got ${shiftPct}`);
                  return false;
                }
              }
              if (a.type === 'reduce_total_budget') {
                const pct = Number(a.params?.reductionPercent);
                if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
                  this.logger.warn(`Dropping reduce_total_budget — reductionPercent must be in (0, 50], got ${pct}`);
                  return false;
                }
              }
              if (a.type === 'narrow_placement') {
                const platforms = a.params?.publisherPlatforms;
                if (!Array.isArray(platforms) || platforms.length === 0) {
                  this.logger.warn(`Dropping narrow_placement — publisherPlatforms must be a non-empty array`);
                  return false;
                }
                const allowed = ['facebook', 'instagram', 'audience_network', 'messenger'];
                if (!platforms.every((p: any) => typeof p === 'string' && allowed.includes(p))) {
                  this.logger.warn(`Dropping narrow_placement — invalid platform in ${JSON.stringify(platforms)}`);
                  return false;
                }
              }
              if (a.type === 'dayparting') {
                const schedule = a.params?.schedule;
                if (!Array.isArray(schedule) || schedule.length === 0) {
                  this.logger.warn(`Dropping dayparting — schedule must be a non-empty array`);
                  return false;
                }
                const validSlot = (s: any) =>
                  Number.isFinite(s?.startMinute) && s.startMinute >= 0 && s.startMinute <= 1440 &&
                  Number.isFinite(s?.endMinute) && s.endMinute >= 0 && s.endMinute <= 1440 &&
                  s.endMinute > s.startMinute &&
                  Array.isArray(s?.days) && s.days.length > 0 &&
                  s.days.every((d: any) => Number.isInteger(d) && d >= 0 && d <= 6);
                if (!schedule.every(validSlot)) {
                  this.logger.warn(`Dropping dayparting — invalid schedule slots`);
                  return false;
                }
              }
              if (a.type === 'refresh_audience') {
                const newAudienceId = a.params?.newAudienceId;
                const useAdvantagePlus = a.params?.useAdvantagePlus === true;
                if (!useAdvantagePlus && (!newAudienceId || !/^\d+$/.test(String(newAudienceId)))) {
                  this.logger.warn(`Dropping refresh_audience — provide either numeric newAudienceId OR useAdvantagePlus=true`);
                  return false;
                }
                if (useAdvantagePlus && newAudienceId) {
                  this.logger.warn(`Dropping refresh_audience — provide ONE of newAudienceId or useAdvantagePlus, not both`);
                  return false;
                }
              }
              return true;
            })
            .map((a: any) => ({ ...a, params: a.params ?? {} }))
          : [],
      };
    } catch (err: any) {
      this.logger.warn(`Failed to parse audit verdict: ${err.message}`);
      return { verdict: 'watch', urgency: null, contextInsight: 'Verdict parsing failed — flagged for manual review', watchSignals: [], recommendedActions: [] };
    }
  }

  private safeDefault(signals: AuditSignalPacket): AuditVerdict {
    const hasUrgent =
      signals.anomalies.highSpendZeroConversions.length > 0 ||
      signals.anomalies.stuckInLearning ||
      signals.anomalies.unprofitableAfterDay3 ||
      signals.safetyBreaches.campaignCapExceeded;

    return {
      verdict: hasUrgent ? 'act' : 'watch',
      urgency: hasUrgent ? '48h' : null,
      contextInsight: 'Audit agent unavailable — flagged based on anomaly signals',
      watchSignals: [],
      recommendedActions: [],
    };
  }
}
