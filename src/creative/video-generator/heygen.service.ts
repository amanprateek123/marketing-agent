import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

const HEYGEN_API_BASE = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class HeygenService {
  private readonly logger = new Logger(HeygenService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Generate a video from a text prompt via Heygen Video Agent API.
   * No avatar or template needed — fastest path from text to video.
   * Endpoint: POST /v1/video_agent/generate
   */
  async generateVideo(prompt: string): Promise<string> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    const videoId = await this.submitJob(apiKey, prompt);
    this.logger.log(`Heygen job submitted: videoId=${videoId}`);

    const videoUrl = await this.pollUntilComplete(apiKey, videoId);
    this.logger.log(`Heygen video ready: videoId=${videoId} url=${videoUrl}`);

    return videoUrl;
  }

  private async submitJob(apiKey: string, prompt: string): Promise<string> {
    this.logger.log(`Heygen submitting prompt (${prompt.length} chars)`);

    try {
      const response = await axios.post(
        `${HEYGEN_API_BASE}/v1/video_agent/generate`,
        { prompt },
        {
          headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const videoId = response.data?.data?.video_id ?? response.data?.video_id;
      if (!videoId) {
        throw new Error(`Heygen submit failed — no video_id: ${JSON.stringify(response.data).slice(0, 300)}`);
      }

      return videoId;
    } catch (err: any) {
      if (err instanceof AxiosError && err.response) {
        const detail = JSON.stringify(err.response.data).slice(0, 500);
        throw new Error(`Heygen API error ${err.response.status}: ${detail}`);
      }
      throw err;
    }
  }

  private async pollUntilComplete(apiKey: string, videoId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);

      const response = await axios.get(
        `${HEYGEN_API_BASE}/v1/video_status.get`,
        {
          params: { video_id: videoId },
          headers: { 'X-API-KEY': apiKey },
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
        throw new Error(`Heygen video failed: ${data?.error ?? 'unknown error'}`);
      }

      this.logger.log(`Heygen polling: videoId=${videoId} status=${status}`);
    }

    throw new Error(`Heygen timed out after 15 minutes: videoId=${videoId}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
