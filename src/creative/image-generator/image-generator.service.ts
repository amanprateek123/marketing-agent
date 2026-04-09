import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import axios from 'axios';

export interface ImageResult {
  imagePrompt: string;
  imageUrl: string;  // base64 data URL for now (S3 deferred)
}

@Injectable()
export class ImageGeneratorService {
  private readonly logger = new Logger(ImageGeneratorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly configService: ConfigService,
  ) {}

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
Write a detailed image generation prompt for an Indian social media ad creative.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key message: ${brief.keyMessage}
Brand guidelines: ${company.brandGuidelines ?? 'Not specified'}

Rules:
- Vertical format (9:16) for Instagram/Reels
- Photorealistic or cinematic style
- Indian aesthetic — faces, locations, cultural cues where relevant
- No text in the image (text will be added as overlay separately)
- Describe lighting, color palette, composition, mood
- 2-3 sentences max

Return ONLY the image prompt, nothing else.
      `.trim(),
      maxTurns: 2,
    });

    const imagePrompt = promptResult.content.trim();
    this.logger.log(`Image prompt generated: tenantId=${company.tenantId} briefTopic=${brief.topic}`);

    // Step 2 — Call Nano Banana (Google Gemini Image API)
    // Always return the prompt even if the API call fails
    let imageUrl = '';
    try {
      imageUrl = await this.callNanoBanana(imagePrompt, company.tenantId);
    } catch (err: any) {
      this.logger.error(`Nano Banana API failed (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  /**
   * Generate image from a pre-reviewed prompt (from Creative Team).
   * Skips Claude prompt generation — goes straight to image API.
   */
  async generateFromPrompt(
    imagePrompt: string,
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    this.logger.log(`Generating image from reviewed prompt: tenantId=${company.tenantId}`);

    let imageUrl = '';
    try {
      imageUrl = await this.callNanoBanana(imagePrompt, company.tenantId);
    } catch (err: any) {
      this.logger.error(`Image API failed (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  private async callNanoBanana(prompt: string, tenantId: string): Promise<string> {
    const apiKey = this.configService.get<string>('google.aiApiKey');

    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY not configured');
    }

    this.logger.log(`Calling Nano Banana API: tenantId=${tenantId}`);

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent`,
      {
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        timeout: 60000,
      },
    );

    const parts = response.data?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart) {
      this.logger.error(`Nano Banana response: ${JSON.stringify(response.data).slice(0, 500)}`);
      throw new Error('No image returned from Nano Banana API');
    }

    // Return as base64 data URL — S3 upload deferred
    const mimeType = imagePart.inlineData.mimeType;
    const base64 = imagePart.inlineData.data;
    const dataUrl = `data:${mimeType};base64,${base64}`;

    this.logger.log(`Image generated successfully: tenantId=${tenantId}`);
    return dataUrl;
  }
}
