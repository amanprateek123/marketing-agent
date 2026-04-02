import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';

export interface VideoResult {
  videoPrompt: string;
  videoUrl: string; // empty until fal.ai key is available
}

@Injectable()
export class VideoGeneratorService {
  private readonly logger = new Logger(VideoGeneratorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
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
      conversionBridge: string;
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<VideoResult> {
    // Generate and store the video prompt — API call deferred until fal.ai key available
    const promptResult = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
Write a cinematic video generation prompt for a short-form social media ad.

BRIEF:
Brand: ${company.name}
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key message: ${brief.keyMessage}
Conversion bridge: ${brief.conversionBridge}

Rules:
- Vertical 9:16 format
- 15-20 seconds duration
- Indian aesthetic and cultural context
- Describe: opening shot, middle scene, closing shot, color grade, mood, camera movement
- No spoken dialogue in prompt — visual storytelling only
- Cinematic, high quality, suitable for paid Instagram/YouTube ads

Return ONLY the video prompt, nothing else. 3-5 sentences.
      `.trim(),
      maxTurns: 2,
    });

    const videoPrompt = promptResult.content.trim();
    this.logger.log(`Video prompt generated (API deferred): tenantId=${company.tenantId} topic=${brief.topic}`);

    return { videoPrompt, videoUrl: '' };
  }
}
