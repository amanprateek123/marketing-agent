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

/**
 * GET /api/v1/intelligence/:tenantId/decisions
 *   Query params: status, campaignId, limit, since
 * POST /api/v1/intelligence/:tenantId/decisions/:decisionId/approve
 * POST /api/v1/intelligence/:tenantId/decisions/:decisionId/reject
 * GET /api/v1/intelligence/:tenantId/decisions/summary
 *
 * ALL WRITES ARE LOCAL. Meta is never touched by these endpoints.
 */
@Controller('intelligence')
export class DecisionsController {
  constructor(private readonly service: DecisionsService) {}

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
    return {
      ok: true,
      message:
        'Decision approved locally. Nothing has been sent to Meta — shadow mode is still on.',
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
