import { Injectable, Logger } from '@nestjs/common';
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
   * Generate a video from a plain-text Video Agent prompt produced by the Creative Team.
   * Sends directly to Heygen Video Agent API — no parsing or conversion needed.
   */
  async generateFromScript(
    videoPrompt: string,
    tenantId: string,
    runId: string,
  ): Promise<VideoResult> {
    this.logger.log(`Video generation starting: tenantId=${tenantId} runId=${runId}`);

    if (!videoPrompt?.trim()) {
      throw new Error('Video prompt is empty');
    }

    const videoUrl = await this.heygenService.generateVideo(videoPrompt.trim());

    this.logger.log(`Video generated: tenantId=${tenantId} url=${videoUrl}`);
    return { videoPrompt, videoUrl };
  }
}
