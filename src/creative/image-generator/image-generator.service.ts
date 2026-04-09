import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import axios from 'axios';

export interface ImageResult {
  imagePrompt: string;
  imageUrl: string;  // hosted URL from OpenAI (valid for 1 hour) — S3 upload deferred
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

    // Step 2 — Call OpenAI DALL-E 3
    let imageUrl = '';
    try {
      imageUrl = await this.callDallE(imagePrompt, company.tenantId);
    } catch (err: any) {
      this.logger.error(`OpenAI image API failed (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  /**
   * Generate image from a pre-reviewed prompt (from Creative Team).
   * Skips Claude prompt generation — goes straight to DALL-E 3.
   */
  async generateFromPrompt(
    imagePrompt: string,
    company: CompanyDocument,
    runId: string,
  ): Promise<ImageResult> {
    this.logger.log(`Generating image from reviewed prompt: tenantId=${company.tenantId}`);

    let imageUrl = '';
    try {
      imageUrl = await this.callDallE(imagePrompt, company.tenantId);
    } catch (err: any) {
      this.logger.error(`OpenAI image API failed (prompt saved): ${err.message}`);
    }

    return { imagePrompt, imageUrl };
  }

  private async callDallE(prompt: string, tenantId: string): Promise<string> {
    const apiKey = this.configService.get<string>('openai.apiKey');

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    this.logger.log(`Calling DALL-E 3: tenantId=${tenantId}`);

    // DALL-E 3 max prompt length is 4000 chars — truncate if needed
    const safePrompt = prompt.length > 4000 ? prompt.slice(0, 4000) : prompt;

    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt: safePrompt,
        n: 1,
        size: '1024x1792',   // closest to 9:16 vertical format
        quality: 'standard', // use 'hd' for higher quality (2x cost)
        response_format: 'url',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 60000,
      },
    );

    const imageUrl = response.data?.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error(`No image URL returned from DALL-E 3: ${JSON.stringify(response.data).slice(0, 300)}`);
    }

    this.logger.log(`DALL-E 3 image generated: tenantId=${tenantId}`);
    return imageUrl;
  }
}
