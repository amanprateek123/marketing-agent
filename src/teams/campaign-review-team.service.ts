import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { AgentType } from '../claude/claude.types';
import { ClaudeService } from '../claude/claude.service';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { runTeamViaCli } from './team-cli.util';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { buildSkillBlock, skillsForAgent } from '../common/skills/agent-skill-map';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

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
  ads: number[];                    // indices into copy variants (e.g. [0, 1, 2, 3])
  creativeFormat?: 'video' | 'image' | 'both' | 'mixed'; // which creative type to use for this ad set
  // 'mixed' = selected variant → video ad; other variants → image ads (1 video + N image, recommended for prospecting)
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
    private readonly claudeService: ClaudeService,
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
      product?: string;                       // product name — drives productBlock + landing URL + audience lookup
      audienceStage?: 'cold' | 'warm' | 'hot'; // cold prospecting / warm retarget / hot cart-recovery — branches ad-set targeting
    },
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): Promise<CampaignReviewOutput> {
    const tenantId = company.tenantId;
    const teamMode = company.pipelineConfig?.teamMode ?? 'sequential';
    this.logger.log(`Campaign Review Team starting | tenant: ${tenantId} | run: ${runId} | mode: ${teamMode}`);

    if (teamMode === 'cli') {
      return this.reviewViaCli(brief, creativePackage, company, runId);
    }
    return this.reviewSequential(brief, creativePackage, company, runId);
  }

  // ── CLI path ────────────────────────────────────────────────────────────────
  private async reviewViaCli(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      suggestedBudget: number;
      product?: string;
      audienceStage?: 'cold' | 'warm' | 'hot';
    },
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): Promise<CampaignReviewOutput> {
    const tenantId = company.tenantId;
    const prompt = await this.buildPrompt(brief, creativePackage, company, runId);
    const cliResult = await runTeamViaCli(prompt, `review-${runId}`, 'Campaign Review');

    await this.usageLogModel.create({
      tenantId, runId,
      agent: AgentType.CAMPAIGN_REVIEW_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(`Campaign Review Team (CLI) completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns}`);
    return this.parseOutput(cliResult.result);
  }

  // ── Sequential path (2 runAgent() calls) ───────────────────────────────────
  private async reviewSequential(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      suggestedBudget: number;
      product?: string;
      audienceStage?: 'cold' | 'warm' | 'hot';
    },
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): Promise<CampaignReviewOutput> {
    const tenantId = company.tenantId;

    // ── Call 1: Strategist proposes campaign config ─────────────────────────
    const call1Prompt = await this.buildCall1Prompt(brief, creativePackage, company, runId);

    const call1 = await this.claudeService.runAgent({
      tenantId, runId,
      agentType: AgentType.CAMPAIGN_REVIEW_LEAD,
      systemPrompt: company.prompts?.campaignCreator ?? '',
      // liveContext is already embedded in call1Prompt via buildCall1Prompt → buildPrompt
      // passing it here would inject it twice (system prompt + user message)
      liveContext: '',
      userMessage: call1Prompt,
      maxTurns: 5,
      skills: skillsForAgent('CAMPAIGN_REVIEW'),   // paid-ads + ab-test-setup + marketing-psychology + competitor-alternatives
    });

    this.logger.log(`Campaign Review Team sequential — Call 1 done (${call1.content.length} chars)`);

    // ── Validate Call 1 before passing to the Analyst ───────────────────────
    let call1Parsed: CampaignReviewOutput;
    try {
      call1Parsed = this.parseOutput(call1.content);
    } catch (parseErr: any) {
      throw new Error(`Campaign Review Team Call 1 returned unparseable output — cannot proceed to analyst review: ${parseErr.message}`);
    }

    // ── Call 2: Performance Analyst challenges and finalises ────────────────
    const product = (company.products ?? []).find(p => p.name === (brief as any).product);

    // Fetch case studies + audience performance for the Analyst (same data the Strategist sees)
    let analystCaseStudies = '';
    let analystAudiencePerf = '';
    try {
      const [caseStudies, audiencePerf] = await Promise.all([
        this.metaLearningImporter.getRelevantCaseStudies(company.tenantId, { product: product?.name, limit: 5 }),
        this.metaLearningImporter.getAudiencePerformanceSummary(company.tenantId),
      ]);
      if (caseStudies.length > 0) {
        analystCaseStudies = `\nPAST CAMPAIGN CASE STUDIES:\n${caseStudies.slice(0, 5).map((cs, i) => `  ${i + 1}. ${cs.campaignName}: ₹${cs.totalSpend} spent, ${cs.totalConversions} conv, CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}, audiences: ${cs.whatWorked?.audiences?.join(', ') || 'unknown'}`).join('\n')}`;
      }
      const sorted = Object.entries(audiencePerf.byType).filter(([, d]) => d.conversions > 0).sort(([, a], [, b]) => a.avgCPA - b.avgCPA);
      if (sorted.length > 0) {
        analystAudiencePerf = `\nAUDIENCE TYPE PERFORMANCE:\n${sorted.map(([type, d]) => `  - ${type}: CPA ₹${d.avgCPA}, CTR ${d.avgCTR}%, ${d.conversions} conv (${d.adSetCount} ad sets)`).join('\n')}`;
      }
    } catch {
      // Learnings unavailable — proceed without
    }

    // Conditionally include the budget-tier rule. For warm/hot briefs, the
    // "≤₹5k → advantage_plus" rule conflicts with the audienceStage rule
    // (warm/hot CANNOT use advantage_plus). The conflict caused the Performance
    // Analyst to flip lookalike → advantage_plus citing the budget rule. For
    // warm/hot, replace the budget rule with stage-aware ad-set sizing that
    // doesn't mention advantage_plus.
    const briefStageForReview = (brief as any).audienceStage as 'cold' | 'warm' | 'hot' | undefined;
    const isWarmOrHot = briefStageForReview === 'warm' || briefStageForReview === 'hot';
    const adSetCountRule = isWarmOrHot
      ? `2. AD SET COUNT (warm/hot stage — DO NOT downgrade to advantage_plus regardless of budget):
   - Budget ≤₹3,000/day → MUST be 1 ad set, audienceType MUST be lookalike or custom (NOT advantage_plus)
   - Budget ₹3-15k → max 2 ad sets (lookalike + custom retarget). Each ad set needs ₹2,500+/day minimum.
   - Budget >₹15k → max 3 ad sets. Stage-appropriate audiences only.
   - The audienceStage rule WINS over any budget-based simplification — keep lookalike/custom even at small budgets.`
      : `2. AD SET COUNT (cold stage):
   - Budget ≤₹5,000/day → MUST be 1 ad set (advantage_plus is acceptable here for cold prospecting only).
   - Budget ₹5-15k → max 2 ad sets. Each ad set needs ₹3,000+/day minimum.
   - Budget >₹15k → max 3 ad sets.
   - If the Strategist proposed too many ad sets for the budget, consolidate them.`;

    // Targeting-fix rule (#3 in original prompt): for warm/hot, do NOT auto-convert
    // lookalike-without-id to advantage_plus. Keep as lookalike, flag the missing
    // ID, let the launch-time audience guard pick a fallback lookalike.
    const targetingFixRule = isWarmOrHot
      ? `3. TARGETING (warm/hot stage): If a "lookalike" ad set has no metaAudienceId, DO NOT convert to advantage_plus — instead pick a real lookalike audience ID from the AVAILABLE META AUDIENCES list above. If none exists, keep the audienceType as "lookalike" with metaAudienceId=null and let the launch-time guard pick a fallback. NEVER downgrade to advantage_plus for warm/hot.`
      : `3. TARGETING: Fix audience types — if a "lookalike" ad set has no metaAudienceId, convert it to "advantage_plus" (remove metaAudienceId field). Do NOT reject for this — just fix it.`;

    const call2UserMessage = `You are the Performance Analyst reviewing a Meta Ads campaign config for ${company.name}.

Your job: challenge budget, targeting, and timing decisions with data. Be conservative on unproven, aggressive on proven.

PRODUCT DATA:
- Product: ${product?.name ?? 'unknown'} — ₹${product?.price ?? 'N/A'}
- Historical CPA: ₹${product?.performance?.avgCPA ?? 'no data'} | Historical ROAS: ${product?.performance?.avgROAS ?? 'no data'}x
- Total conversions on record: ${product?.performance?.totalConversions ?? 0} (confidence: ${product?.performance?.confidenceLevel ?? 'none'})
- At ₹${product?.performance?.avgCPA ?? '???'} CPA, budget of ₹${brief.suggestedBudget}/day = ~${product?.performance?.avgCPA ? Math.floor(brief.suggestedBudget / product.performance.avgCPA * 7) : '?'} conversions/week expected

CONSTRAINTS:
- Hard budget cap: ₹${company.maxBudgetPerCampaign}/day | Weekly cap: ₹${company.weeklyBudgetCap}
- Pause if ROAS < ${company.pauseIfROASBelow ?? 'not set'} | CTR < ${company.pauseIfCTRBelow ?? 'not set'}
- Max scale: ${company.maxBudgetScalePercent}%
- No past data → conservative start at 50-60% of proposed budget

PROPOSED CAMPAIGN CONFIG TO REVIEW:
${JSON.stringify(call1Parsed.campaign, null, 2)}
${analystCaseStudies}
${analystAudiencePerf}

YOUR JOB:
1. BUDGET: Is the proposed daily budget right for the data available? Adjust if needed.
${adSetCountRule}
${targetingFixRule}
4. GUARDRAILS: Are scaleRules and pauseRules specific enough? (e.g. "ROAS > 2x AND CTR > 0.8% after 48h → scale 20%")
5. RISK: What's the downside scenario? Does the config protect against it?
6. Fix issues directly in the output config. Set approved: true unless there is a fundamental unfixable problem.
7. NEVER reject solely because metaAudienceId or excludeAudienceIds are missing — these are optional operational fields.${isWarmOrHot ? '\n8. NEVER compare advantage_plus CPA to lookalike CPA — they reach different audiences. Apples-to-oranges. CPA comparisons only meaningful WITHIN the same audienceStage.' : ''}

Return ONLY this JSON (no markdown, no explanation):
{
  "approved": true,
  "campaign": {
    "budget": ${brief.suggestedBudget > 0 ? brief.suggestedBudget : Math.round((company.weeklyBudgetCap ?? 20000) * 0.25)},
    "objective": "OUTCOME_SALES",
    "conversionEvent": "${product?.conversionEvent ?? 'Purchase'}",
    "conversionValue": ${product?.conversionValue ?? product?.price ?? 0},
    "adSets": [],
    "scaleRules": "specific ROAS/CTR threshold + scale %",
    "pauseRules": "specific CTR/ROAS threshold + spend amount"
  },
  "adjustments": {
    "budgetAdjusted": false,
    "originalBudget": ${brief.suggestedBudget},
    "recommendedBudget": 0
  },
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed campaign config"},
    {"round": 2, "from": "analyst", "summary": "reviewed and finalised"}
  ],
  "debateRationale": "2-3 sentence summary of changes made and why"
}`;

    const call2 = await this.claudeService.runAgent({
      tenantId, runId,
      agentType: AgentType.CAMPAIGN_REVIEW_LEAD,
      systemPrompt: `You are a Performance Marketing Analyst specializing in Meta Ads for Indian brands. You review campaign configs before they go live. Be data-driven and conservative on unproven campaigns. Always ensure guardrails are specific and actionable.`,
      liveContext: '',
      userMessage: call2UserMessage,
      maxTurns: 3,
      skills: skillsForAgent('CAMPAIGN_REVIEW'),   // critical: ab-test-setup tells Analyst learning-phase math, paid-ads kills cross-stage CPA mistake
    });

    this.logger.log(`Campaign Review Team sequential — Call 2 done | tenant: ${tenantId} | run: ${runId}`);
    return this.parseOutput(call2.content);
  }

  private async fetchMetaAudiences(company: CompanyDocument): Promise<string> {
    try {
      const accessToken = company.meta?.accessToken;
      if (!accessToken) return '';

      const normalizeId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
      const accountIds = ((company.meta!.accountIds?.length ?? 0) > 0
        ? company.meta!.accountIds!
        : [company.meta!.accountId]
      ).map(normalizeId);

      const allAudiences: { id: string; name: string; subtype: string; count: number }[] = [];

      for (const accountId of accountIds) {
        const res = await axios.get(`${META_API_BASE}/${accountId}/customaudiences`, {
          params: {
            fields: 'id,name,subtype,approximate_count_lower_bound',
            limit: '100',
            access_token: accessToken,
          },
          timeout: 15000,
        }).catch(() => ({ data: { data: [] } }));

        for (const a of res.data?.data ?? []) {
          if ((a.approximate_count_lower_bound ?? 0) >= 100) {
            allAudiences.push({
              id: a.id,
              name: a.name,
              subtype: a.subtype ?? 'CUSTOM',
              count: a.approximate_count_lower_bound ?? 0,
            });
          }
        }
      }

      if (allAudiences.length === 0) return '';

      const lines = allAudiences
        .sort((a, b) => b.count - a.count)
        .slice(0, 30)
        .map(a => `  - id: "${a.id}" | name: "${a.name}" | type: ${a.subtype} | size: ~${a.count.toLocaleString()}`);

      return `═══════════════════════════════════════════════════════
AVAILABLE META AUDIENCES (use these real IDs in adSets)
═══════════════════════════════════════════════════════
${lines.join('\n')}

Rules:
- audienceType "lookalike" → pick a LOOKALIKE audience from above
- audienceType "retarget" or "custom" → pick a CUSTOM audience from above
- audienceType "advantage_plus" → no metaAudienceId needed
- Only use IDs from this list — never invent audience IDs`;
    } catch {
      return '';
    }
  }

  private async buildCall1Prompt(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      suggestedBudget: number;
      product?: string;
      audienceStage?: 'cold' | 'warm' | 'hot';
    },
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): Promise<string> {
    const fullPrompt = await this.buildPrompt(brief, creativePackage, company, runId);

    // Strip STEPS section and replace with a direct "propose config" instruction
    const stepsIdx = fullPrompt.indexOf('═══════════════════════════════════════════════════════\nSTEPS');
    const withoutSteps = stepsIdx !== -1 ? fullPrompt.slice(0, stepsIdx).trimEnd() : fullPrompt;

    const product = (company.products ?? []).find(p => p.name === (brief as any).product);

    const audienceContext = await this.fetchMetaAudiences(company);

    return `${withoutSteps}

${audienceContext}

═══════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════

This is Phase 1 of a 2-phase review. A Performance Analyst will review your config separately.
Do NOT approve your own work. Just propose the best campaign config you can based on all the data above.
Use real metaAudienceId values from the AVAILABLE META AUDIENCES list above when proposing lookalike, retarget, or custom ad sets.

Return ONLY this JSON (no markdown, no explanation):
{
  "approved": true,
  "campaign": {
    "budget": ${brief.suggestedBudget > 0 ? brief.suggestedBudget : Math.round((company.weeklyBudgetCap ?? 20000) * 0.25)},
    "objective": "OUTCOME_SALES",
    "conversionEvent": "${product?.conversionEvent ?? 'Purchase'}",
    "conversionValue": ${product?.conversionValue ?? product?.price ?? 0},
    "adSets": [
      {
        "name": "ADVANTAGE_PLUS_BROAD",
        "budgetPercent": 100,
        "audienceType": "advantage_plus",
        "geoLocations": ["IN"],
        "optimizationGoal": "OFFSITE_CONVERSIONS",
        "ads": [0, 1, 2, 3],
        "creativeFormat": "mixed"
      }
    ],
    "scaleRules": "ROAS > 1.5x AND conversions >= 2 after 7d → scale 20%",
    "pauseRules": "CTR < 0.5% after ₹${Math.round((product?.performance?.avgCPA ?? 2000) * 3)} spent → pause ad"
  },
  "adjustments": {
    "budgetAdjusted": false,
    "originalBudget": ${brief.suggestedBudget},
    "recommendedBudget": 0
  },
  "debateRounds": 1,
  "debateLog": [{"round": 1, "from": "strategist", "summary": "proposed campaign config"}],
  "debateRationale": "initial proposal — awaiting analyst review"
}`.trim();
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
      product?: string;
      audienceStage?: 'cold' | 'warm' | 'hot';
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
      const perf = product.performance;
      return `PRODUCT BEING SOLD:
  ${product.name} — ₹${product.price}
  Landing: ${product.landingUrl ?? 'not set'}
  Conversion event: ${product.conversionEvent ?? 'Purchase'} (each conversion = ₹${product.conversionValue ?? product.price})
  Past performance: ${perf?.totalConversions ?? 0} conversions, CPA ₹${perf?.avgCPA ?? 'N/A'}, ROAS ${perf?.avgROAS ?? 'N/A'}x (${perf?.confidenceLevel ?? 'no data'})

AVAILABLE AUDIENCE SEGMENTS:
${segments || '  none defined'}`;
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

    const selectedCopyIndex = creativePackage?.selectedCopyIndex ?? 0;

    const variantCount = (creativePackage as any)?.copyVariants?.length ?? 0;
    const allVariantsArr = variantCount > 0
      ? `[${Array.from({ length: variantCount }, (_, i) => i).join(', ')}]`
      : `[0, 1, 2, 3]`;

    // ── Audience-stage branch — drives ad-set targeting choice ───────────────
    // The Strategy Team labels each brief cold | warm | hot. Without branching here,
    // a hot cart-recovery brief launches as cold prospecting (advantage_plus broad)
    // — wrong audience entirely, all spend wasted on people who already saw the
    // product but didn't convert. Each stage demands a different ad-set shape.
    const audienceStage = brief.audienceStage ?? 'cold';
    const audienceStageBlock = audienceStage === 'hot'
      ? `AUDIENCE STAGE: HOT (cart-recovery / abandoned-checkout)
- This brief targets people who started checkout in the last 30 days but did not buy.
- HARD REQUIREMENT (overrides budget-tier rule): ad sets MUST use a custom audience of cart-abandoners (look for "Cart" / "AddToCart" / "Abandoned" in AVAILABLE META AUDIENCES).
- FORBIDDEN: "advantage_plus", "broad", "interest" — these are cold prospecting types and defeat the hot-stage intent. Do NOT downgrade to advantage_plus even at ≤₹5k.
- If no cart-abandoner audience exists → fall back to "Visitors_30d" custom audience, then a tight LAL with Purchasers exclude.
- Budget: hot is smallest, highest-intent — use 1 ad set, max ₹2,000/day (distribution bounded by audience size, not budget).`
      : audienceStage === 'warm'
      ? `AUDIENCE STAGE: WARM (retargeting / past visitors / lookalike-of-buyers)
- This brief targets people who interacted with the brand or look like past buyers — not cold prospecting.
- HARD REQUIREMENT (overrides budget-tier rule below): ad sets MUST use one of: "lookalike", "retarget", "custom" audienceType.
- FORBIDDEN: "advantage_plus" or "broad" audienceType. These are COLD prospecting types and defeat the warm-stage intent.
  Even at ≤₹5k budget, do NOT downgrade warm to advantage_plus. The audienceStage rule wins over the budget-tier rule.
- HARD REQUIREMENT: every ad set must have a metaAudienceId from the AVAILABLE META AUDIENCES list (lookalike or custom).
- DO NOT compare advantage_plus CPA to lookalike CPA — they target different audiences. Apples-to-oranges.
  Only compare CPA WITHIN the same audienceStage (lookalike vs another lookalike, etc.).
- Use 1-2 ad sets max — visitors retarget + LAL are usually enough at warm stage.
- Always exclude past Purchasers from these ad sets (don't pay to retarget existing buyers).`
      : `AUDIENCE STAGE: COLD (prospecting — first-time exposure)
- This brief targets people who haven't engaged with the brand yet.
- Standard prospecting: advantage_plus + (lookalike-1% if available) + (interest-based if you have real Meta interest IDs).
- Excluded audiences: ALWAYS exclude past Purchasers and recent Visitors from prospecting ad sets — don't pay to re-show ads to people already in the funnel.
- Use 1-3 ad sets following the AD SET COUNT rules below.`;

    const formatSection = hasFormatData
      ? `CREATIVE FORMAT — video vs image per ad set:
Each ad set must have "creativeFormat": "video" | "image" | "mixed" | "both".
Format performance: Winning: ${winningFormats.join(', ')}. Losing: ${losingFormats.join(', ') || 'none'}.
- Assign winning format to largest budget ad sets. Test the other on smallest budget ad set.
- If both winning → split test across ad sets, or use "mixed".
- Budget < ₹1,500/day → don't split, use winning format only.
IMPORTANT: Video was generated for Variant ${selectedCopyIndex} only. Image was generated for ALL ${variantCount || 4} variants.
- "mixed" (RECOMMENDED for prospecting): use ads: ${allVariantsArr} — selected variant ships as video, others as image. 1 video + ${Math.max(variantCount - 1, 3)} image ads in one ad set.
- "video" ad sets → must use ads: [${selectedCopyIndex}] only (single video, video matches this variant's hook)
- "image" ad sets → use ads: ${allVariantsArr} (each variant has its own image)
- "both" → DEPRECATED for prospecting (creates duplicate ads). Use "mixed" instead.`
      : `CREATIVE FORMAT — video vs image per ad set:
Each ad set must have "creativeFormat": "video" | "image" | "mixed" | "both".
No format data yet. Decide from first principles:
- Prospecting / advantage_plus / lookalike / broad → "mixed" (1 video + N image, lets Meta pick).
- Retargeting / past visitors → "image" (warm audience, simpler ads convert).
- Pure video test (rare) → "video" but only if you have strong reason (e.g. demo product).
- Budget < ₹1,500/day → "image" only — don't split formats.
IMPORTANT: Video was generated for Variant ${selectedCopyIndex} only. Image was generated for ALL ${variantCount || 4} variants.
- "mixed" (RECOMMENDED for prospecting): use ads: ${allVariantsArr} — selected variant ships as video, others as image. 1 video + ${Math.max(variantCount - 1, 3)} image ads in one ad set.
- "video" ad sets → must use ads: [${selectedCopyIndex}] only (single video, video matches this variant's hook)
- "image" ad sets → use ads: ${allVariantsArr} (each variant has its own image)
- "both" → DEPRECATED for prospecting (creates duplicate ads, reuses single video across all variants). Use "mixed" instead.`;

    // ═════════════════════════════════════════════════════════════════════════
    // PROMPT: Data first → Rules → Steps
    // ═════════════════════════════════════════════════════════════════════════
    return `
${buildSkillBlock('CAMPAIGN_REVIEW')}
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

Copy Variants (use index when assigning ads[] in ad sets):
${((creativePackage as any)?.copyVariants ?? []).length > 0
  ? (creativePackage as any).copyVariants.map((v: any, i: number) =>
    `  Variant ${i} [hookStyle: ${v.hookStyle ?? 'unknown'}]${i === ((creativePackage as any).selectedCopyIndex ?? 0) ? ' ← SELECTED' : ''}
    Headline: ${v.headline}
    Hook: ${v.primaryText?.split('\n')[0] ?? ''}
    CTA: ${v.cta}`
  ).join('\n')
  : `  Variant 0 [hookStyle: unknown] ← SELECTED\n  Headline: ${selectedCopy?.headline ?? 'N/A'}\n  Hook: ${selectedCopy?.primaryText?.split('\n')[0] ?? 'N/A'}\n  CTA: ${selectedCopy?.cta ?? 'N/A'}`
}
Images: ${(creativePackage as any)?.images?.filter((img: any) => img.imageUrl).length ?? 0}/${variantCount || 4} generated
Video: ${(creativePackage as any)?.video?.videoUrl ? 'Generated' : 'Pending'}

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
- Number of ad sets depends on budget (see AD SET COUNT below). Each ad set MUST have a different audience.
- Use real Meta audience IDs from the product data — don't invent IDs.
- No Meta audiences → use audienceType "advantage_plus" (NOT "interest" without real IDs).
- Exclude past buyer audiences from prospecting ad sets.
- "ads" array: assign copy variants by index using hookStyle from the variants listed above:
  * Prospecting / lookalike / broad / advantage_plus → ALL variants ${allVariantsArr} — let Meta optimize across all hooks
  * Interest-based cold → ALL variants ${allVariantsArr}
  * Retargeting / past visitors → only the variant whose hookStyle is "social_proof", "urgency", or "price_anchor" — check hookStyle above and pick that index
  * If no retargeting-appropriate hookStyle exists → use selected variant only e.g. [${selectedCopyIndex}]
  * Never assign "curiosity", "problem_awareness", or "question" hookStyle to retargeting — they already know the problem
- budgetPercent across all ad sets must sum to 100.

${audienceStageBlock}

${formatSection}

AD SET COUNT (scale to budget):
- Budget ≤ ₹5,000/day → 1 ad set (advantage_plus). Concentrate all signal. Do NOT split.
- Budget ₹5,000–15,000/day → max 2 ad sets (1 advantage_plus + 1 audience-based if valid audiences exist)
- Budget > ₹15,000/day → up to 3 ad sets (advantage_plus + lookalike + retarget/custom)
- Each ad set needs ₹3,000+/day minimum to have any chance of exiting Meta's learning phase.
- The audit loop will add retarget/narrowed ad sets later based on performance data — don't over-segment at launch.

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

    FIRST ACTION (do this immediately before anything else):
    Call TaskCreate(name: 'waiting-for-brief', body: 'waiting for Campaign Director to send the campaign brief'). Stay alive and keep waiting until their message arrives. Do NOT produce any output until you receive their message.

    REVIEW PROTOCOL:
    - You will receive a campaign brief with a CONTEXT BRIEF containing key performance data.
    - Use the data to challenge budget, targeting, and timing decisions.
    - Evaluate: (1) BUDGET — too high for a first run? (2) TARGETING — too broad/narrow? (3) TIMING — right moment? (4) RISK — what if it flops? (5) GUARDRAILS — what triggers scale/pause?
    - Be data-driven. Push for conservative budgets on unproven concepts, aggressive on proven ones.
    - After each response, call TaskCreate to wait for the next message.
    - When the Strategist pushes back, either concede with data or hold firm with data.
    - Max 5 rounds. When you agree, send: {type: 'consensus', approved: true/false} via SendMessage(to: 'team-lead').
    - When you receive a shutdown_request: reply with {type: 'shutdown_confirmed'} via SendMessage(to: 'team-lead') then stop."

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
        "name": "ADVANTAGE_PLUS_BROAD",
        "budgetPercent": 100,
        "audienceType": "advantage_plus",
        "geoLocations": ["IN"],
        "optimizationGoal": "OFFSITE_CONVERSIONS",
        "ads": [0, 1, 2, 3],
        "creativeFormat": "mixed"
      }
    ],
    "scaleRules": "ROAS > 1.5x AND conversions >= 2 after 7d �� scale 20%",
    "pauseRules": "CTR < 0.5% after ₹${Math.round((product?.performance?.avgCPA ?? 2000) * 3)} spent → pause ad"
  },
  "adjustments": {
    "budgetAdjusted": false,
    "originalBudget": ${brief.suggestedBudget},
    "recommendedBudget": 0
  },
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed campaign config"},
    {"round": 1, "from": "analyst", "summary": "reviewed and adjusted"},
    {"round": 2, "from": "strategist", "summary": "accepted adjustments"},
    {"round": 2, "from": "analyst", "summary": "approved final config"}
  ],
  "debateRationale": "2-3 sentence summary"
}
    `.trim();
  }

  private parseOutput(content: string): CampaignReviewOutput {
    let jsonStr = '';
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      const parsed: CampaignReviewOutput = JSON.parse(jsonStr);

      // Validate budgetPercent sums to 100 — fix by normalising if off
      const adSets = parsed.campaign?.adSets ?? [];
      if (adSets.length > 0) {
        const total = adSets.reduce((sum, s) => sum + (s.budgetPercent ?? 0), 0);
        if (total !== 100) {
          this.logger.warn(`budgetPercent sums to ${total}, not 100 — normalising`);
          adSets.forEach(s => { s.budgetPercent = Math.round((s.budgetPercent / total) * 100); });
          // Fix rounding drift on last ad set
          const diff = 100 - adSets.reduce((sum, s) => sum + s.budgetPercent, 0);
          adSets[adSets.length - 1].budgetPercent += diff;
        }
      }

      return parsed;
    } catch (err: any) {
      this.logger.error(`Campaign Review Team output parse failed: ${err.message} | content snippet: ${content.slice(0, 300)}`);
      throw new Error(`Campaign Review Team returned invalid JSON: ${err.message}`);
    }
  }
}
