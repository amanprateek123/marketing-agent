import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { AgentType } from '../claude/claude.types';
import { ClaudeService } from '../claude/claude.service';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
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

/**
 * Brief input to the Campaign Review Team. Mirrors the IntelligenceBrief
 * fields the review team actually reads. winnerCloneOf is the exploit-winner
 * marker — when set, Campaign Review skips the 50-60% cold-start budget cut
 * and defaults to the source winner's budgetTier (still subject to TS safety caps).
 */
export interface CampaignReviewBriefInput {
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
  targetLanguage?: string;
  winnerCloneOf?: {
    sourceCampaignId: string;
    sourceBriefId: string;
    metaAdId: string;
    hookStyle: string;
    audienceType: string;
    format?: 'video' | 'image';
    budgetTier: number;
    sourceCPA: number;
    sourceROAS: number;
    clonedAt: Date;
  };
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
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  async review(
    brief: CampaignReviewBriefInput,
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
    brief: CampaignReviewBriefInput,
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
    brief: CampaignReviewBriefInput,
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
    // FUNNEL-STAGE TAXONOMY (industry-standard):
    //   cold = lookalikes / interests / advantage_plus / broad — anyone who hasn't engaged
    //   warm = custom-audience retargeting (site visitors / engagers / video viewers)
    //   hot  = cart abandoners / initiate_checkout / 30d engaged
    // Lookalikes are NEVER warm — being a lookalike of a buyer ≠ engaging with our brand.
    const briefStageForReview = (brief as any).audienceStage as 'cold' | 'warm' | 'hot' | undefined;
    const isWarmOrHot = briefStageForReview === 'warm' || briefStageForReview === 'hot';
    const adSetCountRule = isWarmOrHot
      ? `2. AD SET COUNT (warm/hot stage — RETARGETING ONLY, no prospecting audiences):
   - audienceType MUST be "custom" or "retarget" (NOT lookalike, NOT advantage_plus, NOT interest — those are cold-prospecting)
   - Budget ≤₹3,000/day → MUST be 1 ad set, custom-audience retargeting
   - Budget ₹3-15k → max 2 ad sets (e.g. 7d engagers + cart-abandoners). Each ad set needs ₹2,000+/day minimum.
   - Budget >₹15k → max 3 ad sets, all retargeting custom audiences.
   - If no custom/retarget audience is available in AVAILABLE META AUDIENCES, REJECT the campaign — do not silently downgrade to a cold audience type.`
      : `2. AD SET COUNT (cold stage):
   - Budget ≤₹5,000/day → MUST be 1 ad set (advantage_plus or lookalike, both fine for cold prospecting).
   - Budget ₹5-15k → max 2 ad sets. Each ad set needs ₹3,000+/day minimum.
   - Budget >₹15k → max 3 ad sets.
   - If the Strategist proposed too many ad sets for the budget, consolidate them.`;

    // Targeting-fix rule: warm/hot must use retargeting custom audiences. If
    // none exist for the product, REJECT — don't fall back to lookalike (which
    // is cold) or advantage_plus (also cold). Cold can use any prospecting type.
    const targetingFixRule = isWarmOrHot
      ? `3. TARGETING (warm/hot stage):
   (a) audienceType MUST be "custom" or "retarget" pointing to a real custom-audience metaAudienceId. If a proposed ad set has audienceType "lookalike" / "advantage_plus" / "interest", that's a category error — REJECT the campaign with reason "warm/hot brief requires retargeting custom audience, got cold-prospecting type". Do NOT silently rewrite to a different type.
   (b) HARD REQUIREMENT — every retarget/custom ad set MUST have a non-empty metaAudienceId pointing to a real custom audience from the AVAILABLE META AUDIENCES list above. Setting audienceType="retarget" without metaAudienceId is the worst possible failure mode: at launch, Meta sees no custom_audiences attached and silently delivers as Advantage+ broad — your warm-stage copy gets served to cold prospecting traffic. If no valid custom audience ID is available for this brief's audience description, REJECT the campaign with reason "no custom audience available for warm/hot retargeting". Never approve a retarget/custom ad set with metaAudienceId missing, null, or empty string.`
      : `3. TARGETING (cold stage): Fix audience types — if a "lookalike" ad set has no metaAudienceId, convert it to "advantage_plus" (remove metaAudienceId field). Do NOT reject for this — just fix it.`;

    const call2UserMessage = `You are the Performance Analyst reviewing a Meta Ads campaign config for ${company.name}.

Your job: challenge budget, targeting, and timing decisions with data. Be conservative on unproven, aggressive on proven.

PRODUCT DATA:
- Product: ${product?.name ?? 'unknown'} — ₹${product?.price ?? 'N/A'}
- Historical CPA: ₹${product?.performance?.avgCPA ?? 'no data'} | Historical ROAS: ${product?.performance?.avgROAS ?? 'no data'}x
- Total conversions on record: ${product?.performance?.totalConversions ?? 0} (confidence: ${product?.performance?.confidenceLevel ?? 'none'})
- At ₹${product?.performance?.avgCPA ?? '???'} CPA, budget of ₹${brief.suggestedBudget}/day = ~${product?.performance?.avgCPA ? Math.floor(brief.suggestedBudget / product.performance.avgCPA * 7) : '?'} conversions/week expected

CONSTRAINTS:
- BUDGET IS DAILY ₹/day ONLY. This system does not support Meta lifetime_budget. Never propose a "lifetime"/"total" amount — always ₹/day.
- Hard daily cap: ₹${company.maxBudgetPerCampaign}/day | Weekly cap: ₹${company.weeklyBudgetCap}
- "budget" you write MUST be ≤ ₹${company.maxBudgetPerCampaign}. Larger numbers are silently clamped and break your guardrail math.
- Pause if ROAS < ${company.pauseIfROASBelow ?? 'not set'} | CTR < ${company.pauseIfCTRBelow ?? 'not set'}
- Max scale: ${company.maxBudgetScalePercent}%
- No past data → conservative start at 50-60% of proposed daily budget

PROPOSED CAMPAIGN CONFIG TO REVIEW:
${JSON.stringify(call1Parsed.campaign, null, 2)}
${analystCaseStudies}
${analystAudiencePerf}

YOUR JOB:
1. BUDGET: Is the proposed DAILY budget (₹/day) right for the data available? Adjust if needed. MUST be ≤ ₹${company.maxBudgetPerCampaign}/day. Never write a multi-day total — always per-day.
${adSetCountRule}
${targetingFixRule}
4. GUARDRAILS: Are scaleRules and pauseRules specific enough? (e.g. "ROAS > 2x AND CTR > 0.8% after 48h → scale 20%")
5. RISK: What's the downside scenario? Does the config protect against it?
6. AUDIENCE-CREATIVE COHERENCE: The brief's audienceStage is "${briefStageForReview ?? 'cold'}". Cold copy assumes the viewer has never heard of the brand (problem-first, brand-introduction); warm copy assumes prior engagement (offer-recall, objection-handling); hot copy assumes high intent (cart-recovery urgency). If the audienceStage label doesn't match what the audience is actually going to be on Meta (e.g. brief says "warm" but audience is a 1-5% lookalike of buyers — that's still cold prospecting because lookalikes have not engaged with the brand), DOWNGRADE the audienceStage to the truthful funnel position rather than approve a mismatched campaign. Lookalikes / advantage_plus / interest = cold; only custom audiences of past engagers = warm/hot.
7. Fix issues directly in the output config. Set approved: true unless there is a fundamental unfixable problem.
8. NEVER reject solely because metaAudienceId or excludeAudienceIds are missing — these are optional operational fields.${isWarmOrHot ? '\n9. NEVER compare advantage_plus CPA to lookalike CPA — they reach different audiences. Apples-to-oranges. CPA comparisons only meaningful WITHIN the same audienceStage.' : ''}

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

  /**
   * Compute per-audience historical performance from past launched campaigns.
   * Joins on `campaignConfig.adSets[].metaAudienceId` and rolls up the
   * matching `metaAdSets[].{spend,conversions}` from the same ad-set name.
   * Returns Map<audienceId, perf>.
   */
  private async computeAudiencePerformance(
    tenantId: string,
  ): Promise<Map<string, { campaigns: number; spend: number; convs: number; cpa: number; lastUsed: Date | null }>> {
    const out = new Map<string, { campaigns: number; spend: number; convs: number; cpa: number; lastUsed: Date | null }>();
    try {
      const launched = await this.campaignModel
        .find({ tenantId, metaCampaignId: { $exists: true, $ne: '' } }, { campaignConfig: 1, metaAdSets: 1, launchedAt: 1, spend: 1, conversions: 1 })
        .lean()
        .exec();
      for (const c of launched) {
        const cfg = (c as any).campaignConfig;
        const live = (c as any).metaAdSets ?? [];
        const cfgAdSets = cfg?.adSets ?? [];
        const launchedAt: Date | null = (c as any).launchedAt ?? null;

        for (const cfgAs of cfgAdSets) {
          const audId = cfgAs?.metaAudienceId;
          if (!audId) continue;

          // Prefer ad-set-level metrics from metaAdSets[]; fall back to top-level
          // campaign metrics when metaAdSets is empty AND there's only one ad set
          // (so top-level == ad-set level). Avoids dropping the May 4 MARRIAGE
          // campaign's ₹5,989 spend / 1 conv from learning.
          const liveMatch = live.find((l: any) => l.name === cfgAs.name);
          let spend: number, convs: number;
          if (liveMatch) {
            spend = liveMatch.spend ?? 0;
            convs = liveMatch.conversions ?? 0;
          } else if (cfgAdSets.length === 1) {
            spend = (c as any).spend ?? 0;
            convs = (c as any).conversions ?? 0;
          } else {
            // Multi-ad-set campaign with no metaAdSets sync — can't attribute, skip
            continue;
          }

          const prev = out.get(audId) ?? { campaigns: 0, spend: 0, convs: 0, cpa: 0, lastUsed: null };
          prev.campaigns += 1;
          prev.spend += spend;
          prev.convs += convs;
          if (launchedAt && (!prev.lastUsed || launchedAt > prev.lastUsed)) prev.lastUsed = launchedAt;
          out.set(audId, prev);
        }
      }
      // Compute CPA after rollup
      for (const v of out.values()) v.cpa = v.convs > 0 ? Math.round(v.spend / v.convs) : 0;
    } catch (err: any) {
      this.logger.warn(`Audience performance rollup failed: ${err.message}`);
    }
    return out;
  }

  /**
   * Score how well an audience matches the brief's stated audience description.
   * Pure deterministic — no LLM. Returns HIGH | MEDIUM | LOW | NOT.
   * The LLM still picks; this is just signal, not a hard rule.
   */
  private scoreBriefFit(audienceName: string, briefAudienceText: string): 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT' {
    const a = audienceName.toLowerCase();
    const b = (briefAudienceText ?? '').toLowerCase();
    const isLal = /lookalike|lal\b|\dpct|\d%/.test(a);
    const isVisitor = /visitor|visit|traffic|landing/.test(a);
    const isPurchaser = /purchaser|customer|buyer|purchase/.test(a);

    // Brief intent signals
    const briefVisitor = /visitor|tried|didn.?t buy|didn.?t purchase|abandon|cart|left|browsed|came to|landing/.test(b);
    const briefPurchaser = /past buyer|past customer|repeat|upsell|already bought|previous buyer/.test(b);
    const briefProspect = /lookalike|similar to|people like|prospecting|new audience|cold|first.?time|discovery/.test(b);

    // Visitor retarget brief → custom visitor audience
    if (briefVisitor && isVisitor) return 'HIGH';
    if (briefVisitor && isPurchaser) return 'NOT';      // upselling buyers ≠ recovering visitors
    // Upsell brief → past customer audience
    if (briefPurchaser && isPurchaser) return 'HIGH';
    if (briefPurchaser && isVisitor) return 'LOW';
    // Cold prospecting brief → lookalike (tight first)
    if (briefProspect && isLal) return 'HIGH';
    if (briefProspect && isVisitor) return 'NOT';       // visitors aren't a prospecting pool
    if (briefProspect && isPurchaser) return 'NOT';

    // No clear signal — light token overlap as fallback
    const tokens = a.split(/[_\s\d%-]+/).filter(t => t.length > 3);
    const overlap = tokens.filter(t => b.includes(t)).length;
    if (overlap >= 2) return 'MEDIUM';
    if (overlap >= 1) return 'LOW';
    return 'LOW';
  }

  private async fetchMetaAudiences(
    company: CompanyDocument,
    brief?: { audience?: string; audienceStage?: 'cold' | 'warm' | 'hot' },
  ): Promise<string> {
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

      // Sort lookalikes tightest-first; custom audiences by size (more reach for retargeting).
      // Tighter lookalikes (1%) have ~3x the conversion-intent density of looser (2-3%).
      const parseLookalikePercent = (name: string): number => {
        const m = name.match(/(\d+)\s*[-–]\s*(\d+)\s*%|(\d+)\s*%|(\d+)\s*pct\b/i);
        if (!m) return 99;
        return parseInt(m[1] ?? m[3] ?? m[4], 10);
      };
      const isLookalike = (a: { subtype: string }) => /LOOKALIKE/i.test(a.subtype);
      const lookalikes = allAudiences
        .filter(isLookalike)
        .sort((a, b) => parseLookalikePercent(a.name) - parseLookalikePercent(b.name));
      const customs = allAudiences
        .filter(a => !isLookalike(a))
        .sort((a, b) => b.count - a.count);

      // Performance rollup + brief-fit scoring (parts A + C of context enrichment)
      const perfMap = await this.computeAudiencePerformance(company.tenantId);
      const briefAudienceText = brief?.audience ?? '';
      const stage = brief?.audienceStage ?? 'cold';
      const todayMs = Date.now();
      const fmtAge = (d: Date | null) => {
        if (!d) return 'never used';
        const days = Math.max(0, Math.round((todayMs - new Date(d).getTime()) / 86400000));
        return days === 0 ? 'today' : `${days}d ago`;
      };

      const renderAudience = (a: { id: string; name: string; subtype: string; count: number }, pickedTop: boolean): string => {
        const perf = perfMap.get(a.id);
        const fit = briefAudienceText ? this.scoreBriefFit(a.name, briefAudienceText) : 'LOW';
        const star = pickedTop ? '★ ' : '  ';
        const histLine = perf
          ? `History: ${perf.campaigns} campaign(s), ₹${Math.round(perf.spend).toLocaleString()} spent, ${perf.convs} conv${perf.convs > 0 ? `, CPA ₹${perf.cpa.toLocaleString()}` : ''}, last used ${fmtAge(perf.lastUsed)}`
          : `History: 0 prior campaigns (untested — confidence: low)`;
        const fitLine = `Brief-fit: ${fit}`;
        return `${star}id: "${a.id}" | name: "${a.name}" | type: ${a.subtype} | size: ~${a.count.toLocaleString()}
     ${histLine}
     ${fitLine}`;
      };

      // Pick top-ranked candidate per stage to mark with ★. The "best" pick is:
      // 1. highest brief-fit, then 2. lowest historical CPA (if convs ≥ 3 = enough signal),
      // then 3. tightness for lookalikes / size for customs.
      const fitRank = { HIGH: 3, MEDIUM: 2, LOW: 1, NOT: 0 } as const;
      const pickStarFor = (pool: typeof allAudiences): string | null => {
        if (pool.length === 0) return null;
        const scored = pool.map(a => {
          const perf = perfMap.get(a.id);
          const fit = briefAudienceText ? this.scoreBriefFit(a.name, briefAudienceText) : 'LOW';
          const fitScore = fitRank[fit];
          const cpaScore = perf && perf.convs >= 3 ? -perf.cpa : 0; // lower CPA = better; 0 if untested
          return { a, fitScore, cpaScore };
        }).sort((x, y) => y.fitScore - x.fitScore || y.cpaScore - x.cpaScore);
        return scored[0]?.a.id ?? null;
      };

      const lalStarId = stage === 'cold' ? pickStarFor(lookalikes) : null;
      const customStarId = (stage === 'warm' || stage === 'hot') ? pickStarFor(customs) : null;

      const coldBlock = lookalikes.length > 0
        ? `┃ COLD prospecting candidates (use when audienceStage=cold; advantage_plus is also valid):\n┃\n${lookalikes.slice(0, 10).map(a => `┃ ${renderAudience(a, a.id === lalStarId)}`).join('\n┃\n')}`
        : '┃ COLD: no lookalike audiences configured. Use audienceType=advantage_plus (no metaAudienceId).';

      const warmBlock = customs.length > 0
        ? `┃ WARM/HOT retargeting candidates (use when audienceStage=warm|hot):\n┃\n${customs.slice(0, 10).map(a => `┃ ${renderAudience(a, a.id === customStarId)}`).join('\n┃\n')}`
        : '┃ WARM/HOT: no custom audiences configured. REJECT warm/hot briefs in this state.';

      return `═══════════════════════════════════════════════════════
AVAILABLE META AUDIENCES — performance + brief-fit (★ = top pick for THIS brief's stage)
═══════════════════════════════════════════════════════
This brief's audienceStage = ${stage.toUpperCase()}. Audience description = "${briefAudienceText.slice(0, 200)}"

${coldBlock}

${warmBlock}

DECISION RULE:
- Pick the ★ audience for your stage unless you have a specific reason. If you skip ★, your selectionReason MUST cite either (a) historical performance data showing a different audience converts better, (b) saturation evidence on the ★ audience, or (c) a brief specific that the ★ audience can't satisfy. "I prefer X" without data is not a valid reason.
- Brief-fit interpretation:
    HIGH    = audience is a direct semantic match to brief intent
    MEDIUM  = adjacent / partial match
    LOW     = no specific match but structurally valid for the stage
    NOT     = WRONG stage or wrong intent — never pick (e.g. past buyers for prospecting brief)
- History interpretation:
    convs ≥ 5 + CPA close to product avg = proven; trust the audience
    convs < 3 OR no prior campaigns = untested; default to ★ unless you can justify otherwise
    CPA > 2x product avg = audience underperforms; avoid even if it's the only option in stage
- Lookalike tightness: 1% > 1-2% > 2-3%. Step up to looser only if daily budget > ₹10k AND tighter pool exhausted.
- audienceType "advantage_plus" → no metaAudienceId needed (only valid for cold).
- Only use IDs from above — never invent.`;
    } catch (err: any) {
      this.logger.warn(`fetchMetaAudiences failed: ${err.message}`);
      return '';
    }
  }

  private async buildCall1Prompt(
    brief: CampaignReviewBriefInput,
    creativePackage: any,
    company: CompanyDocument,
    runId: string,
  ): Promise<string> {
    const fullPrompt = await this.buildPrompt(brief, creativePackage, company, runId);

    // Strip STEPS section and replace with a direct "propose config" instruction
    const stepsIdx = fullPrompt.indexOf('═══════════════════════════════════════════════════════\nSTEPS');
    const withoutSteps = stepsIdx !== -1 ? fullPrompt.slice(0, stepsIdx).trimEnd() : fullPrompt;

    const product = (company.products ?? []).find(p => p.name === (brief as any).product);

    const audienceContext = await this.fetchMetaAudiences(company, brief);

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
    brief: CampaignReviewBriefInput,
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
Target language: ${brief.targetLanguage ?? 'hinglish (default)'}

═══════════════════════════════════════════════════════
AUDIENCE×LANGUAGE×GEO ALIGNMENT — VALIDATE BEFORE APPROVING
═══════════════════════════════════════════════════════

The creative is being produced in **${brief.targetLanguage ?? 'hinglish'}**. The ad sets' geo targeting MUST be linguistically aligned with this language — otherwise we burn budget reaching people who don't read/speak it.

Recommended geo per language (state-level region keys, Meta India geo-targets):
${brief.targetLanguage === 'marathi'
  ? '  marathi → CORE: Maharashtra (1735), Goa (1733). DIASPORA (high-AOV reach): Karnataka (1738 — Belgaum/Bangalore), Madhya Pradesh (1739 — Indore/Bhopal), Gujarat (1729 — Surat). REJECT if geoStates spans Hindi-belt without explanation — those states have minimal Marathi audience.'
  : brief.targetLanguage === 'tamil'
  ? '  tamil → CORE: Tamil Nadu (1744). DIASPORA: Karnataka (1738 — Bangalore Tamil), Telangana (4100 — Hyderabad Tamil). REJECT if geoStates is Hindi-belt — Tamil-locale targeting outside South India is mostly waste.'
  : brief.targetLanguage === 'telugu'
  ? '  telugu → CORE: Telangana (4100), Andhra Pradesh (1724). DIASPORA: Karnataka (1738). REJECT if geoStates is Hindi-belt.'
  : brief.targetLanguage === 'kannada'
  ? '  kannada → CORE: Karnataka (1738). DIASPORA: minimal (border states). REJECT if geoStates is Hindi-belt or far-South.'
  : brief.targetLanguage === 'bengali'
  ? '  bengali → CORE: West Bengal (1755). DIASPORA: minimal. REJECT if geoStates is Hindi-belt or South India.'
  : brief.targetLanguage === 'gujarati'
  ? '  gujarati → CORE: Gujarat (1729). DIASPORA: Maharashtra (1735 — Mumbai Gujarati business community), Delhi (1728). REJECT if geoStates is Hindi-belt-only without Maharashtra/Delhi.'
  : brief.targetLanguage === 'punjabi'
  ? '  punjabi → CORE: Punjab (1742), Haryana (1730). DIASPORA: Delhi (1728). REJECT if geoStates is South or East India.'
  : brief.targetLanguage === 'hindi'
  ? '  hindi → CORE: Hindi belt (Delhi 1728, UP 1754, MP 1739, Rajasthan 1743, Haryana 1730, Bihar 1726, Jharkhand 1734, Uttarakhand 1745, HP 1737, Chhattisgarh 1727). DIASPORA: metro Hindi-speakers in Maharashtra (1735), Karnataka (1738), Gujarat (1729). REJECT if geoStates is South-only (Tamil Nadu/Kerala) — Hindi reach there is minimal.'
  : brief.targetLanguage === 'english'
  ? '  english → CORE: metro tier-1 only — Delhi (1728), Maharashtra (1735 = Mumbai), Karnataka (1738 = Bangalore). DIASPORA: Hyderabad (4100), Kerala (1736). REJECT if geoStates spans Tier-2/3 — pure English ads in those geos waste budget.'
  : '  hinglish (default Indian DTC) → all 10 INDIA_TOP_ASTROLOGY_STATES are valid. Use top-by-purchase-intent.'}

Validation directive:
1. Read each ad set's geoStates (Meta region keys).
2. Check if those states are in the CORE list above. If yes → approve geo.
3. If states are in DIASPORA list → approve only if the brief explicitly mentions diaspora-reach.
4. If states are OUTSIDE both lists → reject the ad set's geo with reason "Geo×language mismatch: targeting ${brief.targetLanguage ?? 'hinglish'} but geoStates include non-language-matched regions". Suggest replacement geoStates from CORE.
5. For locale targeting: the targeting resolver will auto-populate locales from the brief's targetLanguage. Do NOT need to explicitly set locales on ad sets — they're filled at the resolver step.

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
- "budget" = TOTAL DAILY BUDGET across all ad sets combined (₹/day). DAILY ONLY. This system does not support Meta lifetime_budget — never write a multi-day total.
- Each ad set gets: budget × (budgetPercent / 100) per day
- Proposed anchor: ₹${brief.suggestedBudget > 0 ? brief.suggestedBudget : Math.round((company.weeklyBudgetCap ?? 20000) * 0.25)}/day
- Hard cap: ₹${company.maxBudgetPerCampaign}/day | Weekly cap: ₹${company.weeklyBudgetCap}
- "budget" MUST be ≤ ₹${company.maxBudgetPerCampaign}. Numbers above the cap are silently clamped, which breaks pause/scale guardrail thresholds.
- Max scale: ${company.maxBudgetScalePercent}%
- Pause if ROAS < ${company.pauseIfROASBelow ?? 'not set'} | CTR < ${company.pauseIfCTRBelow ?? 'not set'} | Frequency > ${company.pauseIfFrequencyAbove ?? 'not set'}
- The debate adjusts UP or DOWN from the anchor — does NOT invent from scratch
${brief.winnerCloneOf
  ? `- WINNER-CLONE OVERRIDE: This brief is a clone of a proven winner (source campaign ${brief.winnerCloneOf.sourceCampaignId}, ad ${brief.winnerCloneOf.metaAdId} → ${brief.winnerCloneOf.hookStyle}/${brief.winnerCloneOf.audienceType} produced CPA ₹${Math.round(brief.winnerCloneOf.sourceCPA)} / ROAS ${brief.winnerCloneOf.sourceROAS.toFixed(2)}x at ₹${brief.winnerCloneOf.budgetTier}/day). DO NOT apply the cold-start 50-60% cut. Default daily budget = ₹${brief.winnerCloneOf.budgetTier} (the source winner's tier — already proven). If you cut below this, you MUST cite a specific failure-mode risk that's NEW vs the source winner (e.g. saturation, market shift) — generic conservatism is not enough.`
  : `- No past data → be conservative, start at 50-60% of proposed budget`}

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
