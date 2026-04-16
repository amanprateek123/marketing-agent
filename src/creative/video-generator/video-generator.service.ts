import { Injectable, Logger } from '@nestjs/common';
import { HeygenService } from './heygen.service';
import { S3Service } from '../../common/storage/s3.service';

export interface VideoResult {
  videoPrompt: string;
  videoUrl: string;
  videoThumbnailUrl: string;
}

@Injectable()
export class VideoGeneratorService {
  private readonly logger = new Logger(VideoGeneratorService.name);

  constructor(
    private readonly heygenService: HeygenService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Generate a video from a plain-text Video Agent prompt produced by the Creative Team.
   * Sends directly to Heygen Video Agent API — no parsing or conversion needed.
   * Video is uploaded to S3 for a permanent URL (Heygen URLs expire).
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

    const { videoUrl: heygenUrl, thumbnailUrl } = await this.heygenService.generateVideo(videoPrompt.trim());
    this.logger.log(`Heygen video ready — uploading to S3: tenantId=${tenantId}`);

    // Upload to S3 for a permanent URL — Heygen URLs expire
    const key = `${tenantId}/videos/${runId}-${Date.now()}.mp4`;
    const videoUrl = await this.s3Service.uploadFromUrl(heygenUrl, key, 'video/mp4');

    this.logger.log(`Video uploaded to S3: tenantId=${tenantId} url=${videoUrl}`);
    return { videoPrompt, videoUrl, videoThumbnailUrl: thumbnailUrl };
  }
}
