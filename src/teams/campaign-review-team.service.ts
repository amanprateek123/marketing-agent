import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { runTeamViaCli, CliResult } from './team-cli.util';

export interface AdSetConfig {
  name: string;
  budgetPercent: number;
  audienceType: 'lookalike' | 'advantage_plus' | 'retarget' | 'interest' | 'custom';
  metaAudienceId?: string;          // Meta audience ID for lookalike/retarget/custom
  excludeAudienceIds?: string[];    // audiences to exclude (e.g. past buyers)
  ageMin?: number;
  ageMax?: number;
  gender?: 'all' | 'male' | 'female';
  geoLocations?: string[];          // country codes e.g. ["IN"]
  interests?: string[];             // Meta interest targeting
  optimizationGoal: string;         // e.g. "OFFSITE_CONVERSIONS"
  ads: number[];                    // indices into copy variants (e.g. [0, 1, 2])
}

export interface StructuredCampaignConfig {
  budget: number;
  objective: string;                // e.g. "OUTCOME_SALES"
  conversionEvent: string;          // e.g. "Purchase"
  conversionValue: number;          // revenue per conversion
  adSets: AdSetConfig[];
  scaleRules: string;
  pauseRules: string;
}

export interface CampaignReviewOutput {
  approved: boolean;
  campaign: StructuredCampaignConfig;
  adjustments: {
    budgetAdjusted: boolean;
    originalBudget: number;
    recommendedBudget: number;
  };
  debateRounds: number;
  debateLog: { round: number; from: string; summary: string }[];
  debateRationale: string;
}

/**
 * Campaign Review Team — Campaign Strategist + Performance Analyst.
 *
 * Reviews the full campaign package (creative + targeting + budget)
 * before launching on Meta. The Strategist wants to go big, the
 * Performance Analyst wants data-backed caution. They debate until
 * they agree on the right launch configuration.
 *
 * Sits between TypeScript safety checks and the actual Meta Ads launch.
 */
@Injectable()
export class CampaignReviewTeamService {
  private readonly logger = new Logger(CampaignReviewTeamService.name);

  constructor(
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  async review(
    brief: {
      topic: string;
      angle: string;
      platform: string;
      format: string;
      audience: string;
      hook: string;
      keyMessage: string;
      conversionBridge: string;
      suggestedBudget: number;
    },
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): Promise<CampaignReviewOutput> {
    const tenantId = company.tenantId;
    this.logger.log(`Campaign Review Team starting | tenant: ${tenantId} | run: ${runId}`);

    const prompt = this.buildPrompt(brief, creativePackage, company, runId);
    const cliResult = await runTeamViaCli(prompt, `review-${runId}`, 'Campaign Review');

    await this.usageLogModel.create({
      tenantId,
      runId,
      agent: AgentType.CAMPAIGN_REVIEW_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(
      `Campaign Review Team completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns} | cost: $${cliResult.total_cost_usd?.toFixed(4)}`,
    );

    return this.parseOutput(cliResult.result);
  }

  private buildPrompt(
    brief: {
      topic: string;
      angle: string;
      platform: string;
      format: string;
      audience: string;
      hook: string;
      keyMessage: string;
      conversionBridge: string;
      suggestedBudget: number;
    },
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): string {
    const liveContext = this.liveContextBuilder.build(company);
    const learnings = company.learnings;

    const campaignLearnings = learnings?.campaign
      ? `
PAST CAMPAIGN LEARNINGS:
- Audience scores: ${learnings.campaign.audienceScores ? Object.entries(learnings.campaign.audienceScores).sort(([,a],[,b]) => b - a).slice(0, 5).map(([k,v]) => `${k}: ${v}`).join(', ') : 'none yet'}
- Platform ROAS: ${learnings.campaign.platformROAS ? Object.entries(learnings.campaign.platformROAS).map(([k,v]) => `${k}: ${v}`).join(', ') : 'none yet'}
- Budget insights: ${learnings.campaign.budgetInsights?.join('; ') || 'none yet'}
- Timing insights: ${learnings.campaign.timingInsights?.join('; ') || 'none yet'}
- Objective insights: ${learnings.campaign.objectiveInsights?.join('; ') || 'none yet'}
`
      : 'No past campaign learnings yet — this may be an early campaign.';

    const causalInsights = learnings?.causalInsights?.length
      ? `CAUSAL INSIGHTS:\n${learnings.causalInsights.slice(0, 5).map(c => `- ${c.finding} (confidence: ${c.confidence}, based on ${c.dataPoints} campaigns)`).join('\n')}`
      : '';

    const selectedCopy = creativePackage?.copyVariants?.[creativePackage?.selectedCopyIndex ?? 0];

    return `
You ARE the Campaign Strategist for ${company.name}. You will review a campaign before it goes live on Meta Ads, debating with a Performance Analyst.

STEP 1: Call TeamCreate with team_name "review-${runId}"

STEP 2: Spawn the Performance Analyst via Agent tool:
  - name: "analyst"
  - team_name: "review-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Performance Analyst on the Campaign Review Team for ${company.name}. Your job is to challenge campaign configs that might waste budget.

    REVIEW PROTOCOL:
    - You will receive a full campaign brief (creative + targeting + budget) via SendMessage.
    - Evaluate based on past performance data and marketing fundamentals:
      1. BUDGET: Is the proposed budget too high for a first run? Should we start smaller and scale?
      2. TARGETING: Is the audience too broad or too narrow? Does it match the creative?
      3. TIMING: Is this the right time to launch? Any conflicting events or seasonality?
      4. RISK: What could go wrong? What's the downside if this flops?
      5. SCALE RULES: What metrics should trigger auto-scale? What should trigger auto-pause?
    - Be data-driven. Reference past learnings when available.
    - Push for conservative budgets on unproven concepts, aggressive on proven ones.
    - When the Strategist pushes back, either concede with data or hold firm with data.
    - Max 5 rounds. When you agree, send: {type: 'consensus', approved: true/false}.
    - Send all messages to 'team-lead'. Respond IMMEDIATELY."

STEP 3: Send the full campaign package to the Performance Analyst via SendMessage(to: "analyst"). Label as "ROUND 1".

CAMPAIGN TO REVIEW:
  Topic: ${brief.topic}
  Angle: ${brief.angle}
  Platform: ${brief.platform} | Format: ${brief.format}
  Audience: ${brief.audience}
  Hook: ${brief.hook}
  Key Message: ${brief.keyMessage}
  Conversion Bridge: ${brief.conversionBridge}
  Proposed Budget: ₹${brief.suggestedBudget}
  Objective: ${company.primaryObjective}
  Geography: ${company.geography}
  Max Budget Per Campaign: ₹${company.maxBudgetPerCampaign}
  Weekly Budget Cap: ₹${company.weeklyBudgetCap}
  Max Scale: ${company.maxBudgetScalePercent}%
  Pause if ROAS below: ${company.pauseIfROASBelow ?? 'not set'}
  Pause if CTR below: ${company.pauseIfCTRBelow ?? 'not set'}
  Pause if frequency above: ${company.pauseIfFrequencyAbove ?? 'not set'}

  Selected Copy:
  ${selectedCopy ? `Headline: ${selectedCopy.headline}\nCopy: ${selectedCopy.primaryText}\nCTA: ${selectedCopy.cta}` : 'No copy available yet'}

  Image: ${creativePackage?.imageUrl ? 'Generated' : 'Pending'}
  Video: ${creativePackage?.videoUrl ? 'Generated' : 'Pending'}

${(() => {
  const product = (company.products ?? []).find(p => p.name === (brief as any).product);
  if (!product) return 'PRODUCT: not specified';
  const segments = (product.audienceSegments ?? []).map(s =>
    `  - ${s.name} (${s.confidence}${s.avgCPA ? `, CPA ₹${s.avgCPA}` : ''}): ${s.description}, age ${s.ageMin}-${s.ageMax}`
  ).join('\n');
  const metaAud = (product.metaAudiences ?? []).map(a =>
    `  - [${a.type}${a.lookalikePercent ? ` ${a.lookalikePercent}%` : ''}] ${a.name} (id: ${a.id})`
  ).join('\n');
  const perf = product.performance;
  return `PRODUCT BEING SOLD:
  ${product.name} — ₹${product.price}
  Landing: ${product.landingUrl ?? 'not set'}
  Conversion event: ${product.conversionEvent ?? 'Purchase'} (each conversion = ₹${product.conversionValue ?? product.price})
  Past performance: ${perf?.totalConversions ?? 0} conversions, CPA ₹${perf?.avgCPA ?? 'N/A'}, ROAS ${perf?.avgROAS ?? 'N/A'}x (${perf?.confidenceLevel ?? 'no data'})

AVAILABLE AUDIENCE SEGMENTS:
${segments || '  none defined'}

AVAILABLE META AUDIENCES (use these EXACT IDs in adSets config):
${metaAud || '  none linked — use Advantage+ broad'}
  IMPORTANT: Use the actual Meta audience IDs above in your adSets[].metaAudienceId field.`;
})()}

${campaignLearnings}
${causalInsights}

STEP 4: Wait for the Analyst's response. They will challenge budget, targeting, or timing.
  - If you AGREE → adjust the recommendation
  - If you DISAGREE → push back with reasoning
  - Continue until consensus (max 5 rounds)

STEP 5: Once agreed, call TeamDelete to clean up. If TeamDelete fails, SKIP IT — do not retry. Cleanup will be handled automatically. Proceed directly to the output.

STEP 6: Return ONLY this JSON (no markdown, no explanation):
{
  "approved": true,
  "campaign": {
    "budget": ${brief.suggestedBudget},
    "objective": "OUTCOME_SALES",
    "conversionEvent": "${(() => { const p = (company.products ?? []).find(pr => pr.name === (brief as any).product); return p?.conversionEvent ?? 'Purchase'; })()}",
    "conversionValue": ${(() => { const p = (company.products ?? []).find(pr => pr.name === (brief as any).product); return p?.conversionValue ?? brief.suggestedBudget; })()},
    "adSets": [
      {
        "name": "descriptive name",
        "budgetPercent": 50,
        "audienceType": "lookalike|advantage_plus|retarget|interest|custom",
        "metaAudienceId": "use actual Meta audience ID from the list above, or omit for advantage_plus",
        "excludeAudienceIds": ["past buyer audience ID to exclude"],
        "ageMin": 25,
        "ageMax": 42,
        "geoLocations": ["IN"],
        "optimizationGoal": "OFFSITE_CONVERSIONS",
        "ads": [0, 1, 2]
      }
    ],
    "scaleRules": "specific rules e.g. ROAS > 2x AND CTR > 0.8% after 48h → scale 20%",
    "pauseRules": "specific rules e.g. CTR < 0.5% after ₹1,500 spent → pause"
  },
  "adjustments": {
    "budgetAdjusted": true/false,
    "originalBudget": ${brief.suggestedBudget},
    "recommendedBudget": 0
  },
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed campaign config"},
    {"round": 1, "from": "analyst", "summary": "challenged budget"},
    {"round": 2, "from": "strategist", "summary": "adjusted"},
    {"round": 2, "from": "analyst", "summary": "approved"}
  ],
  "debateRationale": "2-3 sentence summary"
}

IMPORTANT — adSets rules:
- Create 2-3 ad sets minimum. Never launch with just 1 ad set.
- Each ad set MUST have a different audience (don't duplicate targeting).
- Use real Meta audience IDs from the list above — don't invent IDs.
- If no Meta audiences exist, use audienceType "advantage_plus" for broad and "interest" for targeted.
- Always exclude past buyer audiences from prospecting ad sets.
- "ads": [0, 1, 2] means all 3 copy variants run in every ad set — Meta optimizes which wins.
- budgetPercent across all ad sets must sum to 100.

${liveContext}

CAMPAIGN STRATEGY MODE: ${company.pipelineConfig?.campaignStrategy ?? 'balanced'}
${(() => {
  const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
  if (strategy === 'conservative') return `- CONSERVATIVE MODE: Start with minimum viable budget. Only use proven audiences (confidence: medium/high). Tight pause rules. No broad/experimental ad sets. Scale slowly (10% max).`;
  if (strategy === 'experimental') return `- EXPERIMENTAL MODE: Allocate 30-40% budget to broad/new audiences. Looser pause rules (give ads more time to find signal). Higher tolerance for initial CPA. Test multiple audience types.`;
  return `- BALANCED MODE: 50-70% budget on proven audiences, 20-30% on broad/new test. Standard pause rules. Scale proven ad sets 20% after 48h if ROAS > 2x.`;
})()}

RULES:
- TypeScript safety checks already passed (budget caps, forbidden topics) — don't re-check those
- Focus on STRATEGIC decisions: is this the right budget to START with? Right audience? Right timing?
- Always set specific scale rules and pause rules — never launch without guardrails
- If past learnings show this audience/format performs well, be more aggressive
- If no past data, be conservative — start at 50-60% of proposed budget
    `.trim();
  }

  private parseOutput(content: string): CampaignReviewOutput {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      return JSON.parse(jsonStr);
    } catch {
      this.logger.error('Campaign Review Team output parse failed');
      throw new Error('Campaign Review Team returned invalid JSON');
    }
  }
}
