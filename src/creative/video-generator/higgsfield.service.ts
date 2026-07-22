import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { S3Service } from '../../common/storage/s3.service';

const execFileAsync = promisify(execFile);

const WAIT_TIMEOUT_FLAG = '30m';
const WAIT_EXEC_TIMEOUT_MS = 32 * 60 * 1000;
const CLI_CALL_TIMEOUT_MS = 30_000;
const SUBMIT_EXEC_TIMEOUT_MS = 60_000;
const FFMPEG_EXEC_TIMEOUT_MS = 5 * 60 * 1000; // merging a handful of short scene clips, 5min is generous

/**
 * Only these models have a confirmed-working minimum scene duration,
 * verified via live `generate cost` dry-runs + one real generation this
 * session. Higgsfield's model schema (`getModel()`) never exposes numeric
 * min/max for duration, only enums when the model happens to restrict to
 * specific values — so this can't be derived programmatically. Don't add a
 * model here without verifying its actual floor with a real dry-run/call.
 */
export const VERIFIED_SCENE_MODEL_FLOORS: Record<string, number> = {
  seedance_2_0: 4,
  seedance_2_0_mini: 4,
};

export interface HiggsfieldModelSummary {
  display_name: string;
  job_type: string;
  type: string;
}

export interface HiggsfieldModelParam {
  name: string;
  type: string;
  default: unknown;
  required: boolean;
  enum?: string[];
}

export interface HiggsfieldModelSpec {
  display_name: string;
  job_type: string;
  type: string;
  params: HiggsfieldModelParam[];
  rules?: Array<{ cel: string; message: string }>;
}

export interface HiggsfieldVideoResult {
  videoUrl: string;
  thumbnailUrl: string;
}

/**
 * Wraps the `higgsfield` CLI (@higgsfield/cli) — there's no public REST API
 * to call directly, only this CLI and an OAuth-gated MCP server. Auth is
 * file-based (~/.config/higgsfield/credentials.json + config.json, written
 * once by `higgsfield auth login`) — no headless/API-key login, so
 * production needs that credentials file deployed to the server rather than
 * a repeat browser login there.
 *
 * Deliberately generic across Higgsfield's whole model catalog (Seedance,
 * Kling, Veo, Wan, Hailuo, ...) rather than hardcoded to one model — each
 * model has a different accepted-params shape (`getModel` returns the real
 * schema), so the caller picks a job_type and passes whatever params that
 * model's schema exposes.
 */
@Injectable()
export class HiggsfieldService {
  private readonly logger = new Logger(HiggsfieldService.name);

  constructor(private readonly s3Service: S3Service) {}

  /**
   * Splits a total requested duration into N scenes at the given model's
   * verified minimum chunk size — the smallest (cheapest) viable duration per
   * scene, with the last scene absorbing any remainder (guaranteed >= floor,
   * since remainder is always < floor by construction). Throws if jobType
   * isn't in the verified allowlist.
   */
  planSceneDurations(totalDurationSeconds: number, jobType: string): number[] {
    const floor = VERIFIED_SCENE_MODEL_FLOORS[jobType];
    if (!floor) {
      throw new Error(
        `"${jobType}" has no verified scene-duration floor — only ${Object.keys(VERIFIED_SCENE_MODEL_FLOORS).join(', ')} are supported for scene-chunk generation.`,
      );
    }
    if (totalDurationSeconds <= floor) return [floor];
    const n = Math.floor(totalDurationSeconds / floor);
    const durations = new Array(n - 1).fill(floor);
    durations.push(totalDurationSeconds - floor * (n - 1));
    return durations;
  }

  /**
   * Downloads each scene clip (in order), concatenates via ffmpeg — re-encode
   * (not stream-copy), since these are independently-rendered third-party
   * clips and byte-identical codec params across them isn't a safe
   * assumption — and uploads the merged result to S3.
   */
  async mergeVideos(videoUrls: string[], tenantId: string): Promise<{ videoUrl: string }> {
    const tempDir = path.join(os.tmpdir(), `higgsfield-merge-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    try {
      const clipPaths: string[] = [];
      for (let i = 0; i < videoUrls.length; i++) {
        const clipPath = path.join(tempDir, `clip-${i}.mp4`);
        const response = await axios.get(videoUrls[i], { responseType: 'arraybuffer', timeout: 120000 });
        await fs.writeFile(clipPath, Buffer.from(response.data));
        clipPaths.push(clipPath);
      }

      const listPath = path.join(tempDir, 'list.txt');
      const listContent = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await fs.writeFile(listPath, listContent);

      const outputPath = path.join(tempDir, 'merged.mp4');
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-c:a', 'aac', outputPath,
      ], { timeout: FFMPEG_EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

      const mergedBuffer = await fs.readFile(outputPath);
      const key = `${tenantId}/videos/merged-${Date.now()}.mp4`;
      const videoUrl = await this.s3Service.uploadBuffer(mergedBuffer, key, 'video/mp4');
      this.logger.log(`Higgsfield scenes merged: tenantId=${tenantId} scenes=${videoUrls.length} url=${videoUrl}`);
      return { videoUrl };
    } catch (err: any) {
      const detail = err.stderr?.trim?.() || err.message;
      throw new Error(`Scene merge failed: ${detail}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Downloads a video and adds the given narration buffer as a COPY,
   * uploaded under a new S3 key — never overwrites the source video. Video
   * stream is always copied untouched.
   *
   * `keepBackgroundAudio` controls what happens to the source video's own
   * audio track (Seedance/Higgsfield clips render with generated ambient
   * sound, not silence):
   * - true (default): duck the original track to `backgroundVolume` and mix
   *   it under the narration (ffmpeg `amix`), so ambience/foley survives.
   * - false: discard the original audio entirely, narration only.
   *
   * Either way, output length matches whichever of video/narration is
   * shorter (`-shortest`/`duration=first` against the video's own audio
   * length) — the narration script should be written to roughly match the
   * video's actual duration ahead of time rather than relying on this to
   * pad/trim gracefully.
   */
  async addVoiceover(
    videoUrl: string,
    narration: Buffer,
    tenantId: string,
    options: { keepBackgroundAudio?: boolean; backgroundVolume?: number } = {},
  ): Promise<{ videoUrl: string }> {
    const keepBackgroundAudio = options.keepBackgroundAudio ?? true;
    const backgroundVolume = options.backgroundVolume ?? 0.25;
    const tempDir = path.join(os.tmpdir(), `higgsfield-voiceover-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    try {
      const videoPath = path.join(tempDir, 'source.mp4');
      const response = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      await fs.writeFile(videoPath, Buffer.from(response.data));

      const audioPath = path.join(tempDir, 'narration.wav');
      await fs.writeFile(audioPath, narration);

      const outputPath = path.join(tempDir, 'with-voiceover.mp4');
      const args = keepBackgroundAudio
        ? [
            '-y', '-i', videoPath, '-i', audioPath,
            '-filter_complex', `[0:a]volume=${backgroundVolume}[bg];[bg][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
            '-map', '0:v', '-map', '[aout]',
            '-c:v', 'copy', '-c:a', 'aac',
            '-shortest', outputPath,
          ]
        : [
            '-y', '-i', videoPath, '-i', audioPath,
            '-map', '0:v', '-map', '1:a',
            '-c:v', 'copy', '-c:a', 'aac',
            '-shortest', outputPath,
          ];
      await execFileAsync('ffmpeg', args, { timeout: FFMPEG_EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

      const outputBuffer = await fs.readFile(outputPath);
      const key = `${tenantId}/videos/voiceover-${Date.now()}.mp4`;
      const finalUrl = await this.s3Service.uploadBuffer(outputBuffer, key, 'video/mp4');
      this.logger.log(`Voiceover added: tenantId=${tenantId} keepBackgroundAudio=${keepBackgroundAudio} url=${finalUrl}`);
      return { videoUrl: finalUrl };
    } catch (err: any) {
      const detail = err.stderr?.trim?.() || err.message;
      throw new Error(`Adding voiceover failed: ${detail}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async listVideoModels(): Promise<HiggsfieldModelSummary[]> {
    return this.runCli(['model', 'list', '--video', '--json'], CLI_CALL_TIMEOUT_MS);
  }

  async getModel(jobType: string): Promise<HiggsfieldModelSpec> {
    return this.runCli(['model', 'get', jobType, '--json'], CLI_CALL_TIMEOUT_MS);
  }

  /** Dry-run credit estimate — does not create a job. */
  async estimateCost(jobType: string, params: Record<string, unknown>): Promise<number> {
    const result = await this.runCli(
      ['generate', 'cost', jobType, ...this.paramFlags(params), '--json'],
      CLI_CALL_TIMEOUT_MS,
    );
    return result?.credits;
  }

  /**
   * onJobIdReady: called immediately once Higgsfield assigns a job id (before
   * rendering finishes) — same resume-safety pattern as Heygen's videoId:
   * persist it so polling can resume if this call times out.
   */
  async generateVideo(
    jobType: string,
    params: Record<string, unknown>,
    onJobIdReady?: (jobId: string) => Promise<void>,
  ): Promise<HiggsfieldVideoResult> {
    const jobId = await this.submitJob(jobType, params);
    this.logger.log(`Higgsfield job submitted: jobType=${jobType} jobId=${jobId}`);

    if (onJobIdReady) await onJobIdReady(jobId);

    return this.waitForJob(jobId);
  }

  /** Resume polling a job already submitted (jobId known) — call timed out but rendering continues server-side. */
  async resumeFromJobId(jobId: string): Promise<HiggsfieldVideoResult> {
    this.logger.log(`Resuming Higgsfield poll: jobId=${jobId}`);
    return this.waitForJob(jobId);
  }

  private async submitJob(jobType: string, params: Record<string, unknown>): Promise<string> {
    const job = await this.runCli(
      ['generate', 'create', jobType, ...this.paramFlags(params), '--json'],
      SUBMIT_EXEC_TIMEOUT_MS,
    );
    // `generate create --json` returns a bare array of job ids (e.g.
    // '["81ef9893-..."]'), not an { id } object like `generate get`/`list` do —
    // confirmed against a real submission. Handle both shapes defensively
    // rather than assume, since this wasn't verifiable without a live call.
    const id = Array.isArray(job) ? job[0] : job?.id;
    if (!id) {
      throw new Error(`Higgsfield submit failed — no job id in response: ${JSON.stringify(job).slice(0, 300)}`);
    }
    return id;
  }

  private async waitForJob(jobId: string): Promise<HiggsfieldVideoResult> {
    const job = await this.runCli(
      ['generate', 'wait', jobId, '--timeout', WAIT_TIMEOUT_FLAG, '--quiet', '--json'],
      WAIT_EXEC_TIMEOUT_MS,
    );

    if (job?.status === 'failed') {
      throw new Error(`Higgsfield job failed: jobId=${jobId} | ${JSON.stringify(job).slice(0, 300)}`);
    }
    if (job?.status !== 'completed' || !job?.result_url) {
      throw new Error(`Higgsfield job did not complete: jobId=${jobId} status=${job?.status}`);
    }

    this.logger.log(`Higgsfield video ready: jobId=${jobId}`);
    return { videoUrl: job.result_url, thumbnailUrl: job.min_result_url ?? '' };
  }

  // { aspect_ratio: '9:16', duration: 5 } -> ['--aspect-ratio=9:16', '--duration=5']
  // Skips null/undefined/'' so callers can pass a sparse override object and
  // let everything else fall back to Higgsfield's own model defaults.
  private paramFlags(params: Record<string, unknown>): string[] {
    return Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `--${key.replace(/_/g, '-')}=${value}`);
  }

  private async runCli(args: string[], timeoutMs: number): Promise<any> {
    try {
      const { stdout } = await execFileAsync('higgsfield', args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (err: any) {
      const detail = err.stderr?.trim() || err.message;
      throw new Error(`Higgsfield CLI error: ${detail}`);
    }
  }
}
