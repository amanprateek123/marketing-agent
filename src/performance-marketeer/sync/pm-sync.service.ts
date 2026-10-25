import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { findPmProduct, PM_PRODUCTS, pmEnv, PmEnv } from '../pm.config';
import { dayRange, istDayBounds, istDayFromToday } from '../pm.logic';
import { PmLock } from '../schemas/pm-lock.schema';
import { PmJob, PmSyncRun } from '../schemas/pm-sync-run.schema';
import { AttributionSync } from './attribution.sync';
import { MetaSync } from './meta.sync';
import { OrdersSync } from './orders.sync';
import { VisitorDaysSync } from './visitor-days.sync';

export interface PmSyncRequest {
  from: string;
  to: string;
  product?: string;
  trigger: 'cron' | 'api' | 'cli';
}

// Attribution scans ClickHouse from 7 days before the earliest order to the
// latest; small day chunks keep each query inside insights_reader's limits.
const ATTRIBUTION_CHUNK_DAYS = 3;
// Longest a sync may hold the lock (a 200-day backfill takes ~15 min).
const LEASE_MS = 60 * 60 * 1000;
const REFUND_RECHECK_DAYS = 60;

export const PM_META_PARTS = [
  'daily',
  'entities',
  'breakdowns',
  'changes',
  'retag',
] as const;
export type PmMetaPart = (typeof PM_META_PARTS)[number];

export class PmBusyError extends Error {}
export class PmLockLostError extends Error {}

/**
 * Runs the Performance Marketeer syncs. One sync at a time across every
 * process (a Mongo lease), and inside a sync one query at a time, so
 * ClickHouse and production Mongo never see more than one query from us.
 * Each step is recorded in pm_sync_runs; a failed product-day is logged and
 * skipped, not fatal.
 */
@Injectable()
export class PmSyncService {
  private readonly logger = new Logger(PmSyncService.name);
  private readonly holder = randomUUID();

  constructor(
    private readonly visitorDays: VisitorDaysSync,
    private readonly orders: OrdersSync,
    private readonly attribution: AttributionSync,
    private readonly meta: MetaSync,
    @InjectModel(PmSyncRun.name) private readonly runs: Model<PmSyncRun>,
    @InjectModel(PmLock.name) private readonly locks: Model<PmLock>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  /** Visitor-days, then orders, then attribution for the same days — the order matters. */
  all(req: PmSyncRequest) {
    return this.exclusive('all', async () => {
      await this.visitorDaysStep(req);
      await this.ordersStep(req);
      await this.attributionStep(req);
    });
  }

  syncVisitorDays(req: PmSyncRequest) {
    return this.exclusive('visitor-days', () => this.visitorDaysStep(req));
  }

  syncOrders(req: PmSyncRequest) {
    return this.exclusive('orders', () => this.ordersStep(req));
  }

  syncAttribution(req: PmSyncRequest) {
    return this.exclusive('attribution', () => this.attributionStep(req));
  }

  /**
   * Meta: daily ad insights, settings of ads that spent, breakdowns, change
   * log — or only some of these parts (e.g. to skip days already loaded).
   */
  syncMeta(req: PmSyncRequest, parts: PmMetaPart[] = [...PM_META_PARTS]) {
    return this.exclusive('meta', async () => {
      if (parts.includes('daily')) await this.metaDailyStep(req);
      if (parts.includes('entities'))
        await this.metaEntitiesStep(req, 'missing');
      if (parts.includes('breakdowns')) await this.metaBreakdownsStep(req);
      if (parts.includes('changes')) await this.metaChangesStep(req);
      if (parts.includes('retag'))
        await this.track('meta-entities', req, async () => ({
          rows: await this.meta.retagAll(),
        }));
    });
  }

  /**
   * Hourly: today's visitor rows (so today's orders can be attributed), orders
   * of the last 3 days, new refunds, and attribution for those days.
   */
  hourly() {
    return this.exclusive('hourly', async () => {
      const today = istDayFromToday(0);
      const recent = {
        from: istDayFromToday(-2),
        to: today,
        trigger: 'cron' as const,
      };
      await this.visitorDaysStep({ ...recent, from: today });
      await this.ordersStep(recent);
      await this.track('refunds', recent, async () => ({
        rows: await this.orders.syncNewRefunds(istDayBounds(recent.from).start),
      }));
      await this.attributionStep(recent);
      if (this.meta.configured) {
        const metaReq = { ...recent, from: istDayFromToday(-1) };
        await this.metaDailyStep(metaReq);
        await this.metaEntitiesStep(metaReq, 'missing');
        await this.metaChangesStep(metaReq);
      }
    });
  }

  /**
   * Nightly: rebuild the last 2 full days of visitor rows (late page_time
   * events), re-check refunds over 60 days, and re-attribute the week.
   */
  nightly() {
    return this.exclusive('nightly', async () => {
      await this.visitorDaysStep({
        from: istDayFromToday(-2),
        to: istDayFromToday(-1),
        trigger: 'cron',
      });
      const refundReq = {
        from: istDayFromToday(-REFUND_RECHECK_DAYS),
        to: istDayFromToday(0),
        trigger: 'cron' as const,
      };
      await this.track('refunds', refundReq, async () => ({
        rows: await this.orders.recheckRefunds(
          dayRange(refundReq.from, refundReq.to),
        ),
      }));
      await this.attributionStep({
        from: istDayFromToday(-8),
        to: istDayFromToday(0),
        trigger: 'cron',
      });
      if (this.meta.configured) {
        const cron = { to: istDayFromToday(0), trigger: 'cron' as const };
        // Meta keeps updating conversions for the attribution window (7 days).
        await this.metaDailyStep({ ...cron, from: istDayFromToday(-7) });
        await this.metaBreakdownsStep({ ...cron, from: istDayFromToday(-3) });
        // Refresh settings (budgets, status, product tags) of everything that spent in 30 days.
        await this.metaEntitiesStep(
          { ...cron, from: istDayFromToday(-30) },
          'all',
        );
        await this.metaChangesStep({ ...cron, from: istDayFromToday(-3) });
      }
    });
  }

  async isBusy(): Promise<string | null> {
    const lock = await this.locks
      .findOne({
        _id: this.lockId,
        tenantId: this.env.tenantId,
        until: { $gt: new Date() },
      })
      .lean();
    return lock?.job ?? null;
  }

  recentRuns(limit = 20) {
    return this.runs
      .find({ tenantId: this.env.tenantId })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
  }

  private visitorDaysStep(req: PmSyncRequest) {
    return this.track('visitor-days', req, async (errors, stats) => {
      let rows = 0;
      for (const day of dayRange(req.from, req.to)) {
        for (const product of this.products(req.product)) {
          try {
            const n = await this.visitorDays.syncDay(product, day);
            rows += n;
            stats[product.id] = (stats[product.id] ?? 0) + n;
          } catch (e) {
            errors.push(`${product.id} ${day}: ${(e as Error).message}`);
          }
        }
      }
      return { rows };
    });
  }

  private ordersStep(req: PmSyncRequest) {
    return this.track('orders', req, async (errors, stats) => {
      let rows = 0;
      for (const day of dayRange(req.from, req.to)) {
        for (const product of this.products(req.product)) {
          try {
            const n = await this.orders.syncDay(product, day);
            rows += n;
            stats[product.id] = (stats[product.id] ?? 0) + n;
          } catch (e) {
            errors.push(`${product.id} ${day}: ${(e as Error).message}`);
          }
        }
      }
      return { rows };
    });
  }

  private attributionStep(req: PmSyncRequest) {
    return this.track('attribution', req, async (errors, stats) => {
      const days = dayRange(req.from, req.to);
      let rows = 0;
      for (let i = 0; i < days.length; i += ATTRIBUTION_CHUNK_DAYS) {
        const part = days.slice(i, i + ATTRIBUTION_CHUNK_DAYS);
        try {
          const r = await this.attribution.attributeDays(part);
          rows += r.orders;
          stats.withDevice = (stats.withDevice ?? 0) + r.withDevice;
          stats.withMetaClick = (stats.withMetaClick ?? 0) + r.withMetaClick;
        } catch (e) {
          errors.push(
            `${part[0]}..${part[part.length - 1]}: ${(e as Error).message}`,
          );
        }
      }
      return { rows };
    });
  }

  private metaDailyStep(req: PmSyncRequest) {
    return this.track('meta-daily', req, async (errors, stats) => {
      let rows = 0;
      for (const account of this.meta.accounts) {
        await this.heartbeat();
        try {
          const r = await this.meta.syncDaily(account, req.from, req.to);
          rows += r.rows;
          stats[account] = r.rows;
        } catch (e) {
          errors.push(`act_${account}: ${(e as Error).message}`);
        }
      }
      return { rows };
    });
  }

  /** 'missing' = ads that spent in range without a settings row; 'all' = every ad that spent in range. */
  private metaEntitiesStep(req: PmSyncRequest, which: 'missing' | 'all') {
    return this.track('meta-entities', req, async (errors, stats) => {
      let rows = 0;
      for (const account of this.meta.accounts) {
        await this.heartbeat();
        try {
          const ids = await this.meta.adsToRefresh(
            account,
            req.from,
            req.to,
            which,
          );
          const n = await this.meta.syncEntities(account, ids);
          rows += n;
          stats[account] = n;
        } catch (e) {
          errors.push(`act_${account}: ${(e as Error).message}`);
        }
      }
      return { rows };
    });
  }

  private metaBreakdownsStep(req: PmSyncRequest) {
    return this.track('meta-breakdowns', req, async (errors, stats) => {
      let rows = 0;
      for (const account of this.meta.accounts) {
        await this.heartbeat();
        try {
          const n = await this.meta.syncBreakdowns(account, req.from, req.to);
          rows += n;
          stats[account] = n;
        } catch (e) {
          errors.push(`act_${account}: ${(e as Error).message}`);
        }
      }
      return { rows };
    });
  }

  private metaChangesStep(req: PmSyncRequest) {
    return this.track('meta-changes', req, async (errors, stats) => {
      let rows = 0;
      for (const account of this.meta.accounts) {
        await this.heartbeat();
        try {
          const n = await this.meta.syncChanges(account, req.from, req.to);
          rows += n;
          stats[account] = n;
        } catch (e) {
          errors.push(`act_${account}: ${(e as Error).message}`);
        }
      }
      return { rows };
    });
  }

  /** Extends the lease while a long sync (e.g. a Meta backfill waiting on rate limits) is still working. */
  private async heartbeat() {
    const r = await this.locks.updateOne(
      { _id: this.lockId, tenantId: this.env.tenantId, holder: this.holder },
      { $set: { until: new Date(Date.now() + LEASE_MS) } },
    );
    // Another process took over an expired lease: stop rather than run twice.
    if (r.matchedCount === 0)
      throw new PmLockLostError('Lost the Performance Marketeer sync lock');
  }

  private products(id?: string) {
    if (!id) return PM_PRODUCTS;
    const product = findPmProduct(id);
    if (!product) throw new Error(`Unknown product: ${id}`);
    return [product];
  }

  private get lockId() {
    return `pm-sync:${this.env.tenantId}`;
  }

  /** Holds the cross-process lease for the whole of `work`. Throws PmBusyError if another sync holds it. */
  private async exclusive(job: string, work: () => Promise<unknown>) {
    const now = new Date();
    try {
      // Matches only a free (expired) lease; if a live one exists the upsert
      // collides on _id and fails, which means "busy".
      await this.locks.findOneAndUpdate(
        { _id: this.lockId, tenantId: this.env.tenantId, until: { $lte: now } },
        {
          $set: {
            holder: this.holder,
            job,
            until: new Date(now.getTime() + LEASE_MS),
          },
        },
        { upsert: true },
      );
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        throw new PmBusyError(
          `A Performance Marketeer sync is already running (${(await this.isBusy()) ?? 'unknown'})`,
        );
      }
      throw e;
    }
    this.meta.setHeartbeat(() => this.heartbeat());
    try {
      await work();
    } finally {
      this.meta.setHeartbeat(null);
      await this.locks.updateOne(
        { _id: this.lockId, tenantId: this.env.tenantId, holder: this.holder },
        { $set: { until: new Date(0) } },
      );
    }
  }

  private async track(
    job: PmJob,
    req: PmSyncRequest,
    work: (
      errors: string[],
      stats: Record<string, number>,
    ) => Promise<{ rows: number }>,
  ) {
    const tenantId = this.env.tenantId;
    const run = await this.runs.create({
      tenantId,
      job,
      from: req.from,
      to: req.to,
      product: req.product ?? '',
      trigger: req.trigger,
      startedAt: new Date(),
    });
    const errors: string[] = [];
    const stats: Record<string, number> = {};
    try {
      const { rows } = await work(errors, stats);
      const status = errors.length
        ? rows
          ? 'partial'
          : 'failed'
        : 'succeeded';
      await this.runs.updateOne(
        { _id: run._id, tenantId },
        { status, rows, errorMessages: errors, stats, finishedAt: new Date() },
      );
      const msg = `PM ${job} ${req.from}..${req.to}: ${status}, ${rows} rows`;
      if (errors.length)
        this.logger.warn(
          `${msg}, ${errors.length} errors: ${errors.slice(0, 3).join(' | ')}`,
        );
      else this.logger.log(msg);
      return { status, rows, errors, stats };
    } catch (e) {
      const message = (e as Error).message;
      await this.runs.updateOne(
        { _id: run._id, tenantId },
        {
          status: 'failed',
          errorMessages: [...errors, message],
          stats,
          finishedAt: new Date(),
        },
      );
      this.logger.error(`PM ${job} ${req.from}..${req.to} failed: ${message}`);
      throw e;
    }
  }
}
