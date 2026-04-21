import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { ClaudeService } from '../claude/claude.service';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CopyVariant } from '../creative/schemas/creative-package.schema';
import { runTeamViaCli } from './team-cli.util';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { MetaAdsLibraryOutput, MetaAdsLibraryOutputDocument } from '../pipeline/schemas/meta-ads-library-output.schema';

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

    const call2UserMessage = `You are the Brand Compliance Reviewer for ${company.name}.

Review the creative package below for:
1. META AD POLICIES — prohibited claims, restricted content, before/after framing, medical/financial promises
2. BRAND TONE — must be "${company.tone}". Flag anything off-brand.
3. PLATFORM SPECS — ${brief.platform} requirements
4. CULTURAL SENSITIVITY — content targets ${company.targetAudience} in ${company.geography}
5. FORBIDDEN TOPICS: ${company.forbiddenTopics?.join(', ') || 'none specified'}
6. PRODUCT ACCURACY — product name must be "${resolvedProduct?.name ?? brief.product ?? 'correct'}", price must be ₹${resolvedProduct?.price ?? 'correct'}

CREATIVE PACKAGE TO REVIEW:
${JSON.stringify(call1Parsed, null, 2)}

YOUR JOB:
- For each element (copy variants, imagePrompts, video prompt): APPROVE it, or give a specific fix.
- If a variant violates Meta policies in a way that can't be fixed, replace it with a compliant alternative.
- If an imagePrompts[i] won't stop the scroll for its matching variant hook, improve it.
- Select the best variant (index 0, 1, 2, or 3) for the "selectedIndex" field.

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
  "videoPrompt": "Create a 15-second 9:16 vertical Meta conversion ad for [Brand]. Cinematic b-roll visuals with text overlays and off-screen Hindi voiceover narration, Indian instrumental background music.\\n\\nTEXT OVERLAYS:\\n0-3s: [Hook line in bold Hindi/Hinglish — instant self-identification]\\n3-7s: [Pain/desire — specific, resonant, 1 sentence]\\n7-12s: [Product name + benefit]\\n12-15s: ₹[price] | [CTA action] — bold, urgent\\n\\nBACKGROUND: [Specific culturally relevant Indian visual — warm, high-contrast, emotionally matched to hook]\\n\\nMUSIC: [Indian classical instrument — starts 15%, rises to 45% at CTA, no vocals, builds toward urgency]\\n\\nGOAL: Viewer feels recognized at 3s, desires product by 12s, taps CTA at 15s.",
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
    });

    this.logger.log(`Creative Team sequential — Call 2 done | tenant: ${tenantId} | run: ${runId}`);
    return this.parseOutput(call2.content);
  }

  private async buildCall1Prompt(
    brief: {
      topic: string; angle: string; platform: string; format: string;
      audience: string; hook: string; keyMessage: string; conversionBridge: string;
      product?: string; targetSegment?: string;
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<string> {
    // Same as buildPrompt but STEPS section replaced with simple JSON output instruction
    const fullPrompt = await this.buildPrompt(brief, company, runId);

    // Strip everything from STEPS onwards and replace with a direct output instruction
    const stepsIdx = fullPrompt.indexOf('═══════════════════════════════════════════════════════\nSTEPS');
    const withoutSteps = stepsIdx !== -1 ? fullPrompt.slice(0, stepsIdx).trimEnd() : fullPrompt;

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
  "videoPrompt": "Create a 15-second 9:16 vertical Meta conversion ad for [Brand]. Cinematic b-roll visuals with text overlays and off-screen Hindi voiceover narration, Indian instrumental background music.\\n\\nTEXT OVERLAYS:\\n0-3s: [Hook line in bold Hindi/Hinglish — instant self-identification]\\n3-7s: [Pain/desire — specific, resonant, 1 sentence]\\n7-12s: [Product name + benefit]\\n12-15s: ₹[price] | [CTA action] — bold, urgent\\n\\nBACKGROUND: [Specific culturally relevant Indian visual — warm, high-contrast, emotionally matched to hook]\\n\\nMUSIC: [Indian classical instrument — starts 15%, rises to 45% at CTA, no vocals, builds toward urgency]\\n\\nGOAL: Viewer feels recognized at 3s, desires product by 12s, taps CTA at 15s.",
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

    // Visual learnings for image/video prompts
    const creative = company.learnings?.creative;
    const visualLearnings = (() => {
      const lines: string[] = [];
      if (creative?.visualInsights?.length) lines.push(`Visual patterns that work: ${creative.visualInsights.join('; ')}`);
      if (creative?.winningHooks?.length) lines.push(`Winning hook styles (use in text overlays): ${creative.winningHooks.join(', ')}`);
      if (creative?.losingHooks?.length) lines.push(`Losing hook styles (avoid in visuals): ${creative.losingHooks.join(', ')}`);
      if (creative?.ctaInsights?.length) lines.push(`CTA insights: ${creative.ctaInsights.join('; ')}`);
      return lines.length > 0 ? lines.join('\n') : 'No visual learnings yet.';
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

${liveContext}

${caseStudyContext}

COMPETITOR WINNING HOOKS (from Meta Ads Library — use as inspiration to differentiate, not to copy):
${competitorHooks}
Study what angles competitors are already running. If they own "pain_point", try "bold_claim" or "before_after" instead.

CAMPAIGN STRATEGY: ${strategyMode}

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
- hookStyle: one of the options below (each variant must use a DIFFERENT one)

HOOK STYLES (use one per variant — pick 4 different styles, one per variant):
  "pain_point" — open with the audience's frustration
  "bold_claim" — specific, provable promise
  "price_shock" — lead with value proposition + price
  "social_proof" — open with result or testimonial
  "curiosity_gap" — make them need to know more
  "before_after" — transformation (frame as aspiration, not guarantee)
  "urgency" — time or stock scarcity

COPY RULES:
- Hinglish where natural for ${company.targetAudience}
- Specific beats vague: "lost 4kg in 3 weeks" beats "see results fast"
- Product name in EVERY variant's primaryText
- Price (₹${resolvedProduct?.price ?? '[price]'}) in EVERY variant — no exceptions
- No generic phrases: "best quality", "amazing product", "don't miss out"
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

AVOID:
- Generic images where the main concept is small/hidden — if the ad is about a specific date, that date must DOMINATE
- Lifestyle photos with no clear focal point
- Muted/pastel colors — they disappear in the feed
- Cluttered composition — one centerpiece, one message
- Stock photo aesthetic — real, raw, Indian performs better
- Images that look "nice" but don't sell — every element must push toward the tap

━━━ c) VIDEO CREATIVE — Heygen Video Agent prompt ━━━

Write a CINEMATIC SCRIPT prompt for Heygen's AI Video Generator (V3 Video Agent API). This prompt is sent DIRECTLY to Heygen — write it as a natural-language film script that Heygen's AI can interpret and render.

FORMAT: Write the prompt as a single flowing script. Describe visuals, text on screen, voiceover narration, and music as a continuous cinematic direction. Do NOT use numbered scenes or brackets — write it like you're directing a short film.

THE AD MUST CREATE:
1. CURIOSITY — an irresistible open loop in the first 2 seconds that makes the viewer NEED to keep watching
2. BUY INTENT — build desire so strong that tapping the CTA feels inevitable, not optional

STRUCTURE (15 seconds total, 9:16 vertical format):

OPENING (0–3s): Start with a DARK background. A single bold Hindi/Hinglish text line fades in — large, white or gold on black. This is the curiosity hook — a provocative question or shocking statement from the brief that makes the viewer freeze mid-scroll. The text should feel like a personal whisper, not an ad. Add a soft, mysterious sound — a single tanpura drone or a deep bell.

TENSION (3–7s): The dark background shifts to a moody, cinematic visual — specific to the Indian context. Describe the exact setting, lighting, and mood (e.g., "dimly lit puja room with a single diya flame flickering, casting shadows on an open kundli chart"). A Hindi voiceover narration begins — speaking directly to the viewer's deepest fear or desire related to the brief's topic. The voice is warm, confident, slightly urgent — like a trusted elder revealing a secret. A second text overlay appears reinforcing the pain point. Music builds slowly — add tabla or soft sitar underneath the tanpura.

REVEAL (7–12s): Visual shifts to the product/transformation — brighter, warmer tones contrasting the dark opening. Show what changes with ${resolvedProduct?.name ?? 'the product'}. Voiceover delivers the key promise in one powerful Hindi/Hinglish line. Bold text overlay shows the product name. Music lifts — energy increases, instruments layer in.

CTA (12–15s): Dark background returns. Large, high-contrast text: "₹${resolvedProduct?.price} | [specific CTA action]". Voiceover delivers a final urgency line — "Aaj hi jaano" / "Sirf aaj" / "Pehla kadam lo". Music hits a final beat and stops clean. Silence after the beat creates tension.

AUDIO DIRECTION:
- Background music: Indian classical instrumental that builds across the ad. Start minimal (single tanpura/drone), end full (tabla + sitar/bansuri + tanpura). The music must create a MOOD — mysterious, then hopeful, then urgent.
- Voiceover: Hindi/Hinglish, male or female voice that sounds wise and trustworthy. NOT a sales pitch tone — more like a caring friend sharing important news. The voiceover must speak in conversational Hindi, not formal/textbook Hindi.
- Sound design: Use a subtle whoosh or reveal sound when transitioning from dark to product reveal.

VISUAL RULES:
- 9:16 vertical format for Instagram/Facebook Reels
- DARK backgrounds dominate — scenes 1 and 4 are pure dark/black, scenes 2 and 3 use moody low-light cinematography
- All text overlays: bold sans-serif font, large enough to read on mobile, white or gold on dark backgrounds
- All text in Hindi or Hinglish — zero English-only lines
- Each visual must be DIFFERENT from the previous — hard cuts, no fade transitions
- Be hyper-specific with visuals — "close-up of trembling hands holding a tattered kundli paper, warm diya light from below" not "person looking at horoscope"
- Product name "${resolvedProduct?.name ?? 'Product'}" and price ₹${resolvedProduct?.price} must appear as exact text, never as placeholders
- No talking head, no avatar, no face-to-camera — cinematic b-roll visuals with text overlays and OFF-SCREEN Hindi voiceover narration (voice is heard but no person is shown speaking)
- No stock footage look, no watermarks, no celebrity faces, no religious imagery beyond astrology/spiritual context

═══════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════

- These are META DIRECT RESPONSE ADS — optimise for tap-through rate, not likes or comments
- Every copy variant must use a different hookStyle — 3 completely different opening strategies
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
  "videoPrompt": "[Scene 1] 0–3s — HOOK\\nVisual: [specific Indian setting matching hook emotion]\\nText overlay: [exact Hindi/Hinglish hook words]\\n\\n[Scene 2] 3–7s — PAIN/DESIRE\\nVisual: [different location showing problem or desire]\\nText overlay: [exact pain/desire line]\\n\\n[Scene 3] 7–12s — PRODUCT REVEAL\\nVisual: [product or transformation visual]\\nText overlay: [product name + benefit in Hindi/Hinglish]\\n\\n[Scene 4] 12–15s — CTA\\nVisual: [urgency visual]\\nText overlay: ₹[price] | [CTA action]\\n\\nMUSIC: [Indian classical instrument — tanpura/sitar/bansuri/tabla]. Builds across all 4 scenes. No vocals.\\n\\nNEGATIVE PROMPTS: No English-only overlays. No watermarks. No celebrity faces. No AI artifacts. No cursive fonts. No slow fades — hard cuts only.",
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
}
