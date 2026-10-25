import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { findPmProduct, pmEnv, PmEnv } from './pm.config';
import { dayRange } from './pm.logic';
import { PmBusyError, PmSyncService } from './sync/pm-sync.service';

const JOBS = ['all', 'visitor-days', 'orders', 'attribution'] as const;
type Job = (typeof JOBS)[number];

/**
 * Admin endpoints for the Performance Marketeer data layer. Behind the global
 * JWT guard like every other route, and — like the crons — closed unless
 * PM_SYNC_ENABLED=true. Syncs run in the background.
 */
@Controller('performance-marketeer/:tenantId')
export class PmController {
  private readonly logger = new Logger(PmController.name);

  constructor(
    private readonly sync: PmSyncService,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  @Get('sync/runs')
  runs(@Param('tenantId') tenantId: string) {
    this.assertTenant(tenantId);
    return this.sync.recentRuns();
  }

  /** Backfill or re-sync a day range: { job, from, to, product? }. */
  @Post('sync')
  async start(
    @Param('tenantId') tenantId: string,
    @Body() body: { job?: Job; from?: string; to?: string; product?: string },
  ) {
    this.assertTenant(tenantId);
    if (!this.env.syncEnabled)
      throw new ServiceUnavailableException(
        'Performance Marketeer sync is disabled (PM_SYNC_ENABLED)',
      );
    const job = body?.job ?? 'all';
    if (!JOBS.includes(job))
      throw new BadRequestException(`job must be one of ${JOBS.join(', ')}`);
    try {
      dayRange(body?.from ?? '', body?.to ?? '');
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    if (body.product && !findPmProduct(body.product))
      throw new BadRequestException('Unknown product');
    const busy = await this.sync.isBusy();
    if (busy)
      throw new ConflictException(`A sync is already running (${busy})`);
    const req = {
      from: body.from!,
      to: body.to!,
      product: body.product,
      trigger: 'api' as const,
    };
    const run = {
      all: () => this.sync.all(req),
      'visitor-days': () => this.sync.syncVisitorDays(req),
      orders: () => this.sync.syncOrders(req),
      attribution: () => this.sync.syncAttribution(req),
    }[job];
    run().catch((e) =>
      e instanceof PmBusyError
        ? this.logger.warn(e.message)
        : this.logger.error(`PM sync ${job} failed: ${(e as Error).message}`),
    );
    return {
      started: true,
      job,
      from: req.from,
      to: req.to,
      product: req.product ?? 'all',
    };
  }

  // Data is per workspace; only the configured tenant has any.
  private assertTenant(tenantId: string) {
    if (tenantId !== this.env.tenantId) throw new NotFoundException();
  }
}
