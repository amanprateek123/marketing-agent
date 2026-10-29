import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { addDays } from '../analysis/pm-stats';
import { PmAnalysisService } from '../analysis/pm-analysis.service';
import {
  findPmProduct,
  PM_HISTORY_START,
  PM_PRODUCTS,
  pmEnv,
  PmEnv,
} from '../pm.config';
import {
  dayRange,
  dayRuns,
  istDay,
  istDayBounds,
  istDayFromToday,
} from '../pm.logic';
import { PmLock } from '../schemas/pm-lock.schema';
import {
  PmMetaBreakdown,
  PmMetaDaily,
  PmSyncCoverage,
} from '../schemas/pm-meta.schema';
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
// Before an AI run: account-wide Meta days and campaign breakdowns this far back (D-30).
const HISTORY_RECENT_DAYS = 30;
// Change log before an AI run: only recent edits matter, and a big account's log is slow to page.
const HISTORY_CHANGES_DAYS = 14;
// Attribution looks 7 days back for the click, so newly loaded visitor days re-attribute a week on.
const ATTRIBUTION_LOOKAHEAD_DAYS = 7;

export const PM_META_PARTS = [
  'campaigns',
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
    private readonly analysis: PmAnalysisService,
    @InjectModel(PmMetaDaily.name)
    private readonly metaDaily: Model<PmMetaDaily>,
    @InjectModel(PmMetaBreakdown.name)
    private readonly breakdowns: Model<PmMetaBreakdown>,
    @InjectModel(PmSyncCoverage.name)
    private readonly coverage: Model<PmSyncCoverage>,
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
      if (parts.includes('campaigns')) await this.syncCampaignList(req.trigger);
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
   * Before an AI run (D-30): load what this campaign's analysis reads and is
   * not loaded yet, from launch (not before PM_HISTORY_START) to `to`. Only
   * missing days are fetched, so a second run is quick:
   * - first-party visitors, orders, attribution (also the last 30 days, for
   *   the account file);
   * - Meta: only this campaign's rows (whole accounts take hours);
   * - ad settings, this campaign's breakdowns (last 30 days), and its
   *   account's change log (last 14 days).
   * Any failed step throws, so the run never analyses half-loaded data.
   * Throws PmBusyError while another sync holds the lock.
   */
  campaignHistory(
    camp: { entityId: string; accountId: string; createdTime?: Date | null },
    to: string,
    onStep: (step: string) => Promise<unknown> = async () => undefined,
  ) {
    return this.exclusive('history', async () => {
      const t = this.env.tenantId;
      const cid = camp.entityId;
      const launched = camp.createdTime
        ? istDay(new Date(camp.createdTime))
        : PM_HISTORY_START;
      const clamp = (d: string) =>
        d < PM_HISTORY_START ? PM_HISTORY_START : d > to ? to : d;
      const from = clamp(launched);
      const recent = clamp(addDays(to, -(HISTORY_RECENT_DAYS - 1)));
      const start = from < recent ? from : recent;
      const req = (r: { from: string; to: string }): PmSyncRequest => ({
        ...r,
        trigger: 'api',
      });
      const must = async (
        p: Promise<{ status: string; errors: string[] }>,
      ) => {
        const r = await p;
        if (r.status !== 'succeeded')
          throw new Error(r.errors[0] ?? `sync ${r.status}`);
      };

      const gaps = await this.analysis.missingDays({ from: start, to });
      if (gaps.visitors.length) {
        await onStep(`history: visitors (${gaps.visitors.length} days)`);
        for (const r of dayRuns(gaps.visitors))
          await must(this.visitorDaysStep(req(r)));
      }
      if (gaps.orders.length) {
        await onStep(`history: orders (${gaps.orders.length} days)`);
        for (const r of dayRuns(gaps.orders))
          await must(this.ordersStep(req(r)));
      }
      const reattribute = dayRuns([...gaps.visitors, ...gaps.orders]);
      if (reattribute.length) {
        await onStep('history: attribution');
        for (const r of reattribute) {
          const end = addDays(r.to, ATTRIBUTION_LOOKAHEAD_DAYS);
          await must(
            this.attributionStep(req({ from: r.from, to: end < to ? end : to })),
          );
        }
      }

      // Meta: only this campaign's rows — whole accounts take hours (JFM24);
      // the hourly/nightly sync fills recent account-wide days.
      const metaGaps = gaps.meta;
      const key = `campaign:${cid}`;
      const covered = new Set(
        (await this.coverage.findOne({ tenantId: t, key }).lean())?.days ?? [],
      );
      const campaignDays = metaGaps.filter(
        (d) => d >= from && !covered.has(d),
      );
      if (campaignDays.length) {
        await onStep(`history: Meta, this campaign (${campaignDays.length} days)`);
        for (const r of dayRuns(campaignDays)) {
          await must(
            this.track('meta-daily', req(r), async (_e, stats) => {
              await this.heartbeat();
              const { rows } = await this.meta.syncDaily(
                camp.accountId,
                r.from,
                r.to,
                cid,
              );
              stats[cid] = rows;
              return { rows };
            }),
          );
          await this.markCovered(key, dayRange(r.from, r.to, 400));
        }
      }

      await onStep('history: ad settings');
      await must(this.metaEntitiesStep(req({ from, to }), 'missing'));

      const bFrom = from > recent ? from : recent;
      const range = { $gte: bFrom, $lte: to };
      const [spent, have] = await Promise.all([
        this.metaDaily.distinct('date', {
          tenantId: t,
          campaignId: cid,
          date: range,
          spend: { $gt: 0 },
        }),
        // 'device' is written last, so a day that has it has all four.
        this.breakdowns.distinct('date', {
          tenantId: t,
          campaignId: cid,
          breakdown: 'device',
          date: range,
        }),
      ]);
      const haveSet = new Set(have);
      const bDays = (spent as string[]).filter((d) => !haveSet.has(d));
      if (bDays.length) {
        await onStep(`history: breakdowns (${bDays.length} days)`);
        for (const r of dayRuns(bDays))
          await must(
            this.track('meta-breakdowns', req(r), async (_e, stats) => {
              await this.heartbeat();
              const rows = await this.meta.syncBreakdowns(
                camp.accountId,
                r.from,
                r.to,
                cid,
              );
              stats[cid] = rows;
              return { rows };
            }),
          );
      }

      const cKey = `changes:${camp.accountId}`;
      const cCovered = new Set(
        (await this.coverage.findOne({ tenantId: t, key: cKey }).lean())
          ?.days ?? [],
      );
      const cFrom = clamp(addDays(to, -(HISTORY_CHANGES_DAYS - 1)));
      const cDays = dayRange(cFrom > from ? cFrom : from, to, 400).filter(
        (d) => !cCovered.has(d),
      );
      if (cDays.length) {
        await onStep(`history: change log (${cDays.length} days)`);
        // One day at a time, so a stopped load keeps the days it finished.
        for (const r of dayRuns(cDays, 1)) {
          await must(
            this.track('meta-changes', req(r), async (_e, stats) => {
              await this.heartbeat();
              const rows = await this.meta.syncChanges(
                camp.accountId,
                r.from,
                r.to,
              );
              stats[camp.accountId] = rows;
              return { rows };
            }),
          );
          await this.markCovered(cKey, dayRange(r.from, r.to, 400));
        }
      }
    });
  }

  /** Every campaign's name/status/launch from Meta (~15 s, no lock: settings upserts only). */
  syncCampaignList(trigger: PmSyncRequest['trigger'] = 'api') {
    const today = istDayFromToday(0);
    return this.track(
      'meta-campaigns',
      { from: today, to: today, trigger },
      async (errors, stats) => {
        let rows = 0;
        for (const account of this.meta.accounts) {
          try {
            const n = await this.meta.syncCampaignList(account);
            rows += n;
            stats[account] = n;
          } catch (e) {
            errors.push(`act_${account}: ${(e as Error).message}`);
          }
        }
        return { rows };
      },
    );
  }

  private markCovered(key: string, days: string[]) {
    return this.coverage.updateOne(
      { tenantId: this.env.tenantId, key },
      { $addToSet: { days: { $each: days } } },
      { upsert: true },
    );
  }

  /**
   * Hourly: today's visitor rows (so today's orders can be attributed), orders
   * of the last 3 days, new refunds, and attribution for those days.
   */
  hourly() {
    return this.exclusive('hourly', () => {
      const today = istDayFromToday(0);
      const recent = {
        from: istDayFromToday(-2),
        to: today,
        trigger: 'cron' as const,
      };
      const metaReq = { ...recent, from: istDayFromToday(-1) };
      return this.steps('hourly', [
        () => this.visitorDaysStep({ ...recent, from: today }),
        () => this.ordersStep(recent),
        () =>
          this.track('refunds', recent, async () => ({
            rows: await this.orders.syncNewRefunds(
              istDayBounds(recent.from).start,
            ),
          })),
        () => this.attributionStep(recent),
        ...(this.meta.configured
          ? [
              () => this.syncCampaignList('cron'),
              () => this.metaDailyStep(metaReq),
              () => this.metaEntitiesStep(metaReq, 'missing'),
              () => this.metaChangesStep(metaReq),
            ]
          : []),
      ]);
    });
  }

  /**
   * Nightly: rebuild the last 2 full days of visitor rows (late page_time
   * events), re-check refunds over 60 days, and re-attribute the week.
   */
  nightly() {
    return this.exclusive('nightly', () => {
      const refundReq = {
        from: istDayFromToday(-REFUND_RECHECK_DAYS),
        to: istDayFromToday(0),
        trigger: 'cron' as const,
      };
      const cron = { to: istDayFromToday(0), trigger: 'cron' as const };
      return this.steps('nightly', [
        () =>
          this.visitorDaysStep({
            from: istDayFromToday(-2),
            to: istDayFromToday(-1),
            trigger: 'cron',
          }),
        () =>
          this.track('refunds', refundReq, async () => ({
            rows: await this.orders.recheckRefunds(
              dayRange(refundReq.from, refundReq.to),
            ),
          })),
        () =>
          this.attributionStep({
            from: istDayFromToday(-8),
            to: istDayFromToday(0),
            trigger: 'cron',
          }),
        ...(this.meta.configured
          ? [
              // Meta keeps updating conversions for the attribution window (7 days).
              () => this.metaDailyStep({ ...cron, from: istDayFromToday(-7) }),
              () =>
                this.metaBreakdownsStep({ ...cron, from: istDayFromToday(-3) }),
              // Refresh settings (budgets, status, product tags) of everything that spent in 30 days.
              () =>
                this.metaEntitiesStep(
                  { ...cron, from: istDayFromToday(-30) },
                  'all',
                ),
              () =>
                this.metaChangesStep({ ...cron, from: istDayFromToday(-3) }),
            ]
          : []),
      ]);
    });
  }

  /**
   * Run steps in order, but don't let one failure (e.g. Metabase unreachable
   * for refunds) stop the rest: each failure is already logged and recorded
   * in pm_sync_runs by track(). Throws once at the end so the job still
   * reports failure. A lost lock stops everything — someone else holds it.
   */
  private async steps(job: string, list: (() => Promise<unknown>)[]) {
    let failed = 0;
    for (const step of list) {
      try {
        await step();
      } catch (e) {
        if (e instanceof PmLockLostError) throw e;
        failed++;
      }
    }
    if (failed)
      throw new Error(
        `${job}: ${failed} of ${list.length} steps failed (see pm_sync_runs); the others ran`,
      );
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
