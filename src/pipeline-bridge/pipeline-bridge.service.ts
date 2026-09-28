import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AddOfferingDto } from './dto/add-offering.dto';
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
    this.baseUrl = (this.config.get<string>('pipeline.url') ?? '').replace(
      /\/+$/,
      '',
    );
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
      ? {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        }
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
    method: 'get' | 'post' | 'put',
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
      const axiosErr = err as AxiosError<{ error?: string; message?: string }>;
      const status = axiosErr.response?.status;
      const pipelineSaid =
        axiosErr.response?.data?.error ?? axiosErr.response?.data?.message;
      if (status && status >= 400 && status < 500) {
        throw new HttpException(
          pipelineSaid ?? plainPipelineRefusal(status),
          status,
        );
      }
      const message = pipelineSaid ?? axiosErr.message ?? 'pipeline error';
      this.logger.error(
        `pipeline ${method.toUpperCase()} ${path} failed: ${message}`,
      );
      throw new BadGatewayException(
        `Could not reach the creative pipeline: ${message}`,
      );
    }
  }

  // ─── Creative studio parity (the actions Slack buttons used to be the only door to) ───
  //
  // Each is a straight forward to the creativebot route of the same shape; creativebot reuses the
  // intent/queue function its Slack handler calls. Answers are `{ ok, run_id?, status, message }`.

  private run(runId: string, suffix: string): string {
    return `/v1/runs/${encodeURIComponent(runId)}/${suffix}`;
  }

  /** POST /v1/runs/:id/cancel — stop a run that is queued or in progress. */
  cancelRun(runId: string): Promise<unknown> {
    return this.forward('post', this.run(runId, 'cancel'));
  }

  /** POST /v1/runs/:id/retry — start a failed run again from where it stopped. */
  retryRun(runId: string, step?: 'preview' | 'full'): Promise<unknown> {
    return this.forward(
      'post',
      this.run(runId, 'retry'),
      step ? { step } : undefined,
    );
  }

  /** POST /v1/runs/:id/run-anyway — override a quality-check block. */
  runAnyway(runId: string): Promise<unknown> {
    return this.forward('post', this.run(runId, 'run-anyway'));
  }

  /** POST /v1/runs/:id/model — pick the image model for this run. */
  setModel(runId: string, model: string, quality?: string): Promise<unknown> {
    return this.forward('post', this.run(runId, 'model'), {
      model,
      ...(quality ? { quality } : {}),
    });
  }

  /** POST /v1/runs/:id/approve — Gate A (`preview`) or Gate B (`full`). */
  approveRun(runId: string, stage: 'preview' | 'full'): Promise<unknown> {
    return this.forward('post', this.run(runId, 'approve'), { stage });
  }

  /** POST /v1/runs/:id/campaign-fields — write the ad copy. */
  generateCampaignFields(runId: string): Promise<unknown> {
    return this.forward('post', this.run(runId, 'campaign-fields'));
  }

  /** PUT /v1/runs/:id/campaign-fields — save the operator's edits to the ad copy. */
  editCampaignFields(
    runId: string,
    fields: Record<string, unknown>,
  ): Promise<unknown> {
    return this.forward('put', this.run(runId, 'campaign-fields'), fields);
  }

  /** POST /v1/runs/:id/campaign-fields/approve — the ad copy is good to go. */
  approveCampaignFields(runId: string): Promise<unknown> {
    return this.forward('post', this.run(runId, 'campaign-fields/approve'));
  }

  /** POST /v1/runs/:id/badge — use an uploaded image as the badge. */
  setBadge(runId: string, uploadId: string): Promise<unknown> {
    return this.forward('post', this.run(runId, 'badge'), {
      upload_id: uploadId,
    });
  }

  /** POST /v1/runs/:id/logo — include the logo or leave it off. */
  setLogo(
    runId: string,
    include: boolean,
    disclaimer?: string,
  ): Promise<unknown> {
    return this.forward('post', this.run(runId, 'logo'), {
      include,
      ...(disclaimer ? { disclaimer } : {}),
    });
  }

  /** POST /v1/ideas/:runId/discard — drop the idea behind the RUN showing it (Slack's Delete idea). */
  discardIdea(ideaId: string, reason: string): Promise<unknown> {
    return this.forward(
      'post',
      `/v1/ideas/${encodeURIComponent(ideaId)}/discard`,
      { reason },
    );
  }

  private research(researchId: string, suffix: string): string {
    return `/v1/research/${encodeURIComponent(researchId)}/${suffix}`;
  }

  /** GET /v1/research/:id/sources — the sources research proposes to read. */
  getResearchSources(researchId: string): Promise<unknown> {
    return this.forward('get', this.research(researchId, 'sources'));
  }

  /** POST /v1/research/:id/sources — confirm the sources, or override them with `urls`. */
  confirmResearchSources(
    researchId: string,
    confirm: boolean,
    urls?: string[],
  ): Promise<unknown> {
    return this.forward('post', this.research(researchId, 'sources'), {
      confirm,
      ...(urls?.length ? { urls } : {}),
    });
  }

  /** POST /v1/research/:id/rerun — reuse the earlier research, or run it fresh. */
  rerunResearch(
    researchId: string,
    choice: 'reuse' | 'rerun',
  ): Promise<unknown> {
    return this.forward('post', this.research(researchId, 'rerun'), { choice });
  }

  /** GET /v1/research/:id/directions — the creative directions research came back with. */
  getResearchDirections(researchId: string): Promise<unknown> {
    return this.forward('get', this.research(researchId, 'directions'));
  }

  /** POST /v1/research/:id/directions/:d/build — make creatives from one direction. */
  buildDirection(researchId: string, direction: string): Promise<unknown> {
    return this.forward(
      'post',
      this.research(
        researchId,
        `directions/${encodeURIComponent(direction)}/build`,
      ),
    );
  }

  /** POST /v1/research/:id/directions/:conceptIndex/expand — develop a culled concept (by its `index`; concepts have no db id). */
  expandConcept(researchId: string, conceptIndex: string): Promise<unknown> {
    return this.forward(
      'post',
      this.research(
        researchId,
        `directions/${encodeURIComponent(conceptIndex)}/expand`,
      ),
    );
  }

  /** POST /v1/research/pdf — start research from an uploaded PDF. */
  researchFromPdf(uploadId: string, product: string): Promise<unknown> {
    return this.forward('post', '/v1/research/pdf', {
      upload_id: uploadId,
      product,
    });
  }

  /** GET /v1/learn/proposals — learnings waiting for a Brain decision (the old /learnings flow). */
  getLearnProposals(): Promise<unknown> {
    return this.forward('get', '/v1/learn/proposals');
  }

  /** POST /v1/learn/proposals/:id — approve, reject, or edit-and-approve one proposal. */
  decideLearnProposal(
    proposalId: string,
    body: {
      decision: 'approve' | 'reject' | 'edit';
      text?: string;
      decided_by: string;
    },
  ): Promise<unknown> {
    return this.forward(
      'post',
      `/v1/learn/proposals/${encodeURIComponent(proposalId)}`,
      body,
    );
  }

  /**
   * POST /v1/packages/:packageId/resize — reframe a delivered creative into the other sizes.
   *
   * Addressed by package rather than run because that is what the detail page knows; the pipeline
   * resolves it through the back-reference it records when pushing. A 404 means the package was not
   * produced by the pipeline, which is the honest answer for one the dashboard generated itself.
   */
  async resizePackage(packageId: string): Promise<unknown> {
    return this.forward(
      'post',
      `/v1/packages/${encodeURIComponent(packageId)}/resize`,
    );
  }

  /**
   * GET /v1/packages/:packageId — is this creative the pipeline's, and what is its run?
   *
   * The detail page has to choose which engine its buttons drive before it renders them, and a
   * CreativePackage carries no provenance field. A 404 is a legitimate answer, not an error: it
   * means the dashboard's own generator made this one.
   */
  async getPackage(packageId: string): Promise<unknown> {
    return this.forward('get', `/v1/packages/${encodeURIComponent(packageId)}`);
  }

  /**
   * POST /v1/packages/:packageId/revise — re-author the brief from an instruction, then regenerate.
   *
   * Returns a NEW run id: the pipeline revises a clone so the source creative keeps its own
   * artifacts and buttons, and the result arrives in the library as its own package.
   */
  async revisePackage(
    packageId: string,
    instruction: string,
  ): Promise<unknown> {
    return this.forward(
      'post',
      `/v1/packages/${encodeURIComponent(packageId)}/revise`,
      {
        instruction,
      },
    );
  }

  /**
   * POST /v1/packages/:packageId/regenerate — edit the delivered image in place.
   *
   * Same run, same package, pixels only. A 409 means the pipeline's ChatGPT session is logged out;
   * that is a real recurring state and must be shown, not retried into a silent wait.
   */
  async regeneratePackage(
    packageId: string,
    instruction: string,
    tag?: string,
  ): Promise<unknown> {
    return this.forward(
      'post',
      `/v1/packages/${encodeURIComponent(packageId)}/regenerate`,
      {
        instruction,
        ...(tag ? { tag } : {}),
      },
    );
  }

  /** POST /v1/runs/:runId/clarify — answer a stalled revise so it can continue. */
  async clarifyRun(runId: string, answer: string): Promise<unknown> {
    return this.forward(
      'post',
      `/v1/runs/${encodeURIComponent(runId)}/clarify`,
      { answer },
    );
  }

  /** GET /v1/options — the option contract the Custom-brief form renders from. */
  /** GET /v1/options — the choices the Custom-brief form renders from. */
  async getOptions(): Promise<unknown> {
    return this.forward('get', '/v1/options');
  }

  /**
   * POST /v1/uploads — forward reference image(s) to the pipeline.
   *
   * Not routed through `forward()` because that sets a JSON content type, and a multipart body must
   * carry its own generated boundary. Uses `form-data` (already a transitive dep of axios' Node
   * stack) so the boundary header comes from the form itself rather than being hand-written.
   */
  async uploadImages(
    files: Array<{ originalname: string; buffer: Buffer; mimetype: string }>,
  ): Promise<unknown> {
    this.assertConfigured();
    // `form-data` is CommonJS (`export = FormData`): `module.exports` IS the constructor and there
    // is no `.default` on it. This project compiles with `module: commonjs` and WITHOUT
    // `esModuleInterop`, so TypeScript emits a bare `require()` with no interop wrapper — `.default`
    // was `undefined` at runtime while `allowSyntheticDefaultImports` still let it type-check. Every
    // reference-image upload died on `new FormData()` with "FormData is not a constructor", which
    // Nest reports as a 500; a brief with no images never reaches here, so the break looked
    // user-specific rather than total. Prefer `.default` if a future toolchain adds it, else the
    // module itself.
    const imported = (await import('form-data')) as unknown as {
      default?: typeof import('form-data');
    };
    const FormData =
      imported.default ?? (imported as unknown as typeof import('form-data'));
    const form = new FormData();
    for (const f of files) {
      form.append('files', f.buffer, {
        filename: f.originalname,
        contentType: f.mimetype,
      });
    }
    try {
      const res = await this.http.request({
        method: 'post',
        url: `${this.baseUrl}/v1/uploads`,
        headers: {
          ...form.getHeaders(),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        data: form,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return res.data;
    } catch (err) {
      const axiosErr = err as AxiosError<{ error?: string }>;
      const status = axiosErr.response?.status;
      const message =
        axiosErr.response?.data?.error ?? axiosErr.message ?? 'upload failed';
      if (status && status >= 400 && status < 500) {
        throw new HttpException(message, status);
      }
      this.logger.error(`pipeline POST /v1/uploads failed: ${message}`);
      throw new BadGatewayException(
        `Could not upload to the creative pipeline: ${message}`,
      );
    }
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

  /**
   * POST /v1/offerings — onboard a new product from its landing page.
   *
   * Slow by nature: the pipeline scrapes the page with a headless browser before it answers, so
   * this can take the better part of a minute. Left synchronous anyway — the caller needs the
   * product to exist before it can pick it, and the pipeline's own timeout (`pipeline.timeoutMs`)
   * already bounds the wait.
   *
   * Returns `{ offering, pack_path, gaps, ... }`. `gaps` matters to the UI: a pack can be written
   * and still be thin, and a thin pack is how a product gets advertised on unverified substance.
   */
  async addOffering(tenantId: string, dto: AddOfferingDto): Promise<unknown> {
    const result = await this.forward('post', '/v1/offerings', { ...dto });
    this.logger.log(
      `added pipeline offering for ${tenantId} from ${dto.landing_url}: ${JSON.stringify(result)}`,
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

/**
 * The words shown when the pipeline refused without saying why.
 *
 * FastAPI's own 404 for a route it does not have is `{ detail: "Not Found" }` — no `error` — and
 * axios would otherwise hand the operator "Request failed with status code 404". A 404 here almost
 * always means creativebot has not shipped that action yet, and the dashboard shows it as such.
 */
export function plainPipelineRefusal(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'The creative service could not use what was sent. Check the details and try again.';
    case 401:
    case 403:
      return 'The creative service refused this request.';
    case 404:
      return 'This is not available yet.';
    case 409:
      return 'This cannot be done right now — the run has moved on. Refresh and try again.';
    case 429:
      return 'The creative service is busy. Try again in a minute.';
    default:
      return 'The creative service could not do this. Try again.';
  }
}
