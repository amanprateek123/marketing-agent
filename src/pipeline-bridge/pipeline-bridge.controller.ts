import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { StartRunDto } from './dto/start-run.dto';
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
