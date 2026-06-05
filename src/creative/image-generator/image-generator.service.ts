import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { S3Service } from '../../common/storage/s3.service';
import { resolveVertical } from '../../common/benchmarks/vertical-benchmarks';
import {
  resolveTargetLanguage,
  getScriptForLanguage,
  CanonicalLanguage,
} from '../../common/creative/language-utils';

export interface ImageResult {
  imagePrompt: string;
  imageUrl: string;  // permanent S3 URL
}

@Injectable()
export class ImageGeneratorService {
  private readonly logger = new Logger(ImageGeneratorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Generate an image for a specific copy variant.
   * Uses the variant's hook/headline to create a visually matched image prompt.
   */
  async generateForVariant(
    brief: {
      topic: string;
      angle: string;
      platform: string;
      format: string;
      audience: string;
      targetLanguage?: CanonicalLanguage;
    },
    copyVariant: { primaryText: string; headline: string; cta: string; hookStyle: string },
    variantIndex: number,
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    const hookText = copyVariant.primaryText?.split('\n')[0] ?? '';
    const headline = copyVariant.headline ?? '';
    const activeProduct = (company.products ?? []).find(p => p.active);
    const targetLanguage: CanonicalLanguage = brief.targetLanguage
      ?? resolveTargetLanguage({ productLanguages: activeProduct?.languages });

    const promptResult = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company, (brief as any)?.product),
      userMessage: this.buildImagePromptUserMessage({
        company,
        brief,
        hookStyle: copyVariant.hookStyle,
        hookText,
        headline,
        cta: copyVariant.cta,
        targetLanguage,
      }),
      maxTurns: 2,
    });

    const imagePrompt = promptResult.content.trim();
    this.logger.log(`Image prompt generated for variant ${variantIndex}: tenantId=${company.tenantId}`);

    let imageUrl = '';
    try {
      imageUrl = await this.generateAndUpload(imagePrompt, company.tenantId, runId);
    } catch (err: any) {
      this.logger.error(`Image generation failed for variant ${variantIndex} (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  async generate(
    brief: {
      topic: string;
      angle: string;
      platform: string;
      format: string;
      audience: string;
      hook: string;
      keyMessage: string;
      targetLanguage?: CanonicalLanguage;
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    const activeProduct = (company.products ?? []).find(p => p.active);
    const targetLanguage: CanonicalLanguage = brief.targetLanguage
      ?? resolveTargetLanguage({ productLanguages: activeProduct?.languages });

    // Step 1 — Claude writes the image prompt
    const promptResult = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company, (brief as any)?.product),
      userMessage: this.buildImagePromptUserMessage({
        company,
        brief,
        hookStyle: undefined,
        hookText: brief.hook,
        headline: brief.keyMessage,
        cta: '',
        targetLanguage,
      }),
      maxTurns: 2,
    });

    const imagePrompt = promptResult.content.trim();
    this.logger.log(`Image prompt generated: tenantId=${company.tenantId} briefTopic=${brief.topic}`);

    // Step 2 — Generate image via Nano Banana + upload to S3
    let imageUrl = '';
    try {
      imageUrl = await this.generateAndUpload(imagePrompt, company.tenantId, runId);
    } catch (err: any) {
      this.logger.error(`Image generation failed (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  /**
   * Generate image from a pre-reviewed prompt (from Creative Team).
   * Skips Claude prompt generation — goes straight to Nano Banana + S3.
   */
  async generateFromPrompt(
    imagePrompt: string,
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    this.logger.log(`Generating image from reviewed prompt: tenantId=${company.tenantId}`);

    let imageUrl = '';
    try {
      imageUrl = await this.generateAndUpload(imagePrompt, company.tenantId, runId);
    } catch (err: any) {
      this.logger.error(`Image generation failed (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  /**
   * Build the user message that asks Claude to write a Nano-Banana-ready image
   * prompt. Two callers (per-variant + legacy single) share this so the centerpiece
   * mapping, face spec, and AVOID list stay in lockstep.
   *
   * Why each block exists:
   *   - centerpiece mapping covers all 7 DR hooks (was 3) so the LLM doesn't improvise
   *     half the time; matches HOOK_STYLES_DR.
   *   - Indian face spec is required because Nano Banana defaults to Pinterest-Indian
   *     (light skin, anglicized features) — explicit demographics force genuine output.
   *   - AVOID list is failure-mode specific (extra fingers, garbled Devanagari,
   *     Western yoga aesthetic) — generic art-school negatives don't bind.
   *   - Sentence budget raised to 8-10 (was 5-6) so all the above can be packed
   *     into the prompt without truncation.
   *   - Composition rule (subject 50% / symbol 25% / product 15% / text ≤10%)
   *     replaces "60% single element" which produced poster aesthetics.
   */
  private buildImagePromptUserMessage(args: {
    company: CompanyDocument;
    brief: { topic: string; angle: string; platform: string; format: string; audience: string };
    hookStyle: string | undefined;
    hookText: string;
    headline: string;
    cta: string;
    targetLanguage: CanonicalLanguage;
  }): string {
    const { company, brief, hookStyle, hookText, headline, cta, targetLanguage } = args;
    const vertical = resolveVertical(company.industry);
    const isSpiritual = vertical === 'spirituality';
    // Image overlays use Manglish/Tanglish/Hinglish convention: target-language
    // vocabulary rendered in Latin script. Nano Banana's non-Latin reliability
    // is ~30%; Latin script is 99%+. Latin-script regional vocabulary is the
    // natural register for digital Indian audiences anyway.
    const targetScript = getScriptForLanguage(targetLanguage, { forImageOverlay: true });
    const isManglishConvention = targetLanguage !== 'english' && targetLanguage !== 'hinglish';

    const centerpieceTable = `
HOOK → CENTERPIECE (use the row matching the selected hookStyle):
  pain_point     → person mid-distress: phone in hand, distant stare, scattered papers — emotional reality, not just "fear visualized"
  bold_claim     → split-screen "chaos / calm" OR a single dramatic subject framed by light rays + the claim text
  price_shock    → ₹${'<price>'} in massive bold numerals, optional strikethrough on a higher anchor; product visible beside it
  social_proof   → testimonial face (3/4 portrait) + name+city caption + 5-star row — NOT just a number floating
  curiosity_gap  → covered/redacted element: blurred kundli chart, hand covering face, withheld word in headline
  before_after   → literal vertical split: same person, identical pose, lighting shifts (dim → golden); time-gap label between
  urgency        → planetary transit visual (chart wheel with planet glyph + date) — NEVER a generic countdown clock
${isSpiritual ? '  (spirituality bonus: use astrology-specific iconography — Shani for Sade Sati, Lakshmi for wealth, Hanuman for protection — never generic "spiritual" Western aesthetic)' : ''}
`.trim();

    const facialSpec = isSpiritual
      ? `Indian person — South Asian features, 32-48 yrs, wheat-to-brown skin tone (NOT light/Pinterest-Indian), natural skin with visible pores, traditional dress (saree/salwar/kurta — visible sindoor or bindi optional), tier-2/3 home or temple-courtyard setting (NOT luxury apartment).`
      : `Indian person — South Asian features, real skin tones (wheat to dark, never light/anglicized), age-appropriate to the audience, real Indian setting (NOT generic "Asian" or NRI metro).`;

    // Manglish convention for image overlays: target-language VOCABULARY in
    // LATIN SCRIPT for native-script Indian languages. Nano Banana fails non-
    // Latin script ~70% of the time; Latin is 99%+. And digital-native Indian
    // audiences read Manglish/Tanglish/Hinglish more naturally than native
    // script on Instagram anyway. Win on both axes.
    const compositionRule = `
COMPOSITION (3-layer rule — not single-element domination):
  Layer 1 (50% of frame): subject from the centerpiece row above
  Layer 2 (25% of frame): one supporting symbol (deity glyph / chart / number / strikethrough / split-line)
  Layer 3 (15% of frame): product visible (book, certificate, phone showing report — anchor what they buy)
  Layer 4 (~10% of frame total): text overlays — TOP "${hookText}" (≤3 words bold ${isManglishConvention ? `Latin-script ${targetLanguage}` : targetLanguage}), BOTTOM "${headline}"${cta ? ` + CTA "${cta}"` : ''} — never exceed 25% of frame on text combined
`.trim();

    const avoidList = `
AVOID (these are concrete Nano-Banana failure modes, not generic art-school negatives):
${isManglishConvention
  ? `  - Native script (${getScriptForLanguage(targetLanguage)}) on the image — Nano Banana renders it as garbled glyphs ~70% of the time. Use Latin-script ${targetLanguage} (Manglish convention) instead.
  - Pure English overlays — signals you don't speak ${targetLanguage}. Vocabulary must be ${targetLanguage}, script must be Latin.`
  : `  - Garbled Devanagari/Tamil/Bengali glyphs — keep all overlays in Latin script for this language target.`}
  - Extra/fused fingers, asymmetric eyes, AI-uncanny hands — explicitly call out "hands hidden or out of frame" if fingers risk appearing
  - Light-skinned/anglicized Indian faces (force wheat-to-brown skin tone — see SUBJECT spec)
  - Cluttered backgrounds that compete with the subject
  - Watermarks, brand logos other than ${company.name}, celebrity faces, fake testimonials
${isSpiritual ? '  - Western "spiritual" aesthetic — NO Buddha statues, mandala patterns, dreamcatchers, crystals, sage smudging, lotus-with-chakra. Indian-astro iconography ONLY.' : ''}
  - Stock-photo lifestyle aesthetic (Pexels/Unsplash look) — feed scrollers ignore these
`.trim();

    return `
Write an image generation prompt for a Meta direct response ad in the ${vertical} vertical, targeted at a **${targetLanguage}**-speaking audience. This image must STOP scrolling and TAP-through within 1 second.

LANGUAGE CONSTRAINT — non-negotiable:
- All on-image text overlays use **${targetLanguage} vocabulary** rendered in **${targetScript}**.
${isManglishConvention
  ? `- IMPORTANT: This is the Manglish/Tanglish/Hinglish convention — ${targetLanguage} WORDS written in Latin/Roman characters (e.g. "Guru Karkat raashit yetoy" not "गुरु कर्क राशीत येतोय"). Image-render reliability >> native-script authenticity on 9:16 mobile ads, AND this is how digital-native Indian audiences actually type on Instagram. Native script causes ~70% garbled-glyph failures and reads as fake to those audiences anyway when rendered wrong.
- The "Hook text" and "Headline" strings below are ALREADY in Latin-script ${targetLanguage}. Pass them through as the exact overlay copy. If they appear to be in native script, transliterate them to Latin before placing on the image.
- DO NOT default to pure English overlays — that signals you don't speak the audience's language. ${targetLanguage} vocabulary, Latin script.`
  : `- The "Hook text" and "Headline" strings below are already in the right language and script. Pass them through to the image prompt as the exact overlay copy.
- Overlays in Latin script — standard render reliability.`}

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
${hookStyle ? `Hook style: ${hookStyle}` : ''}
Hook text (already in ${targetLanguage}): "${hookText}"
Headline (already in ${targetLanguage}): "${headline}"
${cta ? `CTA: "${cta}"` : ''}
Brand guidelines: ${company.brandGuidelines ?? 'Not specified'}

${centerpieceTable}

SUBJECT SPEC (when a person appears in frame):
${facialSpec}

${compositionRule}

${avoidList}

Format: Vertical 9:16. Length: 8-10 sentences — enough to specify centerpiece, all 3 composition layers, text overlays, subject demographics, and 2-3 specific AVOIDs that apply to THIS hookStyle.

Return ONLY the image prompt, nothing else.
    `.trim();
  }

  private async generateAndUpload(prompt: string, tenantId: string, runId: string): Promise<string> {
    const provider = (this.configService.get<string>('imageGen.provider') ?? 'nano_banana').toLowerCase();
    const imageBuffer = provider === 'gpt_image'
      ? await this.callGptImage(prompt, tenantId)
      : await this.callNanoBanana(prompt, tenantId);

    // Upload to S3 — permanent URL
    const key = `${tenantId}/images/${runId}-${Date.now()}.png`;
    const s3Url = await this.uploadBufferToS3(imageBuffer, key);

    this.logger.log(`Image uploaded to S3: tenantId=${tenantId} provider=${provider} url=${s3Url}`);
    return s3Url;
  }

  private async callGptImage(prompt: string, tenantId: string): Promise<Buffer> {
    const apiKey = this.configService.get<string>('openai.apiKey');
    const model = this.configService.get<string>('openai.imageModel') ?? 'gpt-image-2';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    this.logger.log(`Calling OpenAI image API: tenantId=${tenantId} model=${model}`);

    // gpt-image-* expects the same photoreal prefix Nano Banana gets — keeps style parity across providers.
    const styledPrompt = `Photorealistic photograph. Real human faces, real skin textures, natural lighting. NOT illustration, NOT cartoon, NOT animated, NOT 3D render, NOT digital art. Shot on a professional camera.\n\n${prompt}`;

    const maxAttempts = 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/images/generations',
          {
            model,
            prompt: styledPrompt,
            size: '1024x1536', // closest supported 9:16 ratio
            n: 1,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 240000,
          },
        );

        const b64 = response.data?.data?.[0]?.b64_json;
        if (!b64) {
          throw new Error(`No image data in OpenAI response: ${JSON.stringify(response.data).slice(0, 300)}`);
        }

        this.logger.log(`OpenAI image generated: tenantId=${tenantId} attempt=${attempt}`);
        return Buffer.from(b64, 'base64');
      } catch (err) {
        lastError = err;
        const status = (err as any)?.response?.status;
        const code = (err as any)?.code;
        const retriable = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || (typeof status === 'number' && status >= 500);
        if (!retriable || attempt === maxAttempts) throw err;
        this.logger.warn(`OpenAI image attempt ${attempt} failed (code=${code} status=${status}); retrying`);
      }
    }
    throw lastError;
  }

  private async callNanoBanana(prompt: string, tenantId: string): Promise<Buffer> {
    const apiKey = this.configService.get<string>('google.aiApiKey');

    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY not configured');
    }

    this.logger.log(`Calling Nano Banana (Gemini Image): tenantId=${tenantId}`);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-image-preview',
      generationConfig: {
        responseModalities: ['IMAGE'] as any,
        imageConfig: {
          aspectRatio: '9:16',
        } as any,
      } as any,
    });

    // Force photorealistic style — Nano Banana defaults to illustration without this
    const styledPrompt = `Photorealistic photograph. Real human faces, real skin textures, natural lighting. NOT illustration, NOT cartoon, NOT animated, NOT 3D render, NOT digital art. Shot on a professional camera.\n\n${prompt}`;

    const result = await model.generateContent(styledPrompt);
    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts ?? [];

    // Find the image part in the response
    const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart?.inlineData?.data) {
      throw new Error(`No image data in Nano Banana response: ${JSON.stringify(parts.map((p: any) => p.text ?? '[image]')).slice(0, 300)}`);
    }

    this.logger.log(`Nano Banana image generated: tenantId=${tenantId}`);
    return Buffer.from(imagePart.inlineData.data, 'base64');
  }

  private async uploadBufferToS3(buffer: Buffer, key: string): Promise<string> {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

    const region = this.configService.get<string>('aws.region') ?? 'ap-south-1';
    const bucket = this.configService.get<string>('aws.s3Bucket') ?? '';

    const s3 = new S3Client({
      region,
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
      },
    });

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
    }));

    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }
}
