import { Injectable, Logger } from '@nestjs/common';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { HeygenService } from './heygen.service';

export interface VideoResult {
  videoPrompt: string;
  videoUrl: string;
}

@Injectable()
export class VideoGeneratorService {
  private readonly logger = new Logger(VideoGeneratorService.name);

  constructor(private readonly heygenService: HeygenService) {}

  /**
   * Generate a video from a Heygen-compatible script produced by the Creative Team.
   * The script is a JSON string with { title, scenes: [{ text, duration }] }.
   */
  async generateFromScript(
    videoPrompt: string,
    tenantId: string,
    runId: string,
  ): Promise<VideoResult> {
    this.logger.log(`Video generation starting: tenantId=${tenantId} runId=${runId}`);

    let parsed: { title: string; scenes: { text: string; duration: number }[] };

    try {
      parsed = JSON.parse(videoPrompt);
    } catch {
      throw new Error(`Invalid Heygen script — not valid JSON: ${videoPrompt.slice(0, 200)}`);
    }

    if (!parsed.scenes || parsed.scenes.length === 0) {
      throw new Error('Heygen script has no scenes');
    }

    const videoUrl = await this.heygenService.generateVideo({
      title: parsed.title ?? `Ad — ${tenantId}`,
      scenes: parsed.scenes,
      aspectRatio: '9:16',
    });

    this.logger.log(`Video generated: tenantId=${tenantId} url=${videoUrl}`);
    return { videoPrompt, videoUrl };
  }
}
