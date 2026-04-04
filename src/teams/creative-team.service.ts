import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CopyVariant } from '../creative/schemas/creative-package.schema';
import { runTeamViaCli, CliResult } from './team-cli.util';

export interface CreativeTeamOutput {
  variants: CopyVariant[];
  selectedIndex: number;
  selectionReason: string;
  imagePrompt: string;
  videoPrompt: string;
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
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CreativeTeamOutput> {
    const tenantId = company.tenantId;
    this.logger.log(`Creative Team starting | tenant: ${tenantId} | run: ${runId}`);

    const prompt = this.buildPrompt(brief, company, runId);
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
    },
    company: CompanyDocument,
    runId: string,
  ): string {
    const liveContext = this.liveContextBuilder.build(company);
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

Brand Guidelines: ${company.brandGuidelines || 'Not specified'}
Tone: ${company.tone}
Avoid: ${company.avoid?.join(', ') || 'nothing specified'}

${learningsBlock}

Create:
a) 3 AD COPY VARIANTS — each with different hookStyle:
   - primaryText: main ad body (2-4 sentences, Hinglish where natural for this audience)
   - headline: punchy (5-8 words max)
   - cta: button text (3-5 words)
   - hookStyle: tag it (question, bold_claim, fear_then_relief, social_proof, personal_story)

b) IMAGE PROMPT — for AI image generation (Gemini):
   - Vertical 9:16 format
   - Photorealistic or cinematic
   - Indian aesthetic — faces, locations, cultural cues
   - No text in the image (text overlay added separately)
   - Describe: lighting, color palette, composition, mood, focal point
   - 2-3 sentences

c) VIDEO PROMPT — for AI video generation (Kling AI):
   - Vertical 9:16, 15-20 seconds
   - Describe: opening shot, middle scene, closing shot
   - Color grade, mood, camera movement
   - Visual storytelling only (no spoken dialogue)
   - First 0.5 seconds MUST have motion (no static opening)
   - 3-5 sentences

STEP 4: Send the full package to the Brand Compliance Reviewer via SendMessage(to: "compliance"). Label as "ROUND 1".

STEP 5: Wait for the reviewer's response. They will approve or flag each element.
  - If flagged: revise and send back as "ROUND 2"
  - Keep going until everything is approved (max 5 rounds)

STEP 6: Once approved, call TeamDelete to clean up. If TeamDelete fails, SKIP IT — do not retry. Cleanup will be handled automatically. Proceed directly to the output.

STEP 7: Return ONLY this JSON (no markdown, no explanation):
{
  "variants": [
    {
      "primaryText": "...",
      "headline": "...",
      "cta": "...",
      "hookStyle": "..."
    }
  ],
  "selectedIndex": 0,
  "selectionReason": "why this variant is the strongest",
  "imagePrompt": "detailed image generation prompt...",
  "videoPrompt": "detailed video generation prompt...",
  "complianceNotes": "what was flagged and fixed during review",
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "creative-director", "summary": "drafted 3 variants + image + video prompts"},
    {"round": 1, "from": "compliance", "summary": "flagged variant 2 for prohibited claim, approved rest"},
    {"round": 2, "from": "creative-director", "summary": "revised variant 2"},
    {"round": 2, "from": "compliance", "summary": "all approved"}
  ]
}

${liveContext}

RULES:
- The image and video prompts must visually match the winning copy variant's mood and message
- Every copy variant must be different in hookStyle — don't write 3 variations of the same hook
- Do NOT pick the winning variant before the compliance review — let the review inform the selection
- If a variant gets flagged and can't be fixed, replace it entirely
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
