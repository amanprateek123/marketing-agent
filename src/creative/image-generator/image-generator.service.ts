import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { S3Service } from '../../common/storage/s3.service';

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
    },
    copyVariant: { primaryText: string; headline: string; cta: string; hookStyle: string },
    variantIndex: number,
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    const hookText = copyVariant.primaryText?.split('\n')[0] ?? '';
    const headline = copyVariant.headline ?? '';

    const promptResult = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
Write an image generation prompt for a Meta direct response ad. This image must make someone STOP scrolling and TAP the ad.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook style: ${copyVariant.hookStyle}
Hook text: "${hookText}"
Headline: "${headline}"
CTA: "${copyVariant.cta}"
Brand guidelines: ${company.brandGuidelines ?? 'Not specified'}

STEP 1 — VISUAL CENTERPIECE: Read the hook "${hookText}" and topic "${brief.topic}". What is the ONE visual concept that makes THIS variant unique?
- If the hook mentions a date/event → centerpiece is that date (calendar, countdown)
- If the hook mentions a fear → centerpiece is that fear visualized dramatically
- If the hook mentions social proof → centerpiece is the number, large and bold
The centerpiece must DOMINATE the image (60% of the frame).

STEP 2 — BUILD AROUND IT:
- VISUAL CENTERPIECE (largest element): The concept from Step 1, unmissable
- TEXT OVERLAY — TOP: "${hookText}" in bold Hinglish, high contrast, readable at phone size
- TEXT OVERLAY — BOTTOM: "${headline}" + CTA, high contrast
- PRODUCT VISIBLE — show what they're buying
- INDIAN CONTEXT — real Indian faces, settings, skin tones

Format: Vertical 9:16, photorealistic, 5-6 sentences.

AVOID: generic images, muted colors, stock aesthetic, cluttered composition.

Return ONLY the image prompt, nothing else.
      `.trim(),
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
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    // Step 1 — Claude writes the image prompt
    const promptResult = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
Write an image generation prompt for a Meta direct response ad. This image must make someone STOP scrolling and TAP the ad.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key message: ${brief.keyMessage}
Brand guidelines: ${company.brandGuidelines ?? 'Not specified'}

STEP 1 — VISUAL CENTERPIECE: Read the hook "${brief.hook}" and the topic "${brief.topic}". What is the ONE visual concept that makes this ad unique? If the hook mentions a date/event, the centerpiece is that date (calendar, countdown). If it mentions a fear, the centerpiece is that fear visualized dramatically. If it mentions social proof, the centerpiece is the number, large and bold. The centerpiece must DOMINATE the image (60% of the frame) — not be a small detail.

STEP 2 — BUILD AROUND IT:
- VISUAL CENTERPIECE (largest element): The concept from Step 1, unmissable
- TEXT OVERLAY — TOP: "${brief.hook}" in bold Hinglish, high contrast, readable at phone size
- TEXT OVERLAY — BOTTOM: Product name + price, high contrast
- PRODUCT VISIBLE — show what they're buying
- INDIAN CONTEXT — real Indian faces, settings, skin tones

Format: Vertical 9:16, photorealistic, 5-6 sentences.

AVOID: generic images where the main concept is small/hidden, lifestyle photos with no focal point, muted colors, stock aesthetic, cluttered composition.

Return ONLY the image prompt, nothing else.
      `.trim(),
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

  private async generateAndUpload(prompt: string, tenantId: string, runId: string): Promise<string> {
    const imageBuffer = await this.callNanoBanana(prompt, tenantId);

    // Upload to S3 — permanent URL
    const key = `${tenantId}/images/${runId}-${Date.now()}.png`;
    const s3Url = await this.uploadBufferToS3(imageBuffer, key);

    this.logger.log(`Image uploaded to S3: tenantId=${tenantId} url=${s3Url}`);
    return s3Url;
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
