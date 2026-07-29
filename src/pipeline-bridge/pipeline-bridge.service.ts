import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { StartRunDto } from './dto/start-run.dto';

/**
 * HTTP client for the external creative pipeline.
 *
 * The pipeline is a separate service on a separate box. It owns the whole
 * creative lifecycle — authoring, layout, generation, resize — and this repo
 * deliberately knows none of it: no schemas, no queues, no image models, just
 * an HTTP call. Everything below is transport.
 *
 * Finished creatives do NOT come back through here. The pipeline pushes them
 * into our own `POST /creative/:tenantId/packages/upload-bulk` when a run
 * completes, so they arrive as ordinary CreativePackages and show up on
 * /creatives, in the Gallery, and in campaign launch with no special-casing.
 * This service is only the outbound half: start a run, then poll it.
 */
@Injectable()
export class PipelineBridgeService {
  private readonly logger = new Logger(PipelineBridgeService.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('pipeline.url') ?? ''
    ).replace(/\/+$/, '');
    this.token = this.config.get<string>('pipeline.token') ?? '';
    this.http = axios.create({
      timeout: this.config.get<number>('pipeline.timeoutMs') ?? 30000,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'The creative pipeline is not configured (set PIPELINE_API_URL).',
      );
    }
  }

  private headers(): Record<string, string> {
    return this.token
      ? { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  /**
   * Forward one call and translate failures.
   *
   * The pipeline's own 4xx bodies (`{ error }`) are meaningful to the operator
   * — "language is required for polished astro creatives", "at capacity, retry
   * shortly" — so they are re-thrown with their original status rather than
   * flattened into a generic 502. Only transport failures become 502.
   */
  private async forward<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.assertConfigured();
    try {
      const res = await this.http.request<T>({
        method,
        url: `${this.baseUrl}${path}`,
        headers: this.headers(),
        data: body,
      });
      return res.data;
    } catch (err) {
      const axiosErr = err as AxiosError<{ error?: string }>;
      const status = axiosErr.response?.status;
      const message =
        axiosErr.response?.data?.error ?? axiosErr.message ?? 'pipeline error';
      if (status && status >= 400 && status < 500) {
        throw new HttpException(message, status);
      }
      this.logger.error(`pipeline ${method.toUpperCase()} ${path} failed: ${message}`);
      throw new BadGatewayException(`Could not reach the creative pipeline: ${message}`);
    }
  }

  /** GET /v1/options — the option contract the Custom-brief form renders from. */
  async getOptions(): Promise<unknown> {
    return this.forward('get', '/v1/options');
  }

  /**
   * POST /v1/runs — start a run.
   *
   * `tenantId` is passed through so the pipeline can scope its push-back to the
   * right tenant when the run finishes. It is not used for authorization there;
   * this API's own JWT guard already did that.
   */
  async startRun(tenantId: string, dto: StartRunDto): Promise<unknown> {
    const result = await this.forward('post', '/v1/runs', {
      ...dto,
      tenant_id: tenantId,
    });
    this.logger.log(
      `started pipeline ${dto.method} run for ${tenantId}: ${JSON.stringify(result)}`,
    );
    return result;
  }

  /** GET /v1/runs/:runId — status, per-child progress, and artifact URLs. */
  async getRun(runId: string): Promise<unknown> {
    return this.forward('get', `/v1/runs/${encodeURIComponent(runId)}`);
  }

  /**
   * GET /v1/runs/:runId/events — the progress stream, cursor-paged.
   *
   * Covers the run AND its batch children: a batch parent stops narrating once
   * authoring finishes, so polling only the parent would show the run freeze.
   */
  async getEvents(runId: string, after: number): Promise<unknown> {
    const cursor = Number.isFinite(after) && after > 0 ? after : 0;
    return this.forward(
      'get',
      `/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`,
    );
  }

  /** GET /health — surfaced so the UI can say "pipeline offline" instead of just failing. */
  async health(): Promise<unknown> {
    return this.forward('get', '/health');
  }
}
