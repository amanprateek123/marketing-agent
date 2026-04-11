import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CopyVariant } from '../creative/schemas/creative-package.schema';
import { runTeamViaCli, CliResult } from './team-cli.util';
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

    // Resolve product — match by brief.product name, fallback to first active, then first in list
    const resolvedProduct = (company.products ?? []).find(p => p.name === brief.product)
      ?? (company.products ?? []).find(p => p.active)
      ?? (company.products ?? [])[0]
      ?? null;

    // Get relevant creative case studies
    let caseStudyContext = '';
    try {
      const product = resolvedProduct;
      const caseStudies = await this.metaLearningImporter.getRelevantCaseStudies(
        company.tenantId,
        { product: product?.name, limit: 7 },
      );
      if (caseStudies.length > 0) {
        caseStudyContext = `
PAST CREATIVE CASE STUDIES (what hooks/formats worked and failed):
${caseStudies.slice(0, 7).map((cs, i) => `  ${i + 1}. ${cs.campaignName}: ${cs.whatWorked?.hooks?.join(', ') || 'unknown'} hooks worked (CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}). ${cs.whatFailed?.reason || ''} Lesson: ${cs.lesson}`).join('\n')}`;
      }
    } catch (err: any) { this.logger.warn(`Case studies unavailable for ${company.tenantId}: ${err.message}`); }
    const creative = company.learnings?.creative;

    const learningsBlock = creative
      ? `
PAST CREATIVE LEARNINGS:
- Winning hooks: ${creative.winningHooks?.join(', ') || 'none yet'}
- Losing hooks: ${creative.losingHooks?.join(', ') || 'none yet'}
- Winning formats: ${creative.winningFormats?.join(', ') || 'none yet'}
- CTA insights: ${creative.ctaInsights?.join(', ') || 'none yet'}
- Visual insights: ${creative.visualInsights?.join(', ') || 'none yet'}
- Copy tone insights: ${creative.copyToneInsights?.join(', ') || 'none yet'}
`
      : 'No past creative learnings yet.';

    return `
You ARE the Creative Director for ${company.name}. You will create the full ad creative package and debate it with a Brand Compliance Reviewer.

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

    REVIEW PROTOCOL:
    - You will receive the full creative package (copy + image prompt + video prompt) via SendMessage.
    - For each element: APPROVE it, or FLAG it with the specific issue and a suggested fix.
    - Be strict on Meta policies (a rejected ad wastes the entire pipeline).
    - Be constructive on creative feedback — don't just say 'bad', say 'change X to Y because Z'.
    - When the Creative Director revises, review the changes and either approve or flag again.
    - When everything passes, send a final message: {type: 'approved', notes: 'summary of what was fixed'}.
    - Send all messages to 'team-lead'. Respond IMMEDIATELY when you receive a message."

STEP 3: Create the full creative package for this brief:

BRIEF:
  Topic: ${brief.topic}
  Angle: ${brief.angle}
  Platform: ${brief.platform} | Format: ${brief.format}
  Audience: ${brief.audience}
  Hook: ${brief.hook}
  Key Message: ${brief.keyMessage}
  Conversion Bridge: ${brief.conversionBridge}

${(() => {
  const product = resolvedProduct;
  if (!product) return 'PRODUCT: not specified — use company info for CTA';
  return `PRODUCT BEING SOLD:
  Name: ${product.name}
  Price: ₹${product.price}
  Landing URL: ${product.landingUrl ?? 'not set'}
  Languages: ${(product.languages ?? []).join(', ') || 'Hindi, English'}
  Differentiators: ${(product.differentiators ?? []).join(' | ') || 'not set'}
  Target segment: ${brief.targetSegment ?? 'general'}

  IMPORTANT: Every copy variant MUST:
  - Mention the product name ("${product.name}")
  - Include the price (₹${product.price})
  - CTA must drive to the specific product, not generic "learn more"`;
})()}

Brand Guidelines: ${company.brandGuidelines || 'Not specified'}
Tone: ${company.tone}
Avoid: ${company.avoid?.join(', ') || 'nothing specified'}

${learningsBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOU ARE WRITING META DIRECT RESPONSE ADS — NOT SOCIAL MEDIA POSTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is a PAID Meta ad. The user is scrolling their feed and has NOT asked to see this.
Your creative must:
1. Stop the scroll in the FIRST LINE / FIRST 3 SECONDS
2. Make the value proposition crystal clear (product + benefit + price)
3. Push to ONE action — tap the CTA button

Meta ads that convert follow direct response principles — not brand awareness, not engagement bait.
Study what top DTC brands in India do: clear hook → problem/desire → solution (your product) → price reveal → urgency → CTA.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
a) 3 AD COPY VARIANTS — each a complete, standalone Meta ad
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each variant needs:
- primaryText: the full ad body (3-5 lines). MUST follow this structure:
  LINE 1 — THE HOOK: This is the scroll-stopper. First 90 characters are shown before "See more". Make it impossible to ignore.
  LINE 2-3 — THE VALUE: Agitate the pain OR amplify the desire. Then introduce the product as the solution. MUST mention product name.
  LINE 4 — PRICE + PROOF: State the price (₹[price]). Add social proof if available (X customers, ratings, results).
  LINE 5 — CTA LINE: Create urgency. "Order now", "Limited stock", "Offer ends Sunday" — something that pushes action TODAY.
- headline: appears below the image/video. 5-7 words. Lead with the benefit or price. E.g. "Get [Product] for ₹[price] Today"
- cta: button text — be specific: "Shop Now", "Order Now", "Buy Today", NOT "Learn More" unless it's a considered purchase
- hookStyle: the hook type used

HOOK STYLE OPTIONS (use one per variant, all 3 must be different):
  1. "pain_point" — open with the exact frustration your audience feels. "Tired of [problem]?" / "Still struggling with [X]?"
  2. "bold_claim" — make a specific, provable promise. "We helped 10,000 people [result] in 30 days."
  3. "price_shock" — lead with the value proposition and price. "₹[price] for [benefit]. No catch."
  4. "social_proof" — open with a result or testimonial. "[X] people in [city] already switched to [product]."
  5. "curiosity_gap" — make them need to know more. "The one thing [competitor customers] don't know about [category]."
  6. "before_after" — describe the transformation (Meta policy: frame as aspiration not guarantee). "From [problem] to [result] — here's how."
  7. "urgency" — time or stock scarcity. "Only [X] left at this price. After that it's ₹[higher price]."

COPY RULES:
- Hinglish where natural for ${company.targetAudience} — mix Hindi words/phrases in English sentences
- Specific beats vague: "lost 4kg in 3 weeks" beats "see results fast"
- Product name must appear in EVERY variant's primaryText
- Price must appear in at least 2 of the 3 variants
- No generic phrases: "best quality", "amazing product", "don't miss out" — these kill CTR

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
b) IMAGE PROMPT — for AI image generation (Gemini)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is for a META AD IMAGE — not an editorial photo or social post.
Top-performing Meta ad images follow these patterns:

WHAT WORKS ON META:
- Product prominently in frame (not lifestyle-only — show what they're buying)
- Human using the product with a visible result or emotion
- Bold text overlay suggestion: include "{HOOK TEXT}" and "₹{PRICE}" as text overlay areas in your description — describe WHERE on the image these should be placed
- High contrast, thumb-stopping colors — avoid dull/muted tones
- Before/after split (where policy allows) or transformation moment

FORMAT:
- Vertical 9:16
- Photorealistic
- Indian faces, locations, aesthetic
- Describe: subject, action, product placement, background, lighting, color palette, mood
- Specify text overlay zones: "Top third: bold white text '[hook]'. Bottom: product name + price in yellow"
- 3-4 sentences

AVOID:
- Stock photo look — real, raw, authentic performs better
- Cluttered composition — one clear focal point
- Text-free images for direct response ads — text overlays dramatically boost performance

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
c) VIDEO PROMPT — for Heygen Video Agent API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write a complete 15-20 second vertical Meta video ad script for Heygen.
Plain text only, under 150 words. Structure it EXACTLY like this:

SECONDS 0-3 — HOOK (most important — 70% of viewers decide here):
  State the exact problem or desire in Hinglish. Make the viewer feel "this is for me."
  Example: "Yaar, gym jaate ho aur results nahi? Sunn..."

SECONDS 3-12 — PRODUCT + BENEFIT:
  Introduce [product name] by name. Show 1-2 specific benefits visually.
  Mention what makes it different from what they've tried before.
  Avoid generic claims — be specific.

SECONDS 12-18 — PRICE + SOCIAL PROOF:
  Clearly say the price: "Sirf ₹[price] mein" or "[price] rupaye mein milega."
  Add a proof point: number of customers, a result, a rating.

SECONDS 18-20 — CTA:
  "Neeche button tap karo aur order karo abhi" or equivalent.
  Create urgency: limited stock / offer ends / exclusive price.

VISUAL STYLE: Indian urban/semi-urban, energetic, modern. Show the product being used.

STRICT RULES:
- NEVER say "link in bio" — users tap a CTA button directly
- NEVER mention the brand logo — add in post-processing
- Product name MUST be spoken aloud in the voiceover
- Price MUST be spoken aloud

STEP 4: Send the full package to the Brand Compliance Reviewer via SendMessage(to: "compliance"). Label as "ROUND 1".
CRITICAL: After SendMessage, do NOT output any text. Immediately call TaskCreate with name "round-1-pending" and body "waiting for compliance response". This keeps you active so the reviewer's reply can arrive. Do not produce any output until you receive their message.

STEP 5: When you receive the reviewer's response (it arrives as an incoming message):
  - If flagged: revise the package, then SendMessage(to: "compliance") as "ROUND 2", then call TaskCreate(name: "round-2-pending") again — do NOT output text between rounds.
  - If approved ({type: "approved"}): proceed to STEP 6.
  - Max 5 rounds. Keep calling TaskCreate after each SendMessage to stay alive.
  PATIENCE: The reviewer runs in the background and takes several minutes to respond. Do NOT give up or produce output on your own. Keep waiting via TaskCreate until their message arrives. Only nudge once (via SendMessage) if you have called TaskCreate 4+ times with no reply.

STEP 6: Once the reviewer approves:
  1. SendMessage(to: "compliance", message: {type: "shutdown_request"})
  2. Call TaskCreate(name: "shutdown-pending", body: "waiting for shutdown confirmation") — do NOT call TeamDelete yet.
  3. Wait for the shutdown confirmation to arrive as an incoming message.
  4. Only after receiving confirmation: call TeamDelete.
  If TeamDelete fails after receiving confirmation, SKIP IT — cleanup is automatic. Proceed to output.

STEP 7: Return ONLY this JSON (no markdown, no explanation):
{
  "variants": [
    {
      "primaryText": "Hook line that stops the scroll.\n\nProduct name + benefit + solution line.\n\n₹[price] | social proof line.\n\nUrgency + CTA line.",
      "headline": "Benefit-led headline with ₹price",
      "cta": "Order Now",
      "hookStyle": "pain_point | bold_claim | price_shock | social_proof | curiosity_gap | before_after | urgency"
    }
  ],
  "selectedIndex": 0,
  "selectionReason": "why this variant has the strongest hook and clearest value proposition for the target audience",
  "imagePrompt": "Vertical 9:16 Meta ad image. [Subject + action + product placement]. [Background + lighting + colors]. Text overlay: top third shows '[hook text]' in bold white, bottom shows product name + ₹[price] in high contrast. Indian [urban/rural] aesthetic, photorealistic.",
  "videoPrompt": "15-20 second vertical Meta ad for [product name] targeting [audience]. Opens with [exact hook in Hinglish, 0-3s]. Shows [product name] solving [problem] with [specific visual, 3-12s]. Voiceover says 'Sirf ₹[price] mein' with proof point [12-18s]. Closes with 'Neeche button tap karo aur order karo abhi' [18-20s]. Indian urban aesthetic, energetic.",
  "complianceNotes": "what was flagged and fixed during review",
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "creative-director", "summary": "drafted 3 direct response variants with pain_point, bold_claim, price_shock hooks + image + video prompts"},
    {"round": 1, "from": "compliance", "summary": "flagged variant 2 for prohibited claim, approved rest"},
    {"round": 2, "from": "creative-director", "summary": "revised variant 2"},
    {"round": 2, "from": "compliance", "summary": "all approved"}
  ]
}

${liveContext}

${caseStudyContext}

CAMPAIGN STRATEGY MODE: ${company.pipelineConfig?.campaignStrategy ?? 'balanced'}
${(() => {
  const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
  if (strategy === 'conservative') return `- CONSERVATIVE MODE: Use proven hook styles from past learnings only. Stick to visual formats that have worked before. Minimize creative risk — safe, on-brand, tested patterns.`;
  if (strategy === 'experimental') return `- EXPERIMENTAL MODE: Try bold, untested hook styles. Push creative boundaries — unusual visuals, provocative angles. At least 1 variant should be genuinely risky/different from anything tried before.`;
  return `- BALANCED MODE: 2 variants should use proven hook styles from learnings. 1 variant should test a new hook style or creative angle. This gives reliable performance + fresh creative data.`;
})()}

RULES:
- These are META DIRECT RESPONSE ADS — optimise for tap-through rate, not likes or comments
- Every copy variant must use a different hookStyle — 3 completely different opening strategies
- Product name must appear in every variant's primaryText — always
- Price must appear in at least 2 of the 3 variants — hiding price kills conversion intent
- Image and video prompts must visually reinforce the winning variant's hook and message
- Do NOT pick the winning variant before compliance review — the review may change the best choice
- If a variant gets flagged and cannot be fixed without gutting the message, replace it entirely
- The compliance reviewer should be especially strict on: medical/health claims, before/after framing, guaranteed results, competitor disparagement
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
