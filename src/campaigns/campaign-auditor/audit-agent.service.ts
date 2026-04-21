import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { AuditSignalPacket } from './signal-detector.service';
import { AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';

export interface AuditVerdict {
  verdict: 'watch' | 'act' | 'no_action';
  urgency: 'immediate' | '48h' | '7d' | null;
  contextInsight: string;       // Why this verdict — the "so what" in plain English
  watchSignals: string[];        // Signals to monitor next audit
  recommendedActions: {
    type: 'pause_ad' | 'pause_adset' | 'scale_adset' | 'replace_creative';
    targetId: string;
    targetName: string;
    reason: string;
    priority: 'high' | 'medium' | 'low';
  }[];
}

const DEFAULT_AUDIT_SYSTEM_PROMPT = `You are a performance marketing analyst auditing a live Meta Ads campaign.

You receive:
1. Campaign metadata (age, budget, objective, audience)
2. Current metrics from Meta (spend, CTR, ROAS, conversions, frequency)
3. Trend signals from the last 3 audits (improving/stable/declining)
4. Benchmarks from this company's historical learnings
5. Detected anomalies (high spend zero conversions, creative fatigue, audience fatigue)

Your job is to produce a structured verdict:
- "no_action": Campaign is performing within expectations, no changes needed
- "watch": Concerning signals but not yet critical — flag for next audit
- "act": Clear problem or opportunity requiring immediate human review

Guidelines:
- During learning phase (first 14 days): be tolerant of low CTR/ROAS unless spend is very high
- Only recommend "act" if there is clear evidence of waste or a scaling opportunity
- Creative fatigue with >35% CTR drop is always act-worthy
- High spend + zero conversions = always act with immediate urgency
- Improving ROAS with 3+ conversions = act with scale recommendation
- Pure learning phase campaigns: watch unless major anomalies

Output ONLY valid JSON in this exact format:
{
  "verdict": "watch" | "act" | "no_action",
  "urgency": "immediate" | "48h" | "7d" | null,
  "contextInsight": "one or two sentences explaining the key finding",
  "watchSignals": ["signal 1", "signal 2"],
  "recommendedActions": [
    {
      "type": "pause_ad" | "pause_adset" | "scale_adset" | "replace_creative",
      "targetId": "EXACT numeric Meta ID from the data above (e.g. 120241731996240278) — NOT a slug or name",
      "targetName": "human readable name",
      "reason": "specific reason for this action",
      "priority": "high" | "medium" | "low"
    }
  ]
}`;

@Injectable()
export class AuditAgentService {
  private readonly logger = new Logger(AuditAgentService.name);

  constructor(private readonly claudeService: ClaudeService) {}

  async analyze(
    campaign: any,
    signals: AuditSignalPacket,
    snapshots: AuditSnapshotDocument[],
    company: CompanyDocument,
  ): Promise<AuditVerdict> {
    const learnings = company.learnings;
    const caseStudies = (company as any).caseStudies ?? [];

    const context = this.buildContext(campaign, signals, snapshots, company, learnings, caseStudies);
    const systemPrompt = (company.prompts as any)?.campaignAuditor || DEFAULT_AUDIT_SYSTEM_PROMPT;

    try {
      const result = await this.claudeService.runAgent({
        tenantId: company.tenantId,
        agentType: AgentType.CAMPAIGN_AUDITOR,
        systemPrompt,
        liveContext: '',
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
  ): string {
    const age = signals.campaignAge;
    const curr = campaign;

    // Recent snapshot history for context
    const snapshotSummary = snapshots
      .slice(0, 3)
      .map((s, i) => {
        const d = new Date(s.auditedAt);
        return `  Audit ${i + 1} (${d.toLocaleDateString()}): spend=₹${s.metrics.spend.toFixed(0)} ctr=${s.metrics.ctr.toFixed(2)}% roas=${s.metrics.roas.toFixed(2)}x conversions=${s.metrics.conversions}`;
      })
      .join('\n') || '  No prior snapshots';

    // Build ad set anomaly detail
    const anomalies = signals.anomalies;
    const anomalyLines: string[] = [];
    if (anomalies.highSpendZeroConversions.length > 0) {
      anomalyLines.push(`HIGH SPEND ZERO CONVERSIONS: ${anomalies.highSpendZeroConversions.map(a => `${a.adSetName} (₹${a.spend})`).join(', ')}`);
    }
    if (anomalies.creativeFatigue.length > 0) {
      anomalyLines.push(`CREATIVE FATIGUE: ${anomalies.creativeFatigue.map(a => `${a.adName} [${a.hookStyle}] CTR dropped ${a.ctrDrop}%`).join(', ')}`);
    }
    if (anomalies.audienceFatigue.length > 0) {
      anomalyLines.push(`AUDIENCE FATIGUE: ${anomalies.audienceFatigue.map(a => `${a.adSetName} freq=${a.frequency.toFixed(1)}`).join(', ')}`);
    }
    if (anomalies.stuckInLearning) anomalyLines.push('STUCK IN LEARNING: 0 conversions after learning phase');
    if (anomalies.budgetExhaustionRisk) anomalyLines.push('BUDGET EXHAUSTION: spending >15% above expected daily pace');

    // Relevant case studies
    const relevantCases = caseStudies
      .filter((cs: any) => cs.verdict === 'act' || cs.outcome === 'paused' || cs.outcome === 'scaled')
      .slice(0, 3)
      .map((cs: any) => `  - ${cs.topic ?? ''}: ${cs.contextInsight ?? cs.summary ?? ''}`)
      .join('\n');

    return `=== CAMPAIGN AUDIT ===

CAMPAIGN: ${campaign.name ?? campaign.metaCampaignId}
Objective: ${campaign.objective}
Age: ${age.hours}h (${age.days} days) | ${age.inLearningPhase ? 'IN LEARNING PHASE' : 'POST LEARNING PHASE'}
Daily Budget: ₹${campaign.budget}/day | Spend pace: ${signals.trends.spendPace}

CURRENT METRICS (live from Meta):
  Spend: ₹${curr.spend?.toFixed(0) ?? 0}
  CTR: ${curr.ctr?.toFixed(2) ?? 0}% | CPC: ₹${curr.cpc?.toFixed(0) ?? 0}
  Conversions: ${curr.conversions ?? 0} | ROAS: ${curr.roas?.toFixed(2) ?? 0}x

TREND SIGNALS (last 3 audits):
  CTR trend: ${signals.trends.ctrTrend}
  ROAS trend: ${signals.trends.roasTrend}
  Frequency trend: ${signals.trends.frequencyTrend}

BENCHMARKS (from ${company.name} learnings):
  Expected CTR: ${signals.benchmarks.expectedCTRRange ? `${signals.benchmarks.expectedCTRRange.min.toFixed(2)}–${signals.benchmarks.expectedCTRRange.max.toFixed(2)}%` : 'no benchmark'}
  Current CTR vs benchmark: ${signals.benchmarks.currentCTRVsBenchmark}
  Best audience type: ${signals.benchmarks.bestAudienceType ?? 'unknown'}

ANOMALIES DETECTED:
${anomalyLines.length > 0 ? anomalyLines.map(l => `  ⚠ ${l}`).join('\n') : '  None'}

AUDIT HISTORY (${snapshots.length} snapshots):
${snapshotSummary}

COMPANY LEARNINGS SUMMARY:
  Winning hooks: ${learnings?.creative?.winningHooks?.slice(0, 3).join(', ') ?? 'none'}
  Budget insights: ${learnings?.campaign?.budgetInsights?.slice(0, 2).join('; ') ?? 'none'}
  Timing insights: ${learnings?.campaign?.timingInsights?.slice(0, 2).join('; ') ?? 'none'}

${relevantCases ? `RELEVANT CASE STUDIES:\n${relevantCases}\n` : ''}
=== END AUDIT DATA ===

Based on all of the above, produce your verdict JSON.`;
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
          ? parsed.recommendedActions.filter((a: any) => {
              if (!a.type || !a.targetId) return false;
              // Reject non-numeric targetIds — Claude sometimes returns slugs instead of Meta IDs
              if (!/^\d+$/.test(String(a.targetId))) {
                this.logger.warn(`Dropping action with invalid targetId: "${a.targetId}" (expected numeric Meta ID)`);
                return false;
              }
              return true;
            })
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
