import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

const HEYGEN_API_BASE = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 10000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class HeygenService {
  private readonly logger = new Logger(HeygenService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Generate a video from a text prompt via Heygen V3 Video Agent API.
   * Flow: POST /v3/video-agents → session_id → poll session for video_id → poll video for url
   */
  async generateVideo(prompt: string): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    const sessionId = await this.submitJob(apiKey, prompt);
    this.logger.log(`Heygen session created: sessionId=${sessionId}`);

    const videoId = await this.pollSessionForVideoId(apiKey, sessionId);
    this.logger.log(`Heygen rendering started: sessionId=${sessionId} videoId=${videoId}`);

    const result = await this.pollVideoForUrl(apiKey, videoId);
    this.logger.log(`Heygen video ready: videoId=${videoId} url=${result.videoUrl}`);

    return result;
  }

  private async submitJob(apiKey: string, prompt: string): Promise<string> {
    this.logger.log(`Heygen submitting prompt (${prompt.length} chars)`);

    try {
      const response = await axios.post(
        `${HEYGEN_API_BASE}/v3/video-agents`,
        { prompt, orientation: 'portrait' },
        {
          headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const sessionId = response.data?.data?.session_id;
      if (!sessionId) {
        throw new Error(`Heygen submit failed — no session_id: ${JSON.stringify(response.data).slice(0, 300)}`);
      }

      return sessionId;
    } catch (err: any) {
      if (err instanceof AxiosError && err.response) {
        const detail = JSON.stringify(err.response.data).slice(0, 500);
        throw new Error(`Heygen API error ${err.response.status}: ${detail}`);
      }
      throw err;
    }
  }

  // Step 2: poll session until video_id is assigned (agent thinking → generating)
  private async pollSessionForVideoId(apiKey: string, sessionId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);

      const response = await axios.get(
        `${HEYGEN_API_BASE}/v3/video-agents/${sessionId}`,
        {
          headers: { 'X-Api-Key': apiKey },
          timeout: 15000,
        },
      );

      const data = response.data?.data;
      const status = data?.status;

      if (status === 'failed') {
        const raw = JSON.stringify(response.data).slice(0, 500);
        throw new Error(`Heygen session failed: ${data?.failure_message ?? 'unknown'} | raw=${raw}`);
      }

      if (data?.video_id) {
        return data.video_id;
      }

      this.logger.log(`Heygen session polling: sessionId=${sessionId} status=${status}`);
    }

    throw new Error(`Heygen session timed out waiting for video_id: sessionId=${sessionId}`);
  }

  // Step 3: poll video until completed
  private async pollVideoForUrl(apiKey: string, videoId: string): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);

      const response = await axios.get(
        `${HEYGEN_API_BASE}/v3/videos/${videoId}`,
        {
          headers: { 'X-Api-Key': apiKey },
          timeout: 15000,
        },
      );

      const data = response.data?.data;
      const status = data?.status;

      if (status === 'completed') {
        const videoUrl = data?.video_url;
        if (!videoUrl) throw new Error(`Heygen completed but no video_url for videoId=${videoId}`);
        return { videoUrl, thumbnailUrl: data?.thumbnail_url ?? '' };
      }

      if (status === 'failed') {
        const raw = JSON.stringify(response.data).slice(0, 500);
        throw new Error(`Heygen video failed: ${data?.failure_message ?? data?.failure_code ?? 'unknown'} | raw=${raw}`);
      }

      this.logger.log(`Heygen video polling: videoId=${videoId} status=${status}`);
    }

    throw new Error(`Heygen timed out after 30 minutes: videoId=${videoId}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
