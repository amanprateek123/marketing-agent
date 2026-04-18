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
   * Generate a video from a rich Heygen Video Agent prompt.
   * The prompt describes the full video — text overlays, background, music, timing.
   * Heygen's AI renders it as a text-overlay + music conversion ad.
   *
   * onVideoIdReady: persists videoId immediately so polling can resume on timeout.
   */
  async generateFromScript(
    videoPrompt: string,
    tenantId: string,
    runId: string,
    onVideoIdReady?: (videoId: string) => Promise<void>,
  ): Promise<VideoResult> {
    this.logger.log(`Video generation starting: tenantId=${tenantId} runId=${runId}`);

    if (!videoPrompt?.trim()) {
      throw new Error('Video prompt is empty');
    }

    const { videoUrl: heygenUrl, thumbnailUrl } = await this.heygenService.generateVideoFromPrompt(
      videoPrompt.trim(),
      onVideoIdReady,
    );

    return this.uploadToS3(videoPrompt, heygenUrl, thumbnailUrl, tenantId, runId);
  }

  /**
   * Resume polling for a video already submitted to Heygen.
   * Use when a previous generateFromScript call timed out but videoId was persisted.
   */
  async resumeFromVideoId(
    videoId: string,
    videoPrompt: string,
    tenantId: string,
    runId: string,
  ): Promise<VideoResult> {
    this.logger.log(`Resuming Heygen poll: videoId=${videoId} tenantId=${tenantId}`);
    const { videoUrl: heygenUrl, thumbnailUrl } = await this.heygenService.resumePolling(videoId);
    return this.uploadToS3(videoPrompt, heygenUrl, thumbnailUrl, tenantId, runId);
  }

  private async uploadToS3(
    videoPrompt: string,
    heygenUrl: string,
    thumbnailUrl: string,
    tenantId: string,
    runId: string,
  ): Promise<VideoResult> {
    this.logger.log(`Heygen video ready — uploading to S3: tenantId=${tenantId}`);
    const key = `${tenantId}/videos/${runId}-${Date.now()}.mp4`;
    const videoUrl = await this.s3Service.uploadFromUrl(heygenUrl, key, 'video/mp4');
    this.logger.log(`Video uploaded to S3: tenantId=${tenantId} url=${videoUrl}`);
    return { videoPrompt, videoUrl, videoThumbnailUrl: thumbnailUrl };
  }
}
