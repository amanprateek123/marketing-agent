import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const HEYGEN_API_BASE = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface HeygenScene {
  text: string;          // voiceover / caption text for this scene
  duration: number;      // seconds (3-7 per scene)
}

export interface HeygenVideoRequest {
  title: string;
  scenes: HeygenScene[];
  aspectRatio?: '9:16' | '16:9' | '1:1'; // default 9:16
}

@Injectable()
export class HeygenService {
  private readonly logger = new Logger(HeygenService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Generate a video from scenes via Heygen text-to-video API.
   * Polls until complete and returns the video URL.
   */
  async generateVideo(request: HeygenVideoRequest): Promise<string> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    // Step 1: Submit job
    const videoId = await this.submitJob(apiKey, request);
    this.logger.log(`Heygen job submitted: videoId=${videoId}`);

    // Step 2: Poll until complete
    const videoUrl = await this.pollUntilComplete(apiKey, videoId);
    this.logger.log(`Heygen video ready: videoId=${videoId} url=${videoUrl}`);

    return videoUrl;
  }

  private async submitJob(apiKey: string, request: HeygenVideoRequest): Promise<string> {
    const body = {
      video_inputs: request.scenes.map((scene, i) => ({
        character: null,
        voice: null,
        background: { type: 'color', value: '#000000' },
        caption: {
          text: scene.text,
          style: 'default',
        },
        duration: scene.duration,
      })),
      aspect_ratio: request.aspectRatio ?? '9:16',
      title: request.title,
    };

    const response = await axios.post(
      `${HEYGEN_API_BASE}/v2/video/generate`,
      body,
      {
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
    );

    const videoId = response.data?.data?.video_id;
    if (!videoId) {
      throw new Error(`Heygen submit failed: ${JSON.stringify(response.data).slice(0, 300)}`);
    }

    return videoId;
  }

  private async pollUntilComplete(apiKey: string, videoId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);

      // V1 status endpoint is correct — Heygen V2 generate uses V1 for status checks
      const response = await axios.get(
        `${HEYGEN_API_BASE}/v1/video_status.get`,
        {
          params: { video_id: videoId },
          headers: { 'X-Api-Key': apiKey },
          timeout: 15000,
        },
      );

      const data = response.data?.data;
      const status = data?.status;

      if (status === 'completed') {
        const url = data?.video_url;
        if (!url) throw new Error(`Heygen completed but no video_url for ${videoId}`);
        return url;
      }

      if (status === 'failed') {
        throw new Error(`Heygen video generation failed: ${data?.error ?? 'unknown error'}`);
      }

      this.logger.log(`Heygen polling: videoId=${videoId} status=${status}`);
    }

    throw new Error(`Heygen video generation timed out after 5 minutes: videoId=${videoId}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
