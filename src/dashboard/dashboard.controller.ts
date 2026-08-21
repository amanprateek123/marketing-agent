import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import {
  DashboardOverview,
  ToolImpactOverview,
  ToolImpactScope,
} from './dashboard.types';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * GET /api/v1/dashboard/:tenantId/overview?windowDays=30
   *
   * The whole tenant picture in one call — economics, portfolio rollup,
   * enriched campaign rows, alerts, facet breakdowns, trend, and activity
   * across pipeline/creative/approval queues.
   *
   * Deliberately one endpoint rather than several: the numbers have to agree
   * with each other, and they only do that if they are computed together from
   * one snapshot of the data. The previous dashboard assembled its own view
   * from four independent fetches and showed two mutually contradictory ROAS
   * figures side by side as a result.
   */
  @Get(':tenantId/overview')
  async getOverview(
    @Param('tenantId') tenantId: string,
    @Query('windowDays', new ParseIntPipe({ optional: true }))
    windowDays?: number,
  ): Promise<DashboardOverview> {
    const days = clampWindow(windowDays);
    return this.dashboard.getOverview(tenantId, days);
  }

  /**
   * GET /api/v1/dashboard/:tenantId/tool-impact?scope=agent|managed
   *
   * Defaults to AI-pipeline campaigns (`agent`). `managed` adds campaigns a
   * person created through the dashboard (`human`). Both scopes require
   * verified Meta launch evidence for impact metrics and always exclude
   * campaigns imported from Ads Manager (`manual`).
   */
  @Get(':tenantId/tool-impact')
  async getToolImpact(
    @Param('tenantId') tenantId: string,
    @Query('scope') scope?: string,
  ): Promise<ToolImpactOverview> {
    return this.dashboard.getToolImpact(tenantId, parseToolImpactScope(scope));
  }
}

function parseToolImpactScope(scope: string | undefined): ToolImpactScope {
  if (scope == null || scope.trim() === '') return 'agent';
  if (scope === 'agent' || scope === 'managed') return scope;
  throw new BadRequestException('scope must be either "agent" or "managed"');
}

/** 1-365 days. Guards against a hostile or fat-fingered window blowing up the
 *  timeseries query. */
function clampWindow(days: number | undefined): number {
  if (!days || !Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(days)));
}
