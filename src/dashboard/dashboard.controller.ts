import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardOverview, ToolImpactOverview } from './dashboard.types';

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
   * GET /api/v1/dashboard/:tenantId/tool-impact
   *
   * Scoped to campaigns THIS TOOL launched (source 'agent' + 'human') —
   * excludes 'manual' campaigns the marketing team runs directly in Meta.
   * getOverview's account-wide numbers are the wrong evidence for "is the
   * tool working," since most of an account's spend and its whole portfolio
   * ROAS can belong to campaigns the tool has never touched.
   */
  @Get(':tenantId/tool-impact')
  async getToolImpact(
    @Param('tenantId') tenantId: string,
  ): Promise<ToolImpactOverview> {
    return this.dashboard.getToolImpact(tenantId);
  }
}

/** 1-365 days. Guards against a hostile or fat-fingered window blowing up the
 *  timeseries query. */
function clampWindow(days: number | undefined): number {
  if (!days || !Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(days)));
}
