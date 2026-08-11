import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { StartRunDto } from './dto/start-run.dto';
import { ClarifyDto, RegenerateDto, ReviseDto } from './dto/iterate.dto';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * The dashboard's route to the external creative pipeline.
 *
 * Mounted at its own root (`/api/v1/pipeline-bridge/...`) rather than under
 * `/creative` on purpose: `campaigns.controller.ts` shows how easily a new
 * literal segment gets swallowed by an earlier `:param` route, and a separate
 * root removes the question entirely.
 *
 * Every route is protected by the global JwtAuthGuard (APP_GUARD in
 * AuthModule) — no `@Public()` here. The pipeline has its own bearer token,
 * held server-side and never sent to the browser.
 */
@Controller('pipeline-bridge')
export class PipelineBridgeController {
  constructor(private readonly bridge: PipelineBridgeService) {}

  /**
   * GET /api/v1/pipeline-bridge/:tenantId/options
   *
   * Formats, angles, tracks, languages, models and the count default. Served
   * from the pipeline rather than hardcoded here so that adding, say, a new raw
   * visual direction to the pipeline's guide shows up in the form without a
   * deploy on either side.
   */
  @Get(':tenantId/options')
  async options(@Param('tenantId') _tenantId: string): Promise<unknown> {
    return this.bridge.getOptions();
  }

  /** GET /api/v1/pipeline-bridge/:tenantId/health — lets the UI distinguish "offline" from "broken". */
  @Get(':tenantId/health')
  async health(@Param('tenantId') _tenantId: string): Promise<unknown> {
    return this.bridge.health();
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/runs
   *
   * Start a Custom-brief run. Returns immediately with `{ run_id, count, ... }`
   * — the work is queued on the pipeline, not done inline. Poll the two routes
   * below for progress; finished creatives arrive on their own via the
   * pipeline's push into `/creative/:tenantId/packages/upload-bulk`.
   */
  @Post(':tenantId/runs')
  async startRun(
    @Param('tenantId') tenantId: string,
    @Body() dto: StartRunDto,
  ): Promise<unknown> {
    return this.bridge.startRun(tenantId, dto);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/uploads
   *
   * Reference image(s) for a Custom-brief run, returned as refs to pass back as
   * `image_refs`. Kept separate from `runs` so the run body stays plain JSON and
   * the operator can upload while still filling in the form.
   */
  @Post(':tenantId/uploads')
  @UseInterceptors(FilesInterceptor('files', 5))
  async uploads(
    @Param('tenantId') _tenantId: string,
    @UploadedFiles() files: Array<{ originalname: string; buffer: Buffer; mimetype: string }>,
  ): Promise<unknown> {
    if (!files?.length) {
      throw new BadRequestException('No files were uploaded.');
    }
    return this.bridge.uploadImages(files);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/packages/:packageId/resize
   *
   * Generate the remaining placement sizes for a creative the pipeline produced. Returns
   * immediately — the cascade is Playwright-driven and takes minutes, and the finished sizes are
   * attached to the package by the pipeline itself. 404 if the pipeline did not make this package.
   */
  @Post(':tenantId/packages/:packageId/resize')
  async resizePackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
  ): Promise<unknown> {
    return this.bridge.resizePackage(packageId);
  }

  /**
   * GET /api/v1/pipeline-bridge/:tenantId/packages/:packageId
   *
   * Whether this creative was produced by the pipeline, and its run. The creative detail page
   * probes this once on load to decide whether its Rewrite / Edit / Retry buttons drive the
   * pipeline or the built-in generator. **404 is the expected answer** for a package the dashboard
   * made itself — callers should treat it as "not ours", not as a failure.
   */
  @Get(':tenantId/packages/:packageId')
  async getPackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
  ): Promise<unknown> {
    return this.bridge.getPackage(packageId);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/packages/:packageId/revise
   *
   * Re-author the brief from an instruction and regenerate — the pipeline's equivalent of the
   * built-in "Rewrite". Returns a NEW run id, because the pipeline revises a clone so the source
   * creative keeps its artifacts; the revision lands as its own package.
   */
  @Post(':tenantId/packages/:packageId/revise')
  async revisePackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
    @Body() dto: ReviseDto,
  ): Promise<unknown> {
    return this.bridge.revisePackage(packageId, dto.instruction);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/packages/:packageId/regenerate
   *
   * Edit the delivered image in place from free text — the pipeline's equivalent of the built-in
   * "Edit". Same package, pixels only.
   */
  @Post(':tenantId/packages/:packageId/regenerate')
  async regeneratePackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
    @Body() dto: RegenerateDto,
  ): Promise<unknown> {
    return this.bridge.regeneratePackage(packageId, dto.instruction, dto.tag);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/clarify
   *
   * Answer the question a stalled revise asked. Addressed by run, not package, because the run
   * waiting on the answer is the clone — which has no package of its own yet.
   */
  @Post(':tenantId/runs/:runId/clarify')
  async clarifyRun(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
    @Body() dto: ClarifyDto,
  ): Promise<unknown> {
    return this.bridge.clarifyRun(runId, dto.answer);
  }

  /** GET /api/v1/pipeline-bridge/:tenantId/runs/:runId — status + per-child progress. */
  @Get(':tenantId/runs/:runId')
  async getRun(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
  ): Promise<unknown> {
    return this.bridge.getRun(runId);
  }

  /**
   * GET /api/v1/pipeline-bridge/:tenantId/runs/:runId/events?after=<cursor>
   *
   * Cursor-paged progress events. Pass back the `cursor` from the previous
   * response so each poll only returns what is new.
   */
  @Get(':tenantId/runs/:runId/events')
  async getEvents(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
    @Query('after') after?: string,
  ): Promise<unknown> {
    return this.bridge.getEvents(runId, Number(after ?? 0));
  }
}
