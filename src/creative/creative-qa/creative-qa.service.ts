import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { parseRobustJson } from '../../common/llm/robust-json-parser.util';
import axios from 'axios';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface ImageQaResult {
  pass: boolean;
  issues: string[];
  /** false when QA infrastructure failed (download/agent error) and we passed open. */
  checked: boolean;
}

/** What each hookStyle's rendered image must visually contain. Mirrors the
 *  HOOK → CENTERPIECE table in image-generator — kept as plain expectations
 *  (not prompt fragments) so the QA agent judges the RENDER, not the prompt. */
const CENTERPIECE_EXPECTATIONS: Record<string, string> = {
  pain_point: 'a person in visible distress at a concrete moment (e.g. holding a phone, distant stare) — NOT a calm lifestyle photo',
  bold_claim: 'a split-screen chaos/calm contrast OR one dramatic subject with strong directional light',
  price_shock: 'a rupee price (₹ numerals) rendered large and dominant in the frame',
  social_proof: 'a testimonial-style face (portrait) with a name/city caption and/or star rating',
  curiosity_gap: 'a covered, blurred, or redacted element (blurred chart, hand covering something, withheld word)',
  before_after: 'a two-state split of the SAME person with a visible lighting/mood shift',
  urgency: 'an astrology chart/planetary visual with a date or transit marker — NOT a countdown clock',
  meme_relatable: 'a candid, deliberately un-polished phone-photo style scene of a specific relatable moment',
  meme_punchline: 'a two-beat setup/reaction visual of the same person',
  meme_self_aware: 'a fourth-wall-breaking composition (subject looking at camera / ad-within-ad framing)',
};

/**
 * Post-generation vision QA — the missing half of creative quality control.
 *
 * Everything upstream validates PROMPTS (copy rubric, image-prompt coherence);
 * nothing ever looked at the RENDERED image. Nano Banana fails in ways prompts
 * can't prevent: garbled overlay text (~30% on non-Latin glyphs), anatomical
 * artifacts, wrong centerpiece, accidental watermarks. Those shipped straight
 * to Meta as paid ads.
 *
 * Each generated image gets one Haiku vision pass (the agent Reads the
 * downloaded file — the only image path through the Agent SDK). FAIL-OPEN by
 * design: a QA infrastructure error must not block creative production, so
 * errors return pass=true with checked=false. A genuine FAIL verdict is
 * trusted and the image is dropped (imagePrompt survives for regeneration).
 */
@Injectable()
export class CreativeQaService {
  private readonly logger = new Logger(CreativeQaService.name);

  constructor(private readonly claudeService: ClaudeService) {}

  async verifyImage(input: {
    tenantId: string;
    runId: string;
    imageUrl: string;
    hookStyle?: string;
    /** Overlay text the image was asked to render (hook line / headline). */
    expectedOverlayText?: string;
  }): Promise<ImageQaResult> {
    const tmpFile = path.join(os.tmpdir(), `creative-qa-${randomUUID()}.png`);
    try {
      const res = await axios.get(input.imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
      await fs.writeFile(tmpFile, Buffer.from(res.data));

      const centerpiece = input.hookStyle ? CENTERPIECE_EXPECTATIONS[input.hookStyle] : undefined;
      const checks = [
        `1. TEXT: Any text overlay must be fully legible Latin-script with no garbled, duplicated, or half-rendered glyphs.${input.expectedOverlayText ? ` The overlay should communicate roughly: "${input.expectedOverlayText}" — paraphrase/truncation is fine, gibberish or unrelated text is a FAIL.` : ''}`,
        centerpiece ? `2. CENTERPIECE: The dominant visual must be ${centerpiece}.` : '2. CENTERPIECE: The image must have ONE clear dominant subject (not a cluttered collage).',
        `3. ARTIFACTS: No malformed hands/fingers/eyes/teeth, no warped faces, no watermarks or stock-photo overlays, no half-rendered objects.`,
        `4. AD-READINESS: Looks like a deliberate paid social ad (clear subject, readable at thumbnail size) — not an accidental render.`,
      ].join('\n');

      const result = await this.claudeService.runAgent({
        tenantId: input.tenantId,
        runId: input.runId,
        agentType: AgentType.CREATIVE_QA,
        systemPrompt: 'You are a meticulous ad-creative QA inspector. You judge RENDERED images, not intentions. Be strict on text legibility and anatomy; be lenient on style/taste.',
        liveContext: '',
        userMessage: `Read the image file at ${tmpFile} and inspect it against these checks:
${checks}

Return ONLY this JSON (no markdown):
{"pass": true, "issues": []}
pass=false requires at least one CONCRETE issue string naming what you actually see wrong (e.g. "overlay text reads 'Sade Saati ka uppay kk' — garbled", "left hand has 6 fingers"). Style preferences are NOT issues.`,
        maxTurns: 3,
        allowedTools: ['Read'],
      });

      const parsed: any = parseRobustJson(result.content);
      const pass = parsed.pass === true;
      const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
      if (!pass) {
        this.logger.warn(`Image QA FAIL (${input.hookStyle ?? 'unknown hook'}): ${issues.join(' | ')} — ${input.imageUrl}`);
      }
      return { pass, issues, checked: true };
    } catch (err: any) {
      this.logger.warn(`Image QA unavailable (passing open): ${err.message}`);
      return { pass: true, issues: [], checked: false };
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  }
}
