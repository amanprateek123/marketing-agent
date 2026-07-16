import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import { DecisionStatus } from './intelligence-decision.schema';
import { IntelligenceOrchestrator } from '../orchestrator/intelligence-orchestrator.service';

/**
 * GET /api/v1/intelligence/:tenantId/decisions
 *   Query params: status, campaignId, limit, since
 * POST /api/v1/intelligence/:tenantId/decisions/:decisionId/approve
 *   Approves AND immediately executes the action on the live Meta campaign
 *   (see DecisionsService.executeApprovedDecision). The automatic 30-min/
 *   3-hour cascade itself never does this — shadowModeOnly stays enforced
 *   there. Only an explicit human approval through this endpoint reaches
 *   Meta.
 * POST /api/v1/intelligence/:tenantId/decisions/:decisionId/reject
 * GET /api/v1/intelligence/:tenantId/decisions/summary
 * GET /api/v1/intelligence/:tenantId/cycles
 *   Query params: campaignId, limit — recent cascade cycles for this
 *   tenant, each carrying the diagnosis narrative even when the cycle
 *   proposed zero decisions. This is the "why did nothing happen" trail —
 *   see IntelligenceOrchestrator.listRecentCycles / LearningEngine.
 */
@Controller('intelligence')
export class DecisionsController {
  constructor(
    private readonly service: DecisionsService,
    private readonly orchestrator: IntelligenceOrchestrator,
  ) {}

  @Get(':tenantId/decisions')
  async list(
    @Param('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit?: string,
    @Query('sinceHours') sinceHours?: string,
  ) {
    let since: Date | undefined;
    if (sinceHours) {
      const h = parseInt(sinceHours, 10);
      if (!Number.isFinite(h) || h <= 0 || h > 720) {
        throw new BadRequestException('sinceHours must be 1..720');
      }
      since = new Date(Date.now() - h * 3600_000);
    }
    const decisions = await this.service.list({
      tenantId,
      status: (status as DecisionStatus) || undefined,
      campaignId,
      limit: limit ? parseInt(limit, 10) : undefined,
      since,
    });
    return { decisions, count: decisions.length };
  }

  @Get(':tenantId/decisions/summary')
  async summary(@Param('tenantId') tenantId: string) {
    return this.service.summary(tenantId);
  }

  @Get(':tenantId/cycles')
  async cycles(
    @Param('tenantId') tenantId: string,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit?: string,
  ) {
    const cycles = await this.orchestrator.listRecentCycles(
      tenantId,
      campaignId,
      limit ? parseInt(limit, 10) : undefined,
    );
    return { cycles, count: cycles.length };
  }

  @Post(':tenantId/decisions/:decisionId/approve')
  async approve(
    @Param('tenantId') _tenantId: string,
    @Param('decisionId') decisionId: string,
    @Body() body: { reviewer?: string; notes?: string },
  ) {
    const doc = await this.service.approve(
      decisionId,
      body?.reviewer,
      body?.notes,
    );
    const result = await this.service.executeApprovedDecision(decisionId);
    return {
      ok: true,
      message: result.executed
        ? 'Decision approved and applied to the live Meta campaign.'
        : `Decision approved locally, but the Meta call failed: ${result.error}`,
      executed: result.executed,
      executionError: result.error,
      decision: doc,
    };
  }

  @Post(':tenantId/decisions/:decisionId/reject')
  async reject(
    @Param('tenantId') _tenantId: string,
    @Param('decisionId') decisionId: string,
    @Body() body: { reason: string; reviewer?: string },
  ) {
    if (!body?.reason?.trim()) {
      throw new BadRequestException('reason is required');
    }
    const doc = await this.service.reject(
      decisionId,
      body.reason,
      body.reviewer,
    );
    return {
      ok: true,
      message: 'Decision rejected locally. Feedback recorded for learning.',
      decision: doc,
    };
  }
}
