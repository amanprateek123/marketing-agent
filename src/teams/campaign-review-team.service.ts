import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { runTeamViaCli, CliResult } from './team-cli.util';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';

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
  creativeFormat?: 'video' | 'image' | 'both'; // which creative type to use for this ad set
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
    private readonly metaLearningImporter: MetaLearningImporterService,
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

    const prompt = await this.buildPrompt(brief, creativePackage, company, runId);
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

  private async buildPrompt(
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
  ): Promise<string> {
    const liveContext = this.liveContextBuilder.build(company);
    const learnings = company.learnings;

    // ── Case studies + audience performance ───────────────────────────────────
    let caseStudyContext = '';
    let audiencePerfContext = '';
    try {
      const product = (company.products ?? []).find(p => p.name === (brief as any).product);
      const [caseStudies, audiencePerf] = await Promise.all([
        this.metaLearningImporter.getRelevantCaseStudies(company.tenantId, { product: product?.name, limit: 7 }),
        this.metaLearningImporter.getAudiencePerformanceSummary(company.tenantId),
      ]);

      caseStudyContext = caseStudies.length > 0
        ? `PAST CAMPAIGN CASE STUDIES (budget/audience learnings):
${caseStudies.slice(0, 7).map((cs, i) => `  ${i + 1}. ${cs.campaignName}: spend ₹${cs.totalSpend}, ${cs.totalConversions} conversions, best CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}, winning audiences: ${cs.whatWorked?.audiences?.join(', ') || 'unknown'}. Lesson: ${cs.lesson}`).join('\n')}`
        : 'PAST CAMPAIGN CASE STUDIES: No past case studies available yet.';

      if (Object.keys(audiencePerf.byType).length > 0) {
        const sorted = Object.entries(audiencePerf.byType)
          .filter(([, d]) => d.conversions > 0)
          .sort(([, a], [, b]) => a.avgCPA - b.avgCPA);
        if (sorted.length > 0) {
          audiencePerfContext = `AUDIENCE TYPE PERFORMANCE (from ${Object.values(audiencePerf.byType).reduce((s, d) => s + d.adSetCount, 0)} historical ad sets):
${sorted.map(([type, d]) => `  - ${type}: avg CPA ₹${d.avgCPA}, CTR ${d.avgCTR}%, ${d.conversions} conversions, ₹${d.totalSpend} total spend (${d.adSetCount} ad sets)`).join('\n')}
USE THIS TO: allocate higher budget % to audience types with lowest CPA.`;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Learnings unavailable for ${company.tenantId}: ${err.message}`);
      caseStudyContext = 'PAST CAMPAIGN CASE STUDIES: Unavailable this run.';
    }

    // ── Product + audience data ──────────────────────────────────────────────
    const product = (company.products ?? []).find(p => p.name === (brief as any).product);
    const productBlock = (() => {
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
    })();

    // ── Compact context brief for the Analyst ────────────────────────────────
    const analystContextBrief = `Product: ${product?.name ?? 'unknown'} (₹${product?.price ?? 'N/A'}) — ${product?.performance?.totalConversions ?? 0} conversions, CPA ₹${product?.performance?.avgCPA ?? 'N/A'}
Budget: ₹${brief.suggestedBudget}/day proposed | Cap: ₹${company.maxBudgetPerCampaign}/day | Weekly cap: ₹${company.weeklyBudgetCap}
${audiencePerfContext ? 'Audience data available — see context brief.' : 'No audience performance data yet.'}`;

    // ── Selected copy ────────────────────────────────────────────────────────
    const selectedCopy = creativePackage?.copyVariants?.[creativePackage?.selectedCopyIndex ?? 0];

    // ── Strategy mode ────────────────────────────────────────────────────────
    const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
    const strategyMode = strategy === 'conservative'
      ? `CONSERVATIVE MODE: Start with minimum viable budget. Only use proven audiences (confidence: medium/high). Tight pause rules. No broad/experimental ad sets. Scale slowly (10% max).`
      : strategy === 'experimental'
        ? `EXPERIMENTAL MODE: Allocate 30-40% budget to broad/new audiences. Looser pause rules. Higher tolerance for initial CPA. Test multiple audience types.`
        : `BALANCED MODE: 50-70% budget on proven audiences, 20-30% on broad/new test. Standard pause rules. Scale proven ad sets 20% after 48h if ROAS > 2x.`;

    // ── Format decision logic (only include full tree when no data) ──────────
    const winningFormats = learnings?.creative?.winningFormats ?? [];
    const losingFormats = learnings?.creative?.losingFormats ?? [];
    const hasFormatData = winningFormats.length > 0 || losingFormats.length > 0;

    const formatSection = hasFormatData
      ? `CREATIVE FORMAT — video vs image per ad set:
Each ad set must have "creativeFormat": "video" | "image" | "both".
Format performance: Winning: ${winningFormats.join(', ')}. Losing: ${losingFormats.join(', ') || 'none'}.
- Assign winning format to largest budget ad sets. Test the other on smallest budget ad set.
- If both winning → split test across ad sets.
- Budget < ₹1,500/day → don't split, use winning format only.`
      : `CREATIVE FORMAT — video vs image per ad set:
Each ad set must have "creativeFormat": "video" | "image" | "both".
No format data yet. Decide from first principles:
- Young/impulse/lifestyle audiences → video. Professionals/B2B → image. Broad/advantage_plus → video default. Retarget → image.
- Demo/transformation/testimonial → video. Discount/urgency/simple product → image.
- Conflicting signals or unsure → "both" (let Meta optimize).
- Budget < ₹1,500/day → don't split formats, pick one.`;

    // ═════════════════════════════════════════════════════════════════════════
    // PROMPT: Data first → Rules → Steps
    // ═════════════════════════════════════════════════════════════════════════
    return `
You ARE the Campaign Strategist for ${company.name}. You will review a campaign before it goes live on Meta Ads, debating with a Performance Analyst.

═══════════════════════════════════════════════════════
CAMPAIGN TO REVIEW
═══════════════════════════════════════════════════════

Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key Message: ${brief.keyMessage}
Conversion Bridge: ${brief.conversionBridge}
Proposed Daily Budget: ₹${brief.suggestedBudget}/day (total across all ad sets)
Objective: ${company.primaryObjective}
Geography: ${company.geography}

Selected Copy:
${selectedCopy ? `  Headline: ${selectedCopy.headline}\n  Copy: ${selectedCopy.primaryText}\n  CTA: ${selectedCopy.cta}` : '  No copy available yet'}
Image: ${creativePackage?.imageUrl ? 'Generated' : 'Pending'}
Video: ${creativePackage?.videoUrl ? 'Generated' : 'Pending'}

${productBlock}

═══════════════════════════════════════════════════════
PERFORMANCE DATA
═══════════════════════════════════════════════════════

${audiencePerfContext || 'No audience performance data yet — this may be an early campaign.'}

${caseStudyContext}

${liveContext}

CAMPAIGN STRATEGY: ${strategyMode}

═══════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════

BUDGET:
- "budget" = TOTAL DAILY BUDGET across all ad sets combined (₹/day)
- Each ad set gets: budget × (budgetPercent / 100) per day
- Proposed anchor: ₹${brief.suggestedBudget > 0 ? brief.suggestedBudget : Math.round((company.weeklyBudgetCap ?? 20000) * 0.25)}/day
- Hard cap: ₹${company.maxBudgetPerCampaign}/day | Weekly cap: ₹${company.weeklyBudgetCap}
- Max scale: ${company.maxBudgetScalePercent}%
- Pause if ROAS < ${company.pauseIfROASBelow ?? 'not set'} | CTR < ${company.pauseIfCTRBelow ?? 'not set'} | Frequency > ${company.pauseIfFrequencyAbove ?? 'not set'}
- The debate adjusts UP or DOWN from the anchor — does NOT invent from scratch
- No past data → be conservative, start at 50-60% of proposed budget

AD SETS:
- 2-3 ad sets minimum. Each MUST have a different audience.
- Use real Meta audience IDs from the product data — don't invent IDs.
- No Meta audiences → use audienceType "advantage_plus" (NOT "interest" without real IDs).
- Exclude past buyer audiences from prospecting ad sets.
- "ads": [0, 1, 2] = all 3 copy variants per ad set — Meta optimizes.
- budgetPercent across all ad sets must sum to 100.

${formatSection}

GUARDRAILS:
- Always set specific scaleRules and pauseRules — never launch without guardrails
- TypeScript safety checks already passed — focus on STRATEGIC decisions

═══════════════════════════════════════════════════════
STEPS
═══════════════════════════════════════════════════════

STEP 1: Call TeamCreate with team_name "review-${runId}"

STEP 2: Spawn the Performance Analyst via Agent tool:
  - name: "analyst"
  - team_name: "review-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Performance Analyst on the Campaign Review Team for ${company.name}. Your job is to challenge campaign configs that might waste budget.

    REVIEW PROTOCOL:
    - You will receive a campaign brief with a CONTEXT BRIEF containing key performance data.
    - Use the data to challenge budget, targeting, and timing decisions.
    - Evaluate: (1) BUDGET — too high for a first run? (2) TARGETING — too broad/narrow? (3) TIMING — right moment? (4) RISK — what if it flops? (5) GUARDRAILS — what triggers scale/pause?
    - Be data-driven. Push for conservative budgets on unproven concepts, aggressive on proven ones.
    - When the Strategist pushes back, either concede with data or hold firm with data.
    - Max 5 rounds. When you agree, send: {type: 'consensus', approved: true/false}.
    - Send all messages to 'team-lead'. Respond IMMEDIATELY."

STEP 3: Send the campaign package to the Analyst via SendMessage(to: "analyst").

Include a CONTEXT BRIEF at the top of your message:
---CONTEXT BRIEF---
${analystContextBrief}
---END CONTEXT BRIEF---
Then include the full campaign config you're proposing (ad sets, budgets, targeting). Label as "ROUND 1".

CRITICAL: After SendMessage, do NOT output any text. Immediately call TaskCreate with name "round-1-pending" and body "waiting for analyst response". Do not produce any output until you receive their message.

STEP 4: When you receive the Analyst's response:
  - If you AGREE → adjust, SendMessage(to: "analyst") with revised config as "ROUND 2", then call TaskCreate(name: "round-2-pending").
  - If you DISAGREE → push back with reasoning via SendMessage, then call TaskCreate to wait again.
  - Continue until consensus (max 5 rounds).
  PATIENCE: The analyst runs in the background and takes several minutes to respond. Do NOT give up or produce output on your own. Keep waiting via TaskCreate until their message arrives. Only nudge once (via SendMessage) if you have called TaskCreate 4+ times with no reply.

STEP 5: Once consensus is reached:
  1. SendMessage(to: "analyst", message: {type: "shutdown_request"})
  2. Call TaskCreate(name: "shutdown-pending", body: "waiting for shutdown confirmation") — do NOT call TeamDelete yet.
  3. Wait for the shutdown confirmation to arrive as an incoming message.
  4. Only after receiving confirmation: call TeamDelete.
  If TeamDelete fails after receiving confirmation, SKIP IT — cleanup is automatic. Proceed to output.

STEP 6: Return ONLY this JSON (no markdown, no explanation):
{
  "approved": true,
  "campaign": {
    "budget": ${brief.suggestedBudget > 0 ? brief.suggestedBudget : Math.round((company.weeklyBudgetCap ?? 20000) * 0.25)},
    "objective": "OUTCOME_SALES",
    "conversionEvent": "${product?.conversionEvent ?? 'Purchase'}",
    "conversionValue": ${product?.conversionValue ?? product?.price ?? 0},
    "adSets": [
      {
        "name": "descriptive name",
        "budgetPercent": 50,
        "audienceType": "lookalike|advantage_plus|retarget|interest|custom",
        "metaAudienceId": "actual Meta audience ID or omit for advantage_plus",
        "excludeAudienceIds": [],
        "ageMin": 25,
        "ageMax": 42,
        "geoLocations": ["IN"],
        "optimizationGoal": "OFFSITE_CONVERSIONS",
        "ads": [0, 1, 2],
        "creativeFormat": "video"
      }
    ],
    "scaleRules": "specific rules — e.g. ROAS > 2x AND CTR > 0.8% after 48h → scale 20%",
    "pauseRules": "specific rules — e.g. CTR < 0.5% after ₹1,500 spent → pause"
  },
  "adjustments": {
    "budgetAdjusted": false,
    "originalBudget": ${brief.suggestedBudget},
    "recommendedBudget": 0
  },
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed campaign config with 2 ad sets"},
    {"round": 1, "from": "analyst", "summary": "challenged budget, suggested starting lower"},
    {"round": 2, "from": "strategist", "summary": "adjusted budget down"},
    {"round": 2, "from": "analyst", "summary": "approved revised config"}
  ],
  "debateRationale": "2-3 sentence summary"
}
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
