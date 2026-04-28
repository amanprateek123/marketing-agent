import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { AuditSignalPacket } from './signal-detector.service';
import { AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';

export interface AuditVerdict {
  verdict: 'watch' | 'act' | 'no_action';
  urgency: 'immediate' | '48h' | '7d' | null;
  contextInsight: string;       // Why this verdict — the "so what" in plain English
  watchSignals: string[];        // Signals to monitor next audit
  recommendedActions: {
    type: 'pause_ad' | 'pause_adset' | 'scale_adset' | 'replace_creative' | 'add_creative' | 'add_adset' | 'shift_budget_between_adsets';
    targetId: string;
    targetName: string;
    reason: string;
    priority: 'high' | 'medium' | 'low';
    params?: Record<string, any>;  // action-specific params (e.g. hookStyle, audienceType, toAdSetId, shiftPercent)
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
- "shift_budget_between_adsets": Move budget % from a losing ad set to a winning one INSIDE the same campaign. Total campaign budget unchanged. Use this BEFORE pausing a losing ad set if a clear winner exists in the same campaign — you keep both alive, just feed the winner more. Set targetId = fromAdSetId (the losing/donor ad set), params.toAdSetId = the winning/recipient ad set, params.shiftPercent = how much of the donor's CURRENT budget % to move (e.g. 50 means move half of the donor's allocation to the recipient). Cap: TS will clamp to ≤50% per shift.

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
      "type": "pause_ad" | "pause_adset" | "scale_adset" | "replace_creative" | "add_creative" | "add_adset" | "shift_budget_between_adsets",
      "targetId": "EXACT numeric Meta ID from the data above (e.g. 120241731996240278) — NOT a slug or name. For add_adset use the campaign ID. For shift_budget_between_adsets use the DONOR (losing) ad set ID.",
      "targetName": "human readable name",
      "reason": "specific reason for this action",
      "priority": "high" | "medium" | "low",
      "params": {
        "// For add_creative": "hookStyle: string (new hook to use)",
        "// For add_adset": "audienceType: 'retarget' | 'narrowed', targeting: { ageMin, ageMax, geoLocations }",
        "// For shift_budget_between_adsets": "toAdSetId: string (recipient ad set), shiftPercent: number (1-50, % of donor's current budget % to move)"
      }
    }
  ]
}`;

@Injectable()
export class AuditAgentService {
  private readonly logger = new Logger(AuditAgentService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
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
    const systemPrompt =
      (company.prompts as any)?.campaignAuditor || buildDefaultAuditSystemPrompt(company.name);
    const liveContext = this.liveContextBuilder.build(company);

    try {
      const result = await this.claudeService.runAgent({
        tenantId: company.tenantId,
        agentType: AgentType.CAMPAIGN_AUDITOR,
        systemPrompt,
        liveContext,
        userMessage: context,
        maxTurns: 1,
      });

      return this.parseVerdict(result.content);
    } catch (err: any) {
      this.logger.error(`Audit agent failed: ${err.message} — defaulting to watch`);
      return this.safeDefault(signals);
    }
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
      anomalyLines.push(`CREATIVE FATIGUE: ${anomalies.creativeFatigue.map(a => `${a.adId} [${a.hookStyle}] CTR dropped ${a.ctrDrop}%`).join(', ')}`);
    }
    if (anomalies.audienceFatigue.length > 0) {
      anomalyLines.push(`AUDIENCE FATIGUE: ${anomalies.audienceFatigue.map(a => `${a.adSetName} [${a.adSetId}] freq=${a.frequency.toFixed(1)}`).join(', ')}`);
    }
    if (anomalies.campaignZeroConversions) anomalyLines.push(`ZERO CONVERSIONS: ₹${campaign.spend?.toFixed(0) ?? 0} spent (>1 day budget) with 0 conversions`);
    if (anomalies.stuckInLearning) anomalyLines.push('STUCK IN LEARNING: 0 conversions after learning phase');
    if (anomalies.budgetExhaustionRisk) anomalyLines.push('BUDGET EXHAUSTION: spending >15% above expected daily pace');

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

━━━ BENCHMARKS (${company.name} | vertical: ${company.industry || 'unknown'}) ━━━
  Expected CTR: ${signals.benchmarks.expectedCTRRange ? `${signals.benchmarks.expectedCTRRange.min.toFixed(2)}–${signals.benchmarks.expectedCTRRange.max.toFixed(2)}%` : 'no benchmark'} | current: ${signals.benchmarks.currentCTRVsBenchmark}
  Expected CPA: ${signals.benchmarks.expectedCPARange ? `₹${signals.benchmarks.expectedCPARange.min.toFixed(0)}–₹${signals.benchmarks.expectedCPARange.max.toFixed(0)}` : 'no benchmark'} | current: ${signals.benchmarks.currentCPAVsBenchmark}
  Best audience type: ${signals.benchmarks.bestAudienceType ?? 'unknown'}
  Winning hooks: ${learnings?.creative?.winningHooks?.slice(0, 3).join(', ') ?? 'none'}

━━━ ANOMALIES ━━━
${anomalyLines.length > 0 ? anomalyLines.map(l => `  ⚠ ${l}`).join('\n') : '  None'}

━━━ OPPORTUNITIES ━━━
${signals.opportunities.winningAdSets.length > 0 ? signals.opportunities.winningAdSets.map(w => `  ✅ WINNING: ${w.adSetName} (${w.adSetId}) — ROAS ${w.roas.toFixed(2)}x, CTR ${w.ctr.toFixed(2)}%, ${w.conversions} conv`).join('\n') : '  No winning ad sets yet'}
${signals.opportunities.earlyFatigue.length > 0 ? signals.opportunities.earlyFatigue.map(f => `  ⚡ EARLY FATIGUE: ${f.adSetName} (${f.adSetId}) — CTR declining ${f.ctrDrop}%`).join('\n') : ''}
${signals.opportunities.readyForRetarget ? `  🎯 RETARGET READY: ${totalClicks} clicks, ${totalConv} conv after ${age.days} days` : ''}

━━━ PRIOR AUDIT DECISIONS (most recent first; cooldown/skip entries excluded) ━━━
${snapshotSummary}
  (In the contextInsight, briefly state whether your verdict aligns with or reverses the prior decisions, and why. Both directions need explanation — do not default to consistency.)

${relevantCases ? `━━━ CASE STUDIES ━━━\n${relevantCases}\n` : ''}
=== END AUDIT DATA ===

Analyze at CAMPAIGN, AD SET, and AD level. Produce your verdict JSON.`;
  }

  private parseVerdict(output: string): AuditVerdict {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in output');
      const parsed = JSON.parse(jsonMatch[0]);

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
