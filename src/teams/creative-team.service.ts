import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { ClaudeService } from '../claude/claude.service';
import { buildSkillBlock, skillsForAgent } from '../common/skills/agent-skill-map';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CopyVariant } from '../creative/schemas/creative-package.schema';
import { runTeamViaCli } from './team-cli.util';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { MetaAdsLibraryOutput, MetaAdsLibraryOutputDocument } from '../pipeline/schemas/meta-ads-library-output.schema';
import { resolveVertical } from '../common/benchmarks/vertical-benchmarks';

export interface CreativeTeamOutput {
  variants: CopyVariant[];
  selectedIndex: number;
  selectionReason: string;
  imagePrompts: string[];     // one per copy variant — matched to each variant's hook/headline
  videoPrompt: string;        // complete prompt: visuals + voiceover + captions + music
  complianceNotes: string;
  debateRounds: number;
  debateLog: { round: number; from: string; summary: string }[];
}

/**
 * Creative Team — Creative Director + Brand Compliance Reviewer.
 *
 * The Creative Director drafts the full creative package (3 copy variants
 * + image prompt + video script). Brand Compliance reviews everything for
 * Meta ad policies, brand tone, and platform specs. They debate until
 * the package is both high-converting AND compliant.
 *
 * Uses `claude -p` CLI for peer-to-peer SendMessage.
 */
@Injectable()
export class CreativeTeamService {
  private readonly logger = new Logger(CreativeTeamService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly metaLearningImporter: MetaLearningImporterService,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
    @InjectModel(MetaAdsLibraryOutput.name)
    private readonly metaAdsLibraryModel: Model<MetaAdsLibraryOutputDocument>,
  ) {}

  async run(
    brief: {
      topic: string;
      angle: string;
      platform: string;
      format: string;
      audience: string;
      hook: string;
      keyMessage: string;
      conversionBridge: string;
      product?: string;
      targetSegment?: string;
      forcedHookStyle?: string;       // when set, ALL variants must use this hookStyle (used by replace_creative)
      avoidHookStyles?: string[];      // hookStyles the generator must not use (saturated / fatigued)
      audienceStage?: 'cold' | 'warm' | 'hot';  // cold = prospecting (problem-first); warm = retarget (offer-recall); hot = cart-recovery (urgency)
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CreativeTeamOutput> {
    const tenantId = company.tenantId;
    const teamMode = company.pipelineConfig?.teamMode ?? 'sequential';
    this.logger.log(`Creative Team starting | tenant: ${tenantId} | run: ${runId} | mode: ${teamMode}`);

    if (teamMode === 'cli') {
      return this.runViaCli(brief, company, runId);
    }
    return this.runSequential(brief, company, runId);
  }

  // ── CLI path ────────────────────────────────────────────────────────────────
  private async runViaCli(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      product?: string; targetSegment?: string;
      forcedHookStyle?: string; avoidHookStyles?: string[];
      audienceStage?: 'cold' | 'warm' | 'hot';
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CreativeTeamOutput> {
    const tenantId = company.tenantId;
    const prompt = await this.buildPrompt(brief, company, runId);
    const cliResult = await runTeamViaCli(prompt, `creative-${runId}`, 'Creative');

    await this.usageLogModel.create({
      tenantId, runId,
      agent: AgentType.CREATIVE_TEAM_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(`Creative Team (CLI) completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns}`);
    return this.parseOutput(cliResult.result);
  }

  // ── Sequential path (2 runAgent() calls) ───────────────────────────────────
  private async runSequential(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      product?: string; targetSegment?: string;
      forcedHookStyle?: string; avoidHookStyles?: string[];
      audienceStage?: 'cold' | 'warm' | 'hot';
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CreativeTeamOutput> {
    const tenantId = company.tenantId;

    // ── Call 1: Creative Director produces full creative package ────────────
    const call1Prompt = await this.buildCall1Prompt(brief, company, runId);

    const call1 = await this.claudeService.runAgent({
      tenantId, runId,
      agentType: AgentType.CREATIVE_TEAM_LEAD,
      // creativeTeamLead covers brand voice, hook quality, copy structure, visual direction
      // Falls back to campaignCreator (has same skills) until prompt generator is re-run
      systemPrompt: company.prompts?.creativeTeamLead ?? company.prompts?.campaignCreator ?? '',
      // liveContext is already embedded in call1Prompt via buildCall1Prompt → buildPrompt
      // passing it here would inject it twice (system prompt + user message)
      liveContext: '',
      userMessage: call1Prompt,
      maxTurns: 5,
      skills: skillsForAgent('CREATIVE_TEAM'),   // ad-creative + copywriting + marketing-psychology + video + image
    });

    this.logger.log(`Creative Team sequential — Call 1 done (${call1.content.length} chars)`);

    // ── Validate Call 1 before passing to Call 2 ────────────────────────────
    // Parse and re-serialise so Call 2 receives clean JSON, not raw LLM text
    let call1Parsed: CreativeTeamOutput;
    try {
      call1Parsed = this.parseOutput(call1.content);
    } catch (parseErr: any) {
      throw new Error(`Creative Team Call 1 returned unparseable output — cannot proceed to compliance review: ${parseErr.message}`);
    }

    // ── Call 2: Brand Compliance Reviewer checks and corrects ───────────────
    const resolvedProduct = (company.products ?? []).find(p => p.name === brief.product)
      ?? (company.products ?? []).find(p => p.active) ?? null;

    const briefFactsBlock = JSON.stringify({
      topic: brief.topic,
      angle: brief.angle,
      hook: brief.hook,
      keyMessage: brief.keyMessage,
      conversionBridge: brief.conversionBridge,
      audience: brief.audience,
      product: resolvedProduct ? { name: resolvedProduct.name, price: resolvedProduct.price, differentiators: resolvedProduct.differentiators } : null,
    }, null, 2);

    const call2UserMessage = `You are the Brand Compliance Reviewer for ${company.name}.

Review the creative package below for:
1. META AD POLICIES — prohibited claims, restricted content, before/after framing, medical/financial promises
2. BRAND TONE — must be "${company.tone}". Flag anything off-brand.
3. PLATFORM SPECS — ${brief.platform} requirements
4. CULTURAL SENSITIVITY — content targets ${company.targetAudience} in ${company.geography}
5. FORBIDDEN TOPICS: ${company.forbiddenTopics?.join(', ') || 'none specified'}
6. PRODUCT ACCURACY — product name must be "${resolvedProduct?.name ?? brief.product ?? 'correct'}", price must be ₹${resolvedProduct?.price ?? 'correct'}
7. FACT-ANCHOR VERIFICATION — every named entity (competitor name, person, news event, statistic, deadline, fabricated quote, specific price other than the product price) in primaryText/headline MUST appear in the BRIEF FACTS block below. If a variant cites something not in BRIEF FACTS — it is fabrication. Rewrite it using only sourced facts or replace with a generic relatable pain.
8. LOGICAL COHERENCE — for each variant, the chain must hold: HEADLINE promises X → primaryText opening 90 chars deliver X (not unrelated story Y) → body's value proposition is what the CTA acts on. If headline and body are about different things, that is a bait-and-switch — rewrite the body to deliver the headline's promise (or rewrite the headline to match the body, whichever stays closer to the brief).

BRIEF FACTS (the ONLY facts that may be cited — anything else is fabrication):
${briefFactsBlock}

CREATIVE PACKAGE TO REVIEW:
${JSON.stringify(call1Parsed, null, 2)}

YOUR JOB:
- For each element (copy variants, imagePrompts, video prompt): APPROVE it, or give a specific fix.
- If a variant violates Meta policies in a way that can't be fixed, replace it with a compliant alternative.
- If a variant cites a fact NOT in BRIEF FACTS, rewrite that line using only brief facts — do not approve fabrications.
- If a variant's hook → body chain breaks (headline says X, body opens with unrelated Y), rewrite the body to deliver the headline's promise. Do not approve incoherent variants.
- If an imagePrompts[i] won't stop the scroll for its matching variant hook, improve it.
- Select the best variant (index 0, 1, 2, or 3) for the "selectedIndex" field — pick the one with the strongest coherent hook→body→CTA chain, not just the loudest hook.

Return ONLY this JSON (no markdown, no explanation):
{
  "variants": [
    {
      "primaryText": "full ad body",
      "headline": "5-7 word headline",
      "cta": "Order Now",
      "hookStyle": "pain_point"
    }
  ],
  "selectedIndex": 0,
  "selectionReason": "why this variant has the strongest hook and clearest value proposition",
  "imagePrompts": [
    "Vertical 9:16 image for variant 0 — visual centerpiece matched to its hook...",
    "Vertical 9:16 image for variant 1 — visual centerpiece matched to its hook...",
    "Vertical 9:16 image for variant 2 — visual centerpiece matched to its hook...",
    "Vertical 9:16 image for variant 3 — visual centerpiece matched to its hook..."
  ],
  "videoPrompt": "Pick duration + opener + music based on the SELECTED variant's hookStyle. Example below for hookStyle='pain_point' (30-40s, story-arc):\\n\\nDuration: 35 seconds, 9:16 vertical for Reels/Stories. Cinematic b-roll only — no avatars, no talking-head. Off-screen Hindi voiceover, Indian instrumental music.\\n\\nFIRST FRAME (controls thumbnail): Close-up of stressed hands gripping a phone, late-night room lighting, blurred kundli paper visible on the table beside the phone. Bold Hindi/Hinglish text overlay = the hook line.\\n\\n0-3s: Hold on the first frame, hook text fully visible. Single tanpura drone, no other sound. Establishes pain instantly.\\n\\n3-15s: PERSONAL STORY beat. Hard cut to a different relatable scene — woman staring out a rainy window, pages of a kundli rifling on a table, a circled date on a wall calendar. Hindi voiceover begins in conversational tone (warm, knowing — never preachy): names the specific astrology pain (Sade Sati / Mangal dosh / Mercury Retrograde — match to the brief's topic). Slow sitar/bansuri solo joins, minor key.\\n\\n15-25s: SHIFT to a brighter beat. Visual transitions to a lit puja desk with the relevant deity iconography (Shani for Sade Sati, Lakshmi for wealth, Hanuman for protection — match to topic), open kundli with planetary lines highlighted, hands tracing transit positions. Voiceover delivers the resolution / what becomes possible. Tabla layers in.\\n\\n25-35s: CTA beat. Bold text overlay: \\\"${resolvedProduct?.name ?? 'Product'} — ₹${resolvedProduct?.price}\\\" with a specific CTA line below (\\\"Aaj hi consultation book karo\\\" / \\\"Pehli baat ₹1 mein\\\"). Final voiceover urgency line. Music hits one final tabla beat → clean stop. Black frame for 0.5s.\\n\\nNEGATIVE: no English-only text, no watermarks, no celebrity faces, no Western spiritual aesthetic (crystals/mandalas/Buddha statues), no fade transitions, no slow zooms.",
  "complianceNotes": "what was reviewed and any changes made",
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "creative-director", "summary": "drafted 4 variants + 4 image prompts + video"},
    {"round": 2, "from": "compliance", "summary": "approved with minor fixes"}
  ]
}`;

    const call2 = await this.claudeService.runAgent({
      tenantId, runId,
      agentType: AgentType.CREATIVE_TEAM_LEAD,
      systemPrompt: `You are a Brand Compliance Reviewer specializing in Meta Ads for Indian brands. You ensure ads are policy-compliant, on-brand, and high-converting. Be specific about fixes — don't just flag, correct.`,
      liveContext: '',
      userMessage: call2UserMessage,
      maxTurns: 3,
      skills: skillsForAgent('CREATIVE_TEAM'),
    });

    this.logger.log(`Creative Team sequential — Call 2 done | tenant: ${tenantId} | run: ${runId}`);
    return this.parseOutput(call2.content);
  }

  private async buildCall1Prompt(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      product?: string; targetSegment?: string;
      forcedHookStyle?: string; avoidHookStyles?: string[];
      audienceStage?: 'cold' | 'warm' | 'hot';
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<string> {
    // Same as buildPrompt but STEPS section replaced with simple JSON output instruction
    const fullPrompt = await this.buildPrompt(brief, company, runId);

    // Strip everything from STEPS onwards and replace with a direct output instruction
    const stepsIdx = fullPrompt.indexOf('═══════════════════════════════════════════════════════\nSTEPS');
    const withoutSteps = stepsIdx !== -1 ? fullPrompt.slice(0, stepsIdx).trimEnd() : fullPrompt;

    // Resolve product so the JSON example shown to the LLM has concrete name + price
    // (so the example reads as real, not as a template).
    const resolvedProduct = (company.products ?? []).find(p => p.name === brief.product)
      ?? (company.products ?? []).find(p => p.active) ?? null;

    return `${withoutSteps}

═══════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════

This is Phase 1 of a 2-phase review. A Brand Compliance Reviewer will review your output separately.
Do NOT approve your own work. Do NOT add compliance notes. Just produce the best creative package you can.

Return ONLY this JSON (no markdown, no explanation):
{
  "variants": [
    {
      "primaryText": "Hook line.\\n\\nValue + product line.\\n\\n₹price | proof.\\n\\nUrgency + CTA.",
      "headline": "Benefit-led headline",
      "cta": "Order Now",
      "hookStyle": "pain_point"
    }
  ],
  "selectedIndex": 0,
  "selectionReason": "why this is the strongest variant",
  "imagePrompts": [
    "Vertical 9:16 image for variant 0 — visual centerpiece matched to its specific hook...",
    "Vertical 9:16 image for variant 1 — visual centerpiece matched to its specific hook...",
    "Vertical 9:16 image for variant 2 — visual centerpiece matched to its specific hook...",
    "Vertical 9:16 image for variant 3 — visual centerpiece matched to its specific hook..."
  ],
  "videoPrompt": "Pick duration + opener + music based on the SELECTED variant's hookStyle. Example below for hookStyle='pain_point' (30-40s, story-arc):\\n\\nDuration: 35 seconds, 9:16 vertical for Reels/Stories. Cinematic b-roll only — no avatars, no talking-head. Off-screen Hindi voiceover, Indian instrumental music.\\n\\nFIRST FRAME (controls thumbnail): Close-up of stressed hands gripping a phone, late-night room lighting, blurred kundli paper visible on the table beside the phone. Bold Hindi/Hinglish text overlay = the hook line.\\n\\n0-3s: Hold on the first frame, hook text fully visible. Single tanpura drone, no other sound. Establishes pain instantly.\\n\\n3-15s: PERSONAL STORY beat. Hard cut to a different relatable scene — woman staring out a rainy window, pages of a kundli rifling on a table, a circled date on a wall calendar. Hindi voiceover begins in conversational tone (warm, knowing — never preachy): names the specific astrology pain (Sade Sati / Mangal dosh / Mercury Retrograde — match to the brief's topic). Slow sitar/bansuri solo joins, minor key.\\n\\n15-25s: SHIFT to a brighter beat. Visual transitions to a lit puja desk with the relevant deity iconography (Shani for Sade Sati, Lakshmi for wealth, Hanuman for protection — match to topic), open kundli with planetary lines highlighted, hands tracing transit positions. Voiceover delivers the resolution / what becomes possible. Tabla layers in.\\n\\n25-35s: CTA beat. Bold text overlay: \\\"${resolvedProduct?.name ?? 'Product'} — ₹${resolvedProduct?.price}\\\" with a specific CTA line below (\\\"Aaj hi consultation book karo\\\" / \\\"Pehli baat ₹1 mein\\\"). Final voiceover urgency line. Music hits one final tabla beat → clean stop. Black frame for 0.5s.\\n\\nNEGATIVE: no English-only text, no watermarks, no celebrity faces, no Western spiritual aesthetic (crystals/mandalas/Buddha statues), no fade transitions, no slow zooms.",
  "complianceNotes": "",
  "debateRounds": 1,
  "debateLog": [{"round": 1, "from": "creative-director", "summary": "drafted creative package"}]
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
      product?: string;
      targetSegment?: string;
      forcedHookStyle?: string;       // when set, ALL variants must use this hookStyle (used by replace_creative)
      avoidHookStyles?: string[];      // hookStyles the generator must not use (saturated / fatigued)
      audienceStage?: 'cold' | 'warm' | 'hot';  // cold = prospecting (problem-first); warm = retarget (offer-recall); hot = cart-recovery (urgency)
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<string> {
    const liveContext = this.liveContextBuilder.build(company);
    const competitorHooks = await this.fetchCompetitorHooks(company.tenantId);

    // Resolve product
    const resolvedProduct = (company.products ?? []).find(p => p.name === brief.product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0]
      ?? null;

    // Guard: price must be set before building video/copy prompts
    if (brief.format !== 'meme' && resolvedProduct && !resolvedProduct.price) {
      throw new Error(`Product "${resolvedProduct.name}" has no price set for tenant ${company.tenantId} — cannot build creative prompt`);
    }

    // Case studies (recent only)
    let caseStudyContext = '';
    try {
      const caseStudies = await this.metaLearningImporter.getRelevantCaseStudies(
        company.tenantId,
        { product: resolvedProduct?.name, limit: 7 },
      );
      if (caseStudies.length > 0) {
        caseStudyContext = `
PAST CREATIVE CASE STUDIES (what hooks/formats worked and failed):
${caseStudies.slice(0, 7).map((cs, i) => `  ${i + 1}. ${cs.campaignName}: ${cs.whatWorked?.hooks?.join(', ') || 'unknown'} hooks worked (CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}). ${cs.whatFailed?.reason || ''} Lesson: ${cs.lesson}`).join('\n')}`;
      } else {
        caseStudyContext = 'PAST CREATIVE CASE STUDIES: No past case studies available yet.';
      }
    } catch (err: any) {
      this.logger.warn(`Case studies unavailable for ${company.tenantId}: ${err.message}`);
      caseStudyContext = 'PAST CREATIVE CASE STUDIES: Unavailable this run.';
    }

    // Product info block (shared between Creative Director and Compliance Reviewer)
    const productBlock = (() => {
      const product = resolvedProduct;
      if (!product) return 'PRODUCT: not specified — use company info for CTA';
      return `PRODUCT BEING SOLD:
  Name: ${product.name}
  Price: ₹${product.price}
  Landing URL: ${product.landingUrl ?? 'not set'}
  Languages: ${(product.languages ?? []).join(', ') || 'Hindi, English'}
  Differentiators: ${(product.differentiators ?? []).join(' | ') || 'not set'}
  Target segment: ${brief.targetSegment ?? 'general'}`;
    })();

    // Visual learnings for image/video prompts. Exploration-arm briefs skip
    // these entirely — closed-loop drift mitigation. The Strategy Team flagged
    // this brief as a "use a hookStyle outside winningHooks" probe; injecting
    // the very list it should ignore would defeat the experiment.
    const creative = company.learnings?.creative;
    const isExploration = !!(brief as any).explorationArm;
    const visualLearnings = (() => {
      if (isExploration) return 'EXPLORATION-ARM BRIEF: ignore prior winning/losing hook patterns — generate fresh creative direction from the brief alone.';
      const lines: string[] = [];
      if (creative?.visualInsights?.length) lines.push(`Visual patterns that work: ${creative.visualInsights.join('; ')}`);
      if (creative?.winningHooks?.length) lines.push(`Winning hook styles (use in text overlays): ${creative.winningHooks.join(', ')}`);
      if (creative?.losingHooks?.length) lines.push(`Losing hook styles (avoid in visuals): ${creative.losingHooks.join(', ')}`);
      if (creative?.ctaInsights?.length) lines.push(`CTA insights: ${creative.ctaInsights.join('; ')}`);
      return lines.length > 0 ? lines.join('\n') : 'No visual learnings yet.';
    })();

    // Verbatim winning exemplars — anchor on lines that ACTUALLY converted.
    // The hookStyle labels above tell you the category that's working; the exemplars
    // tell you the phrasing patterns. Use them as inspiration for tone/structure/specificity,
    // NOT for direct copying — re-running an old line on a saturated audience underperforms.
    const winningExemplarsBlock = (() => {
      // Exploration-arm briefs skip exemplar injection — see visualLearnings
      // above. Exemplars are the strongest exploitation signal; suppressing
      // them is the whole point of the exploration arm.
      if (isExploration) return '';
      const exemplars = creative?.winningExemplars ?? [];
      if (exemplars.length === 0) return '';

      // Filter by audienceStage when set on the brief — cold winners shouldn't anchor
      // warm briefs and vice versa. Audience attribution comes from A3 work in
      // creative-learning.service.ts:enrichWithCTR (dominant ad set's audienceType).
      // Map exemplar.audienceSegment → stage with the same logic the auditor uses.
      const stageOfSegment = (segment: string | undefined): 'cold' | 'warm' | 'hot' => {
        if (segment === 'retarget' || segment === 'custom' || segment === 'lookalike') return 'warm';
        return 'cold';
      };
      const briefStage = brief.audienceStage ?? 'cold';
      let pool = exemplars;
      if (brief.audienceStage) {
        const matching = exemplars.filter((e: any) => stageOfSegment(e.audienceSegment) === briefStage);
        // If filtered set is too small (<3), fall back to full pool — better to have
        // some inspiration than none. Logged via the rendering itself (mixed-stage banner).
        pool = matching.length >= 3 ? matching : exemplars;
      }

      const top5 = [...pool].sort((a, b) => b.ctr - a.ctr).slice(0, 5);
      const allFromBriefStage = brief.audienceStage
        ? top5.every((e: any) => stageOfSegment(e.audienceSegment) === briefStage)
        : true;

      const formatted = top5
        .map((e: any, i: number) =>
          `  ${i + 1}. [${e.hookStyle}, CTR ${e.ctr.toFixed(2)}%${e.audienceSegment ? `, ${e.audienceSegment}` : ''}] "${e.hookLine}"`,
        )
        .join('\n');
      const stageBanner = brief.audienceStage && !allFromBriefStage
        ? ` (mixed stages — pool was thin for ${brief.audienceStage})`
        : '';
      return `\nPAST WINNING HOOK LINES${stageBanner} (verbatim — use as inspiration for structure/tone/specificity, NOT to copy):\n${formatted}\n`;
    })();

    // Strategy mode
    const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
    const strategyMode = strategy === 'conservative'
      ? `CONSERVATIVE MODE: Use proven hook styles from past learnings only. Stick to visual formats that have worked before. Minimize creative risk.`
      : strategy === 'experimental'
        ? `EXPERIMENTAL MODE: Try bold, untested hook styles. Push creative boundaries. At least 2 variants should be genuinely risky/different from anything tried before.`
        : `BALANCED MODE: 3 variants should use proven hook styles from learnings. 1 variant should test a new hook style or creative angle.`;

    // ═════════════════════════════════════════════════════════════════════════
    // PROMPT: Data first → Creative specs → Rules → Steps
    // ═════════════════════════════════════════════════════════════════════════
    return `
${buildSkillBlock('CREATIVE_TEAM')}
You ARE the Creative Director for ${company.name}. You will create the full ad creative package and debate it with a Brand Compliance Reviewer.

═══════════════════════════════════════════════════════
BRIEF
═══════════════════════════════════════════════════════

Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key Message: ${brief.keyMessage}
Conversion Bridge: ${brief.conversionBridge}

${productBlock}

Brand Guidelines: ${company.brandGuidelines || 'Not specified'}
Tone: ${company.tone}
Avoid: ${company.avoid?.join(', ') || 'nothing specified'}

${this.buildVerticalContextBlock(company.industry, brief.audienceStage, brief.avoidHookStyles)}

${liveContext}

${caseStudyContext}

COMPETITOR WINNING HOOKS (from Meta Ads Library — use as inspiration to differentiate, not to copy):
${competitorHooks}
Study what angles competitors are already running. If they own "pain_point", try "bold_claim" or "before_after" instead.

CAMPAIGN STRATEGY: ${strategyMode}

AUDIENCE STAGE: ${brief.audienceStage ?? 'cold'} — copy MUST match this stage:
${(brief.audienceStage ?? 'cold') === 'cold'
  ? '• COLD (prospecting): Audience has NOT seen this brand before. Problem-first structure: agitate pain, introduce brand AS the solution, end with offer + CTA. Full 3-5 line primaryText. Brand introduction is required. Hook must stop the scroll cold.'
  : (brief.audienceStage === 'warm')
  ? '• WARM (retargeting site visitors): Audience already knows the brand from a recent visit. SKIP brand intro. Lead with offer-recall ("Aapki ₹1 reading wait kar rahi hai"), objection-handling ("Pehli baat free — kuch lagega bhi nahi"), or specific reason-to-return. 2-3 line primaryText is enough. NEVER use cold-prospect hooks like "Kya aap bhi…" — they sound weird to someone who already engaged.'
  : '• HOT (cart abandoners / 30d engaged): Audience has shown high purchase intent recently. Cart-recovery urgency. Reference the specific abandoned action ("Aapki kundli reading 2 din se wait kar rahi hai"). Time-bound urgency ("Aaj raat tak ₹1 mein"). 1-2 line primaryText, ruthlessly short. Hook = the offer + a deadline.'}

═══════════════════════════════════════════════════════
FACT-ANCHOR RULE (NON-NEGOTIABLE — VIOLATION = REJECT)
═══════════════════════════════════════════════════════

Every named entity, number, date, statistic, news event, person, or quoted claim
in your copy MUST come from one of these five sources — and ONLY these five:

  1. THE BRIEF above (topic, angle, hook, keyMessage, conversionBridge, audience)
  2. THE PRODUCT block (name, price, differentiators, languages)
  3. PAST CASE STUDIES section (verbatim case-study facts only)
  4. PAST WINNING HOOK LINES section (verbatim winners only)
  5. Generic, audience-universal pain points (no specific names/numbers/events)

You MAY NOT invent any of the following — they fail compliance and waste budget:
  ✗ Specific competitor incidents not in the brief ("a viral expose", "UPSC-aspirant astrologer")
  ✗ Fabricated prices or discounts ("₹15,000 puja", "70% off") not in the product block
  ✗ Made-up dates, deadlines, festivals, or astrological events not in the brief
  ✗ Invented testimonial quotes or named customers
  ✗ Statistics or social-proof numbers not from the case studies

If a variant needs a specific to feel real and the brief doesn't supply one,
use a generic relatable pain instead — never fabricate. Vague-but-true beats
specific-but-invented every single time.

═══════════════════════════════════════════════════════
CREATIVE SPECS
═══════════════════════════════════════════════════════

${brief.format === 'meme'
  ? `This is a MEME-FORMAT paid Meta ad riding a viral cultural moment. The viewer must instantly recognize the meme/trend and laugh or relate — THEN notice the brand tie-in.
Your creative must: (1) nail the meme format exactly so it feels native, (2) tie in the product naturally — forced product insertion kills meme ads, (3) push to ONE action — tap the CTA button.`
  : `This is a PAID Meta direct response ad. The user is scrolling and has NOT asked to see this.
Your creative must: (1) stop the scroll in the FIRST LINE / FIRST 3 SECONDS, (2) make the value proposition crystal clear (product + benefit + price), (3) push to ONE action — tap the CTA button.`}

━━━ a) AD COPY VARIANTS ━━━

${brief.format === 'meme' ? `Each variant needs:
- primaryText: 1-2 lines MAX. Meme copy is short. Structure:
  LINE 1 — THE MEME: The recognizable format/reference (e.g. "Nobody: / Me at 3am:"). Make it instantly relatable.
  LINE 2 — THE TIE-IN: The product as the natural punchline or solution. Feels organic, not forced. MUST mention product name.
- headline: 5-7 words. Can be the punchline or CTA.
- cta: "Shop Now", "Order Now", "Buy Today"
- hookStyle: one of "meme_relatable", "meme_punchline", "meme_self_aware" (each variant must use a DIFFERENT one)

MEME COPY RULES:
- Short is everything — if it needs explaining, it's not a meme
- The product is the natural punchline, not a forced insertion
- Hinglish where natural for ${company.targetAudience}
- Product name in EVERY variant` : `Each variant needs:
- primaryText: full ad body (3-5 lines). Structure:
  LINE 1 — THE HOOK: Scroll-stopper. First 90 chars shown before "See more".
  LINE 2-3 — THE VALUE: Agitate pain OR amplify desire. Introduce product as solution. MUST mention product name.
  LINE 4 — PRICE + PROOF: State price (₹${resolvedProduct?.price ?? '[price]'}). Add social proof if available.
  LINE 5 — CTA LINE: Create urgency. Push action TODAY.
- headline: 5-7 words below the image/video. Lead with benefit or price.
- cta: button text — "Shop Now", "Order Now", "Buy Today" (NOT "Learn More" unless considered purchase)
- hookStyle: ${brief.forcedHookStyle
    ? `MUST be exactly "${brief.forcedHookStyle}" for ALL 4 variants (this is a forced replacement — variants differ on emotional position, voicing, and example, NOT on hookStyle).`
    : 'one of the options below (each variant must use a DIFFERENT one)'}

HOOK STYLES${brief.forcedHookStyle ? ` (locked to "${brief.forcedHookStyle}" — see rule above):` : ' (use one per variant — pick 4 different styles, one per variant):'}
  "pain_point" — open with the audience's frustration
  "bold_claim" — specific, provable promise
  "price_shock" — lead with value proposition + price
  "social_proof" — open with result or testimonial
  "curiosity_gap" — make them need to know more
  "before_after" — transformation (frame as aspiration, not guarantee)
  "urgency" — time or stock scarcity${brief.avoidHookStyles && brief.avoidHookStyles.length > 0
    ? `\n\n⚠ AVOID THESE HOOK STYLES (saturated on the target audience or recently failed):\n  ${brief.avoidHookStyles.map(h => `"${h}"`).join(', ')}\nDo not generate variants with these hookStyles. The audience has been over-exposed.`
    : ''}

COPY RULES:
- Hinglish where natural for ${company.targetAudience}
- Specific beats vague — BUT every specific must trace to the FACT-ANCHOR sources above. If you cannot cite the source, use a generic relatable pain instead.
- Product name in EVERY variant's primaryText
- Price (₹${resolvedProduct?.price ?? '[price]'}) in EVERY variant — no exceptions
- No generic phrases: "best quality", "amazing product", "don't miss out"
- Hook → body → offer → CTA must form a logical chain. The headline's promise must be what the body delivers, and the body's value must be what the CTA acts on. No bait-and-switch (headline says X, body opens with unrelated story Y).
${resolvedProduct ? `- Every variant MUST mention "${resolvedProduct.name}" and ₹${resolvedProduct.price}` : ''}`}

━━━ b) IMAGE PROMPTS — one per copy variant, for Nano Banana (Gemini Image) ━━━

Write one image prompt per copy variant (4 total). Each image must be visually tailored to its variant's specific hook and headline, not a generic image that could work for any variant.

Each image must make someone STOP scrolling and TAP the ad. It's not a brand photo — it's a direct response sales image.

STEP 1 — IDENTIFY THE VISUAL CENTERPIECE per variant:
Before writing each prompt, read that variant's hook and headline. Ask: "What is the ONE visual concept that makes THIS variant's hook different from the other two?"
Each variant has a different hookStyle — the visual centerpiece must match it.

Examples of visual centerpieces:
- If the hook mentions a DATE/EVENT (festival, deadline, exam) → the centerpiece is that date (calendar, countdown, highlighted date)
- If the hook mentions a COMPARISON (competitor vs us, before/after) → the centerpiece is a split visual
- If the hook mentions a FEAR/PROBLEM → the centerpiece is that fear visualized dramatically
- If the hook mentions SOCIAL PROOF (10,000+ users) → the centerpiece is the number, large and bold
- If the hook mentions a SEASONAL MOMENT → the centerpiece is that season's visual symbol, prominently placed

The visual centerpiece must be the LARGEST, most prominent element in the image — not a small detail in the corner. If the ad is about Akshaya Tritiya on April 19, the calendar with April 19 circled should DOMINATE the image, not be a tiny element. If the ad is about career anxiety, a stressed face should fill the frame.

STEP 2 — BUILD THE IMAGE AROUND THE CENTERPIECE:

IMAGE STRUCTURE (describe ALL of these):
- VISUAL CENTERPIECE (60% of the frame): The one concept from Step 1. Make it LARGE, BOLD, unmissable. This is what the viewer sees first.
- TEXT OVERLAY — TOP: The hook line in bold, high-contrast Hinglish text. Exact words from the copy. Must be READABLE at phone size.
- TEXT OVERLAY — BOTTOM: Product name + "₹${resolvedProduct?.price ?? '[price]'}" + CTA. High contrast.
- PRODUCT PLACEMENT: Where the product appears — can be integrated with the centerpiece or alongside it.
- SUPPORTING ELEMENTS: Background, people, colors that reinforce the centerpiece's emotion — but don't compete with it.

WHAT MAKES PEOPLE CLICK:
1. The VISUAL CENTERPIECE creates instant recognition — "yeh toh mere baare me hai"
2. TEXT OVERLAYS sell the message — hook + price, bold and readable
3. PRODUCT is visible — the viewer knows what they're buying
4. URGENCY or CURIOSITY in the composition — the viewer must feel "I need to tap NOW"
5. INDIAN CONTEXT — real Indian faces, settings, cultural cues

FORMAT: Vertical 9:16, photorealistic, 5-6 sentences.

PAST VISUAL LEARNINGS:
${visualLearnings}
${winningExemplarsBlock}
AVOID:
- Generic images where the main concept is small/hidden — if the ad is about a specific date, that date must DOMINATE
- Lifestyle photos with no clear focal point
- Muted/pastel colors — they disappear in the feed
- Cluttered composition — one centerpiece, one message
- Stock photo aesthetic — real, raw, Indian performs better
- Images that look "nice" but don't sell — every element must push toward the tap

━━━ c) VIDEO CREATIVE — Heygen Video Agent prompt ━━━

Write a CINEMATIC SCRIPT prompt for Heygen's AI Video Generator (V3 Video Agent API). This prompt is sent DIRECTLY to Heygen — write it as a natural-language film script that Heygen's AI can interpret and render. Cinematic b-roll visuals + on-screen text + off-screen voiceover (no avatars, no talking-head — voice is heard, no person shown speaking).

FORMAT: Single flowing script. Describe visuals, text overlays, voiceover narration, and music as continuous cinematic direction. Do NOT use numbered scenes or brackets — write it like you're directing a short film.

═══ STEP 1: PICK DURATION + STRUCTURE FROM SELECTED VARIANT'S hookStyle ═══

The video is for the SELECTED copyVariant only. Pick duration and structure based on its hookStyle. This is mandatory — do not default to a generic 15s template:

| hookStyle        | Duration | Why                                                                |
|------------------|----------|--------------------------------------------------------------------|
| pain_point       | 30-40s   | needs personal-story room (3-15s pain → 15-25s relief → 25-40s CTA)|
| before_after     | 30-40s   | transformation arc requires room                                    |
| social_proof     | 20-30s   | testimonial-style narrative beat                                    |
| curiosity_gap    | 20-25s   | open-loop tension + reveal                                          |
| price_shock      | 12-15s   | punchy, single beat                                                 |
| urgency          | 12-15s   | tight, scarcity-driven                                              |
| bold_claim       | 15-20s   | claim → proof → CTA, no story arc                                   |

═══ STEP 2: PICK OPENER PATTERN BASED ON hookStyle ═══

The first 0-3s decides thumb-stop ratio. The first frame becomes the Reel/Story thumbnail — make it count. NEVER default to a "dark text card" — that's predictable when every video does it.

| hookStyle      | Opener (first frame must visualize this)                                                          |
|----------------|---------------------------------------------------------------------------------------------------|
| pain_point     | Specific relatable struggle — close-up of stressed hands gripping a phone, anxious face turning away from a kundli, late-night insomnia stare. Hindi/Hinglish text overlay = the hook line. |
| before_after   | Split or transition visual — "before" on left/top (struggle) vs "after" on right/bottom (calm). Hook text bridges both. |
| social_proof   | Number / testimonial visual — "10,000+ logon ne X kiya" with crowd b-roll, OR a real-feeling testimonial frame (no avatar — abstracted close-ups). |
| curiosity_gap  | Object-question — single mysterious object centered (open kundli, planetary chart, glowing diya), text overlay = the unanswered question. |
| price_shock    | The price as the first frame — large ₹{price} number on warm gradient, instantly recognizable as cheap. Optional small visual element above. |
| urgency        | Countdown/clock/calendar visual — circled date, ticking clock close-up, "[N] din baaki" text. Ticking percussive sound. |
| bold_claim     | The claim itself as the first frame — large bold Hindi/Hinglish text on a context-relevant b-roll background. |

═══ STEP 3: PICK MUSIC STYLE BASED ON hookStyle ═══

| hookStyle      | Music                                                                                          |
|----------------|------------------------------------------------------------------------------------------------|
| pain_point     | Slow melodic sitar/bansuri solo, minor key. Builds at relief beat. No tabla until 60% mark.   |
| before_after   | Slow open → tempo lift at the "after" reveal. Bansuri for hope.                                |
| social_proof   | Warm tabla + sitar from start, conversational pace. Major key. No mystery sustains.            |
| curiosity_gap  | Mystery sustains (single tanpura drone, soft bell), unresolved until the reveal beat.          |
| price_shock    | Upbeat tabla rhythm from frame 1. No slow build — punch immediately.                           |
| urgency        | Sharp percussion — tabla + ghatam. Tight, time-running-out feel. Final beat is a hard stop.    |
| bold_claim     | Confident, declarative — full ensemble (tabla + sitar + tanpura) from start.                   |

═══ STEP 4: WRITE THE SCRIPT ═══

Match the duration / opener / music to the SELECTED variant's hookStyle. Three beats:

(A) HOOK — 0 to ~20% of duration. Use the opener pattern. Hook text overlay = the hook line. First frame must visualize the hook concept (controls thumbnail).
(B) BODY — middle 50-60% of duration. For story-driven hooks, this is the personal-story / transformation / proof beat. For punch hooks, this is the value proposition + product reveal. Voiceover speaks in conversational Hindi (or the brief's audience language) — NEVER textbook Hindi. Specific b-roll, hard cuts, no fades.
(C) CTA — final ~20% of duration. Product name "${resolvedProduct?.name ?? 'Product'}" + ₹${resolvedProduct?.price} as bold text overlay. Voiceover delivers the urgency line ("Abhi karo" / "Aaj hi" / "Pehla kadam lo"). Final music beat → clean stop.

═══ VOICEOVER SCRIPT — VERBATIM, NOT DESCRIBED ═══

CRITICAL: Heygen's renderer auto-translates prose descriptions of voiceover into Google-translate Hindi, which produces awkward grammar (e.g. "aapka kundli analyze karenge" instead of natural "aapki kundli padhte hain"). To prevent this, your videoPrompt MUST include the EXACT voiceover script verbatim in the language the audience speaks (Devanagari for Hindi, or natural Hinglish in Latin script if the brief specifies Hinglish), with these markers:

  • Inline the script directly in the relevant timing beat (e.g. "0-3s: <visual>. VO: \\"<exact Hindi script here>\\"")
  • Use \\"...\\" inside the VO line for natural pauses
  • Use *word* for emphasis the renderer should respect
  • Length: ~2.5 spoken syllables per second of duration (~5-7 short Hindi words per 3-second beat)
  • Use conversational Hindi (Indore/Lucknow register) — NEVER textbook Hindi, NEVER pure-Sanskrit terms when a colloquial word exists
  • Pull the VO script from the SELECTED copy variant's headline + primaryText — do NOT rewrite it. The video is voicing the chosen ad copy.
  • Do NOT describe the VO ("warm conversational tone") in place of providing the script. Tone is implied by the words; the renderer needs the WORDS.

Example beat written correctly (pain_point):
  3-15s: Hard cut to woman staring out a rainy window. Slow sitar joins. VO: "Kal raat phir wahi sapna... wahi sawaal — ki aage kya hoga. Kundli kholo, ya phir doosre se poochho? Dono mein ek hi farak hai — ek mein answer hai, doosre mein guess."

Example beat written WRONG (DO NOT do this):
  3-15s: Voiceover speaks in conversational Hindi about the audience's pain in a warm, knowing tone.

${resolveVertical(company.industry) === 'spirituality' ? `═══ ASTROLOGY-SPECIFIC B-ROLL VOCABULARY (use when topic fits) ═══

Astro hooks demand astro visuals. Generic "spiritual aesthetic" loses to specific iconography:
- Sade Sati / Saturn-related → Shani iconography: blue-black, oil lamp, crow imagery, Saturn glyph
- Wealth / Lakshmi-related → gold coins, lotus, owl, red-and-gold palette, Lakshmi yantra
- Protection / Hanuman-related → saffron, mace, monkey iconography, Sundarkand text
- Knowledge / Saraswati-related → white, swan, veena, books, lotus
- Chart specifics → close-up of a kundli paper, planetary diagram, transit lines, nakshatra wheel
- Devotional props (general) → diya flame, rudraksha mala, tilak, sacred thread, agarbatti smoke
- Astrologer archetype (NO talking-head — show hands/objects only) → hands holding a kundli, a finger tracing planetary positions, a candle-lit puja desk with an open chart

DO NOT default to generic "moody puja room with diya" for every video. Match iconography to the topic — Shani for Sade Sati, Lakshmi for wealth, Hanuman for protection, etc.

` : ''}═══ VISUAL RULES (non-negotiable) ═══

- 9:16 vertical format for Reels/Stories
- All text overlays: bold sans-serif, large for mobile, white/gold/saffron on dark or warm grounds
- All text in Hindi or Hinglish — zero English-only lines
- Hard cuts only between scenes — no fade transitions
- Hyper-specific visuals — match the brief's topic with concrete, named props/lighting
- Product name "${resolvedProduct?.name ?? 'Product'}" and price ₹${resolvedProduct?.price} must appear as exact text — never placeholders
- NO talking-head, NO avatar, NO face-to-camera — cinematic b-roll only with off-screen voiceover (in the audience's language — Hindi/Hinglish for India)
- NO stock footage look, NO watermarks, NO celebrity faces${resolveVertical(company.industry) === 'spirituality' ? `
- NO Western "spiritual wellness" aesthetic (crystals, mandalas, Buddha statues, sage smudging) — Indian-astro only` : ''}

═══════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════

- These are META DIRECT RESPONSE ADS — optimise for tap-through rate, not likes or comments
- ${brief.forcedHookStyle
    ? `All 4 variants MUST use hookStyle "${brief.forcedHookStyle}" — differentiate by emotional position, voicing, and example, NOT by hookStyle (this is a forced replacement; the AD COPY VARIANTS section already states this — restating here so the rule is unambiguous)`
    : `All 4 copy variants must use a DIFFERENT hookStyle — 4 completely different opening strategies`}
- Image and video prompts must visually reinforce the brief's hook and key message
- Do NOT pick the winning variant before compliance review — the review may change the best choice
- If a variant gets flagged and cannot be fixed without gutting the message, replace it entirely

═══════════════════════════════════════════════════════
STEPS
═══════════════════════════════════════════════════════

STEP 1: Call TeamCreate with team_name "creative-${runId}"

STEP 2: Spawn the Brand Compliance Reviewer via Agent tool:
  - name: "compliance"
  - team_name: "creative-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Brand Compliance Reviewer for ${company.name}. Your job is to review ad creatives for:
    1. META AD POLICIES — prohibited claims, restricted content, before/after framing, medical/financial promises
    2. BRAND TONE — must be ${company.tone}. Flag anything off-brand.
    3. PLATFORM SPECS — ${brief.platform} requirements (aspect ratio, text limits, hook timing)
    4. CULTURAL SENSITIVITY — content targets ${company.targetAudience} in ${company.geography}
    5. FORBIDDEN TOPICS: ${company.forbiddenTopics?.join(', ') || 'none specified'}
    6. PRODUCT ACCURACY — the ad MUST correctly reference the product:
       ${productBlock}
       Verify: product name is correct, price is accurate, claims match the product's actual features.

    FIRST ACTION (do this immediately before anything else):
    Call TaskCreate(name: 'waiting-for-creative', body: 'waiting for Creative Director to send the creative package'). Stay alive and keep waiting until their message arrives. Do NOT produce any output until you receive their message.

    REVIEW PROTOCOL:
    - You will receive the full creative package (copy + image prompt + video prompt) via SendMessage.
    - For each element: APPROVE it, or FLAG it with the specific issue and a suggested fix.
    - Be strict on Meta policies (a rejected ad wastes the entire pipeline).
    - Be constructive on creative feedback — don't just say 'bad', say 'change X to Y because Z'.
    - When the Creative Director revises, review the changes and either approve or flag again.
    - After each response, call TaskCreate to wait for the next message.
    - When everything passes, send a final message: {type: 'approved', notes: 'summary of what was fixed'} via SendMessage(to: 'team-lead').
    - When you receive a shutdown_request: reply with {type: 'shutdown_confirmed'} via SendMessage(to: 'team-lead') then stop."

STEP 3: Create the full creative package (4 copy variants + 4 image prompts + video prompt) using the brief and specs above.

Send the full package to the Compliance Reviewer via SendMessage(to: "compliance"). Label as "ROUND 1".
CRITICAL: After SendMessage, do NOT output any text. Immediately call TaskCreate with name "round-1-pending" and body "waiting for compliance response". Do not produce any output until you receive their message.

STEP 4: When you receive the reviewer's response:
  - If flagged: revise the package, then SendMessage(to: "compliance") as "ROUND 2", then call TaskCreate(name: "round-2-pending") — do NOT output text between rounds.
  - If approved ({type: "approved"}): proceed to STEP 5.
  - Max 5 rounds. Keep calling TaskCreate after each SendMessage to stay alive.
  PATIENCE: The reviewer runs in the background and takes several minutes to respond. Do NOT give up or produce output on your own. Keep waiting via TaskCreate until their message arrives. Only nudge once (via SendMessage) if you have called TaskCreate 4+ times with no reply.

STEP 5: Once the reviewer approves:
  1. SendMessage(to: "compliance", message: {type: "shutdown_request"})
  2. Call TaskCreate(name: "shutdown-pending", body: "waiting for shutdown confirmation") — do NOT call TeamDelete yet.
  3. Wait for the shutdown confirmation to arrive as an incoming message.
  4. Only after receiving confirmation: call TeamDelete.
  If TeamDelete fails after receiving confirmation, SKIP IT — cleanup is automatic. Proceed to output.

STEP 6: Return ONLY this JSON (no markdown, no explanation):
{
  "variants": [
    {
      "primaryText": "Hook line.\\n\\nValue + product line.\\n\\n₹price | proof.\\n\\nUrgency + CTA.",
      "headline": "Benefit-led headline",
      "cta": "Order Now",
      "hookStyle": "pain_point"
    }
  ],
  "selectedIndex": 0,
  "selectionReason": "why this variant has the strongest hook and clearest value proposition",
  "imagePrompts": [
    "Vertical 9:16 image for variant 0 — visual centerpiece matched to its pain_point hook...",
    "Vertical 9:16 image for variant 1 — visual centerpiece matched to its bold_claim hook...",
    "Vertical 9:16 image for variant 2 — visual centerpiece matched to its social_proof hook...",
    "Vertical 9:16 image for variant 3 — visual centerpiece matched to its urgency hook..."
  ],
  "videoPrompt": "Pick duration + opener + music based on the SELECTED variant's hookStyle. Write as a single flowing cinematic script, NOT bracketed scenes. Match opener to hookStyle (see prompt rules above) — first frame controls the thumbnail, do NOT default to a dark text card. Match music to hookStyle. Match duration to hookStyle (12-15s for punch hooks like price_shock/urgency, 30-40s for story hooks like pain_point/before_after, 20-30s for social_proof/curiosity_gap). Use astrology-specific b-roll vocabulary (Shani for Sade Sati, Lakshmi for wealth, Hanuman for protection — never generic Western spiritual). Cinematic b-roll only — no avatars, no talking-head. Off-screen Hindi voiceover. Product name '${resolvedProduct?.name ?? 'Product'}' + ₹${resolvedProduct?.price} as exact text in CTA frame. NEGATIVE: no English-only overlays, no watermarks, no celebrity faces, no AI artifacts, no slow fades — hard cuts only.",
  "complianceNotes": "what was flagged and fixed during review",
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "creative-director", "summary": "drafted 4 variants + 4 image prompts + video"},
    {"round": 1, "from": "compliance", "summary": "flagged variant 2, approved rest"},
    {"round": 2, "from": "creative-director", "summary": "revised variant 2"},
    {"round": 2, "from": "compliance", "summary": "all approved"}
  ]
}
    `.trim();
  }

  private async fetchCompetitorHooks(tenantId: string): Promise<string> {
    try {
      const latest = await this.metaAdsLibraryModel
        .findOne({ tenantId })
        .sort({ createdAt: -1 })
        .lean()
        .exec();

      if (!latest?.insights?.competitorAds?.length) {
        return 'No competitor ad data available yet.';
      }

      const hooks = latest.insights.competitorAds
        .filter((ad: any) => ad.score >= 6)
        .slice(0, 5)
        .map((ad: any, i: number) =>
          `  ${i + 1}. ${ad.competitor}: "${ad.hook}" — angle: ${ad.angle} | ${ad.format} | ${ad.estimatedDaysRunning > 0 ? `${ad.estimatedDaysRunning} days running` : 'days unknown'} | score: ${ad.score}`
        )
        .join('\n');

      return hooks || 'No high-confidence competitor ads found this run.';
    } catch {
      return 'Competitor hook data unavailable this run.';
    }
  }

  private parseOutput(content: string): CreativeTeamOutput {
    let jsonStr = '';
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonStr);
      // Validate imagePrompts is an array — LLM may return old singular imagePrompt format
      if (!Array.isArray(parsed.imagePrompts)) {
        if (typeof parsed.imagePrompt === 'string' && parsed.imagePrompt) {
          // Backward-compat: wrap singular into array and log a warning
          this.logger.warn('Creative Team returned imagePrompt (singular) — wrapping into imagePrompts array');
          parsed.imagePrompts = [parsed.imagePrompt, parsed.imagePrompt, parsed.imagePrompt];
          delete parsed.imagePrompt;
        } else {
          throw new Error(`imagePrompts must be an array, got: ${typeof parsed.imagePrompts}`);
        }
      }
      // Normalize videoPrompt — must be a string (Heygen Video Agent prompt)
      if (Array.isArray(parsed.videoPrompt)) {
        this.logger.warn('Creative Team returned videoPrompt as array (old format) — converting to string');
        parsed.videoPrompt = (parsed.videoPrompt as any[])
          .map((s: any) => typeof s === 'string' ? s : `${s.text ?? ''} | ${s.visual ?? ''}`)
          .join('\n');
      } else if (typeof parsed.videoPrompt !== 'string') {
        parsed.videoPrompt = String(parsed.videoPrompt ?? '');
      }
      return parsed;
    } catch (err: any) {
      this.logger.error(`Creative Team output parse failed: ${err.message} | content snippet: ${content.slice(0, 300)}`);
      throw new Error(`Creative Team returned invalid JSON: ${err.message}`);
    }
  }

  /**
   * Vertical-specific creative context — vocabulary, voice rules, do/don't lists,
   * and verbatim winning-style examples. Without this, generic-spirituality copy
   * (which underperforms astro-specific copy by 2-3× on cold prospect) ships by default.
   *
   * Spirituality is the only vertical with a dedicated block today; other verticals
   * fall through to a no-op. Add per-vertical blocks here as the tenant base grows.
   */
  private buildVerticalContextBlock(
    industry: string | undefined | null,
    audienceStage?: 'cold' | 'warm' | 'hot',
    avoidHookStyles?: string[],
  ): string {
    const vertical = resolveVertical(industry);
    if (vertical !== 'spirituality') return '';

    // Astro hook examples — tagged with hookStyle + applicable stages so we can
    // filter when the brief is warm (retarget) vs hot (cart-recovery) instead of
    // pushing cold-prospect framings universally.
    const ASTRO_HOOK_PATTERNS: Array<{
      tag: string;
      example: string;
      hookStyle: string;
      stages: Array<'cold' | 'warm' | 'hot'>;
    }> = [
      { tag: 'TRANSIT-EVENT',       example: '"Mangal ka transit start ho gaya — career mein bade decisions abhi mat lo"', hookStyle: 'urgency',       stages: ['cold', 'warm'] },
      { tag: 'DOSHA-CALLOUT',       example: '"Aapki kundli mein Manglik dosh hai? Shaadi karne se pehle ye padh lo"',     hookStyle: 'pain_point',    stages: ['cold'] },
      { tag: 'SECRET-REVEAL',       example: '"99% astrologers ye nahi batate — Sade Sati mein ye 3 cheezein avoid karo"', hookStyle: 'curiosity_gap', stages: ['cold', 'warm'] },
      { tag: 'ASTROLOGER-WARNING',  example: '"Pandit ji kehte hain — agar Shani 7th house mein hai, toh aaj ye karo"',    hookStyle: 'social_proof',  stages: ['cold', 'warm'] },
      { tag: 'PERSONAL-PREDICTION', example: '"Aapka rashi number kya hai? Iss hafte ka prediction free mein paao"',       hookStyle: 'curiosity_gap', stages: ['cold'] },
      { tag: 'SPECIFIC-TIMEFRAME',  example: '"Agle 21 din mein aapki kundli ka 1 grah change hone wala hai"',              hookStyle: 'urgency',       stages: ['cold', 'warm'] },
      // Warm/hot retargeting-specific patterns — added in B3 so warm briefs have
      // examples that don't sound like cold-prospect framings.
      { tag: 'OFFER-RECALL',        example: '"Aapki ₹1 reading wait kar rahi hai — kundli check kar lo aaj"',              hookStyle: 'urgency',       stages: ['warm', 'hot'] },
      { tag: 'OBJECTION-HANDLE',    example: '"Pehli baat free — kuch lagega bhi nahi. Pandit ji ka time abhi available hai."', hookStyle: 'social_proof', stages: ['warm', 'hot'] },
      { tag: 'CART-DEADLINE',       example: '"Aaj raat tak ₹1 mein consultation — kal full price ₹399"',                  hookStyle: 'urgency',       stages: ['hot'] },
    ];

    const stage = audienceStage ?? 'cold';
    const avoidSet = new Set(avoidHookStyles ?? []);
    const filtered = ASTRO_HOOK_PATTERNS
      .filter(p => p.stages.includes(stage))
      .filter(p => !avoidSet.has(p.hookStyle));
    // If everything got filtered out (over-restrictive avoidHookStyles), fall back
    // to stage-only filter so the LLM still has at least 2-3 examples to anchor on.
    const examplesToShow = filtered.length >= 2
      ? filtered
      : ASTRO_HOOK_PATTERNS.filter(p => p.stages.includes(stage));
    const formatted = examplesToShow
      .map(p => `- ${p.tag}: ${p.example}`)
      .join('\n');

    return `═══════════════════════════════════════════════════════
SPIRITUALITY VERTICAL — ASTROLOGY CONTEXT (REQUIRED READING)
═══════════════════════════════════════════════════════

VOCABULARY YOU MUST USE WHEN THE TOPIC FITS:
- Sade Sati (Saturn's 7.5-year transit through three signs — peak anxiety driver for Capricorn/Aquarius/Pisces)
- Mahadasha / Antar Dasha (planetary periods that govern life phases)
- Mercury Retrograde / Saturn Retrograde (transits that disrupt communication / career)
- Rahu / Ketu placements (north/south node — destiny patterns, relationship issues)
- Manglik Dosha / Pitra Dosh / Kaal Sarp Dosh / Shani Dosh (chart afflictions — high-intent search terms)
- Kundli / Janam Kundli (birth chart — the central artifact of astro consultations)
- Nakshatra (lunar mansion — granular personality reading)
- Gochar (current planetary transits affecting the chart)
- Panchang (auspicious timing for decisions)

VOICE RULE — speak AS the astrologer revealing a secret, NOT as a brand selling a product.
- ✓ "Aapki kundli mein Shani ki dhaiyya start ho gayi hai. Career mein 2-3 saal mushkil hain — par ek upay hai."
- ✗ "Get the most accurate astrology readings online! Book now."
- The astrologer voice is warm, knowing, slightly mystical, factual when stating chart positions, never preachy, never sounds like a discount retailer.

HIGH-CONVERTING HOOK PATTERNS (filtered for stage="${stage}"${avoidSet.size > 0 ? `, avoiding: ${[...avoidSet].join(', ')}` : ''}; use as inspiration for STRUCTURE/FRAMING — do NOT copy verbatim):
${formatted}

DO / DON'T:
✓ Use Hinglish naturally — Devanagari is fine for emotional weight, Roman for accessibility
✓ Reference specific astrology concepts — generic "spiritual guidance" loses to "Saturn transit relief"
✓ Speak in first-person astrologer voice OR second-person reader-callout
✓ Acknowledge specific pain (career stuck, marriage delayed, family conflict, financial loss) — vague "find peace" is dead
✗ Don't promise GUARANTEED outcomes ("Manglik dosh removed in 21 days") — Meta will reject; safety check will block
✗ Don't use Western "spiritual wellness" aesthetic (crystals, mandalas, generic chakras) — losses to authentic Indian-astro
✗ Don't say "100% accurate predictions" — Meta auto-flag

FOR HEADLINES specifically: short Hinglish phrases beat English (e.g. "Kundli check karo — ₹1 mein" beats "Get your kundli reading at ₹1").

═══════════════════════════════════════════════════════`;
  }
}
