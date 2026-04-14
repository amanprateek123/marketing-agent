import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CopyVariant } from '../creative/schemas/creative-package.schema';
import { runTeamViaCli } from './team-cli.util';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';

export interface CreativeTeamOutput {
  variants: CopyVariant[];
  selectedIndex: number;
  selectionReason: string;
  imagePrompt: string;
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
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly metaLearningImporter: MetaLearningImporterService,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
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
    this.logger.log(`Creative Team starting | tenant: ${tenantId} | run: ${runId}`);

    const prompt = await this.buildPrompt(brief, company, runId);
    const cliResult = await runTeamViaCli(prompt, `creative-${runId}`, 'Creative');

    await this.usageLogModel.create({
      tenantId,
      runId,
      agent: AgentType.CREATIVE_TEAM_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(
      `Creative Team completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns} | cost: $${cliResult.total_cost_usd?.toFixed(4)}`,
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
      product?: string;
      targetSegment?: string;
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<string> {
    const liveContext = this.liveContextBuilder.build(company);

    // Resolve product
    const resolvedProduct = (company.products ?? []).find(p => p.name === brief.product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0]
      ?? null;

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
        ? `EXPERIMENTAL MODE: Try bold, untested hook styles. Push creative boundaries. At least 1 variant should be genuinely risky/different from anything tried before.`
        : `BALANCED MODE: 2 variants should use proven hook styles from learnings. 1 variant should test a new hook style or creative angle.`;

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

CAMPAIGN STRATEGY: ${strategyMode}

═══════════════════════════════════════════════════════
CREATIVE SPECS
═══════════════════════════════════════════════════════

This is a PAID Meta direct response ad. The user is scrolling and has NOT asked to see this.
Your creative must: (1) stop the scroll in the FIRST LINE / FIRST 3 SECONDS, (2) make the value proposition crystal clear (product + benefit + price), (3) push to ONE action — tap the CTA button.

━━━ a) 3 AD COPY VARIANTS ━━━

Each variant needs:
- primaryText: full ad body (3-5 lines). Structure:
  LINE 1 — THE HOOK: Scroll-stopper. First 90 chars shown before "See more".
  LINE 2-3 — THE VALUE: Agitate pain OR amplify desire. Introduce product as solution. MUST mention product name.
  LINE 4 — PRICE + PROOF: State price (₹${resolvedProduct?.price ?? '[price]'}). Add social proof if available.
  LINE 5 — CTA LINE: Create urgency. Push action TODAY.
- headline: 5-7 words below the image/video. Lead with benefit or price.
- cta: button text — "Shop Now", "Order Now", "Buy Today" (NOT "Learn More" unless considered purchase)
- hookStyle: one of the options below (each variant must use a DIFFERENT one)

HOOK STYLES (use one per variant, all 3 different):
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
- Price in at least 2 of 3 variants
- No generic phrases: "best quality", "amazing product", "don't miss out"
${resolvedProduct ? `- Every variant MUST mention "${resolvedProduct.name}" and ₹${resolvedProduct.price}` : ''}

━━━ b) IMAGE PROMPT — for Nano Banana (Gemini Image) ━━━

This image must make someone STOP scrolling and TAP the ad. It's not a brand photo — it's a direct response sales image.

STEP 1 — IDENTIFY THE VISUAL CENTERPIECE:
Before writing the prompt, ask yourself: "What is the ONE visual concept that makes THIS specific ad different from a generic ad for the same product?"
Read the topic, angle, hook, and conversion bridge. The answer is in there.

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

━━━ c) VIDEO AD — scene-by-scene script ━━━

Write a 15-20 second vertical (9:16) Meta ad as a SCENE LIST. This is the text-led jump-cut format — the highest converting format on Meta for Indian audiences.

HOW THIS FORMAT WORKS:
- Every 2-3 seconds = NEW SCENE with a sharp cut (not smooth transition)
- Each scene has: BOLD TEXT in Hinglish/Hindi (this is what sells) + a short video clip behind it (emotional wallpaper)
- The TEXT does the selling. The video creates mood. The viewer reads, not watches.
- 5-7 scenes total. Fast pacing. No wasted frames.

SCENE STRUCTURE (follow this exact pattern):

SCENE 1 (0-3s) — HOOK: Bold Hinglish text that creates instant curiosity or hits a pain point. The viewer must think "yeh toh mere baare me hai." Video: dramatic, emotional visual that matches the text.

SCENE 2-3 (3-8s) — PAIN POINTS / DESIRES: Each scene = one relatable question or fear the audience has. Text is a short punchy line in Hinglish. Video: literal visual of what the text says (wedding scene for marriage question, office for career question, etc.)

SCENE 4 (8-12s) — PRODUCT REVEAL: Text introduces ${resolvedProduct?.name ?? 'the product'} as the answer to all the questions above. Video: someone using/reading/holding the product. Close-up, real, authentic.

SCENE 5 (12-15s) — PROOF + PRICE: Text shows social proof ("10,000+ log already use kar rahe hai") + price "₹${resolvedProduct?.price ?? '???'}". Video: happy customer or results visual.

SCENE 6 (15-18s) — CTA: Text = urgency + clear action ("Abhi order karo — limited time offer"). Video: product hero shot or order screen visual.

OUTPUT FORMAT — return as a JSON array inside the videoPrompt field:
[
  { "duration": "0-3s", "text": "Aapka future pehle se likha hua hai", "visual": "Close-up of hands opening an ancient palm leaf manuscript, warm golden light, dust particles visible", "music": "dramatic Indian classical sitar note" },
  { "duration": "3-5s", "text": "Shadi kb hogi?", "visual": "Young Indian couple doing jaymala at a Hindu wedding, colorful mandap, guests cheering", "music": "continues" },
  ...
]

SCENE WRITING RULES:
- "text" field: Hinglish/Hindi. Short (3-8 words max). Punchy. Every line must make the viewer feel something.
- "visual" field: Specific, filmable scene. Indian faces, real settings, not abstract. Describe what the CAMERA SEES — close-up/wide, lighting, colors, action.
- "music" field: Only on scene 1 (set the mood) and if it changes. Indian music — specify style (dramatic/emotional/upbeat).
- Scenes 1-3 must work independently — even if someone only sees 3 seconds, they get one complete thought that's worth stopping for.
- Product name "${resolvedProduct?.name ?? 'Product'}" and price "₹${resolvedProduct?.price ?? '???'}" MUST appear in the text of at least one scene each.
- NO English-only text. Every text line must have at least some Hindi/Hinglish.
- NO "link in bio", NO brand logo, NO "subscribe", NO "hey guys" — this is a paid ad, not content.

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

    REVIEW PROTOCOL:
    - You will receive the full creative package (copy + image prompt + video prompt) via SendMessage.
    - For each element: APPROVE it, or FLAG it with the specific issue and a suggested fix.
    - Be strict on Meta policies (a rejected ad wastes the entire pipeline).
    - Be constructive on creative feedback — don't just say 'bad', say 'change X to Y because Z'.
    - When the Creative Director revises, review the changes and either approve or flag again.
    - When everything passes, send a final message: {type: 'approved', notes: 'summary of what was fixed'}.
    - Send all messages to 'team-lead'. Respond IMMEDIATELY when you receive a message."

STEP 3: Create the full creative package (3 copy variants + image prompt + video prompt) using the brief and specs above.

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
  "imagePrompt": "Vertical 9:16 Meta ad image description...",
  "videoPrompt": [
    { "duration": "0-3s", "text": "Hinglish hook line", "visual": "specific scene description", "music": "mood-setting Indian music" },
    { "duration": "3-5s", "text": "Pain point question", "visual": "matching visual", "music": "continues" }
  ],
  "complianceNotes": "what was flagged and fixed during review",
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "creative-director", "summary": "drafted 3 variants + image + video prompts"},
    {"round": 1, "from": "compliance", "summary": "flagged variant 2, approved rest"},
    {"round": 2, "from": "creative-director", "summary": "revised variant 2"},
    {"round": 2, "from": "compliance", "summary": "all approved"}
  ]
}
    `.trim();
  }

  private parseOutput(content: string): CreativeTeamOutput {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      return JSON.parse(jsonStr);
    } catch {
      this.logger.error('Creative Team output parse failed');
      throw new Error('Creative Team returned invalid JSON');
    }
  }
}
