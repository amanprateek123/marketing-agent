import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';

@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
  ) {}

  /**
   * POST /api/v1/pipeline/:tenantId/trigger
   * Starts a pipeline run for a tenant. Returns immediately with runId.
   */
  @Post(':tenantId/trigger')
  async trigger(@Param('tenantId') tenantId: string) {
    try {
      return await this.orchestrator.trigger(tenantId);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/pipeline/runs/:runId
   * Poll for pipeline status.
   */
  @Get('runs/:runId')
  async getStatus(@Param('runId') runId: string) {
    const run = await this.orchestrator.getStatus(runId);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return run;
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/regenerate-digest
   * Regenerate and re-deliver the digest for an existing run using stored data.
   */
  @Post(':tenantId/runs/:runId/regenerate-digest')
  async regenerateDigest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      await this.orchestrator.regenerateDigest(tenantId, runId);
      return { success: true, message: 'Digest regenerated and delivered' };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }
}
