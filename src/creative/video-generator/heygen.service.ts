import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

const HEYGEN_API_BASE = 'https://api.heygen.com';
const POLL_INTERVAL_MS = 10000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface HeygenAvatarConfig {
  avatarId: string;
  voiceId: string;
  backgroundUrl?: string;
}

@Injectable()
export class HeygenService {
  private readonly logger = new Logger(HeygenService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Generate a video via Heygen V3 Video Agent API.
   * Takes a natural language prompt — ideal for text-overlay + music conversion ads.
   *
   * Flow: POST /v3/video-agents → video_id → poll /v1/video_status.get → video_url_caption
   *
   * onVideoIdReady: called immediately after video_id is assigned (before rendering).
   * Persist it so polling can resume if this call times out.
   */
  async generateVideoFromPrompt(
    prompt: string,
    onVideoIdReady?: (videoId: string) => Promise<void>,
  ): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    const videoId = await this.submitVideoAgentJob(apiKey, prompt);
    this.logger.log(`Heygen video agent submitted: videoId=${videoId}`);

    if (onVideoIdReady) await onVideoIdReady(videoId);

    return this.pollForCompletion(apiKey, videoId);
  }

  /**
   * Resume polling a video already rendering (videoId known).
   * Use when a previous call timed out but the videoId was persisted.
   */
  async resumePolling(videoId: string): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    this.logger.log(`Resuming Heygen poll: videoId=${videoId}`);
    return this.pollForCompletion(apiKey, videoId);
  }

  /**
   * List available avatars — discover Indian-looking avatar IDs.
   * Inspect avatar_name and preview_image_url to pick the right one.
   */
  async listAvatars(): Promise<Array<{ avatar_id: string; avatar_name: string; gender: string; preview_image_url: string; tags: string[] }>> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    const response = await axios.get(`${HEYGEN_API_BASE}/v2/avatars`, {
      headers: { 'x-api-key': apiKey },
      timeout: 15000,
    });
    return response.data?.data?.avatars ?? [];
  }

  /**
   * List available voices — filter by language="Hindi" to find Hindi TTS voice IDs.
   */
  async listVoices(language?: string): Promise<Array<{ voice_id: string; language: string; gender: string; name: string; preview_audio: string }>> {
    const apiKey = this.configService.get<string>('heygen.apiKey');
    if (!apiKey) throw new Error('HEYGEN_API_KEY not configured');

    const response = await axios.get(`${HEYGEN_API_BASE}/v2/voices`, {
      headers: { 'x-api-key': apiKey },
      timeout: 15000,
    });
    const voices = response.data?.data?.voices ?? [];
    return language ? voices.filter((v: any) => v.language === language) : voices;
  }

  // POST /v3/video-agents — natural language prompt → video_id
  private async submitVideoAgentJob(apiKey: string, prompt: string): Promise<string> {
    this.logger.log(`Heygen submitting video agent job (prompt: ${prompt.length} chars)`);

    try {
      const response = await axios.post(
        `${HEYGEN_API_BASE}/v3/video-agents`,
        {
          prompt: prompt.trim(),
        },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const videoId = response.data?.data?.video_id ?? response.data?.video_id;
      if (!videoId) {
        throw new Error(`Heygen submit failed — no video_id in response: ${JSON.stringify(response.data).slice(0, 300)}`);
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

  // GET /v1/video_status.get?video_id=<id> — poll until completed
  private async pollForCompletion(
    apiKey: string,
    videoId: string,
  ): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);

      const response = await axios.get(
        `${HEYGEN_API_BASE}/v1/video_status.get`,
        {
          params: { video_id: videoId },
          headers: { 'x-api-key': apiKey },
          timeout: 60000,
        },
      );

      const data = response.data?.data;
      const status = data?.status;

      if (status === 'completed') {
        // Use plain video_url — captions overlap with text overlays already in the video
        const videoUrl = data?.video_url;
        if (!videoUrl) throw new Error(`Heygen completed but no video_url for videoId=${videoId}`);
        this.logger.log(`Heygen video ready: videoId=${videoId}`);
        return { videoUrl, thumbnailUrl: data?.thumbnail_url ?? '' };
      }

      if (status === 'failed') {
        const errMsg = data?.error?.message ?? data?.error ?? 'unknown';
        throw new Error(`Heygen video failed: ${errMsg} | videoId=${videoId}`);
      }

      this.logger.log(`Heygen polling: videoId=${videoId} status=${status}`);
    }

    throw new Error(`Heygen timed out after 30 minutes: videoId=${videoId}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
