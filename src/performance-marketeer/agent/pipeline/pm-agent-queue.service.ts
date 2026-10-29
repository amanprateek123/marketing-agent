import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { Model } from 'mongoose';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { istDayFromToday } from '../../pm.logic';
import { PmAgentRun } from '../../schemas/pm-agent-run.schema';
import { PmMetaEntity } from '../../schemas/pm-meta.schema';
import { PmBusyError, PmSyncService } from '../../sync/pm-sync.service';
import { PM_DAY_FILES } from '../pm-agent.types';
import { PmLessonsService } from '../lessons/lessons.service';
import { PmRecordsService } from '../lessons/records.service';
import { PM_RUN_STALE_MS, PmPipelineService } from './pm-pipeline.service';

const POLL_MS = 60_000;
const BUDGET_STEP = 'waiting: daily budget reached';
const SYNC_BUSY_STEP = 'waiting: another data sync is running';
const HISTORY_BEAT_MS = 60_000;
const envNum = (key: string, def: number) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export interface PmEnqueueResult {
  queued: string[];
  skipped: { campaignId: string; reason: string }[];
}

/**
 * Admin-triggered queue for the per-campaign AI analysis (doc 09). The queue
 * is just PmAgentRun docs with status 'queued', oldest queuedAt first. There
 * is no cron: runs start only when someone enqueues them (dashboard) or runs
 * the CLI.
 *
 * Worker: an in-process loop, on only when PM_AGENT_WORKER=true (the CLI,
 * local harness and tests leave it off). The atomic claim (queued → running
 * in one findOneAndUpdate) is the only concurrency guard — no pipeline lock;
 * the CLI claims the same way (PmPipelineService.claim), so a campaign/date
 * is never processed twice at once. The pipeline lock stays for CLI `all`.
 */
@Injectable()
export class PmAgentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PmAgentQueueService.name);
  private stopped = true;
  private wakers = new Set<() => void>();
  /** Day prep + lessons-daily, once per date per process. */
  private days = new Map<string, Promise<void>>();
  private capLogged = new Set<string>();

  constructor(
    private readonly pipeline: PmPipelineService,
    private readonly records: PmRecordsService,
    private readonly lessons: PmLessonsService,
    @InjectModel(PmAgentRun.name) private readonly runs: Model<PmAgentRun>,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
    private readonly sync: PmSyncService,
  ) {}

  get workerEnabled() {
    return process.env.PM_AGENT_WORKER === 'true';
  }
  get capUsd() {
    return envNum('PM_AGENT_MAX_USD_PER_DAY', 100);
  }

  async onModuleInit() {
    if (!this.workerEnabled) return;
    await this.requeueStale().catch((e) =>
      this.logger.error(`stale requeue failed: ${(e as Error).message}`),
    );
    // The Overview lists campaigns from this; the hourly sync keeps it fresh.
    void this.sync.syncCampaignList('cron').catch(() => undefined);
    this.stopped = false;
    const n = envNum('PM_AGENT_CONCURRENCY', 1);
    this.logger.log(`PM agent worker started (concurrency ${n})`);
    for (let i = 0; i < n; i++) void this.loop();
  }

  onModuleDestroy() {
    // Start nothing new. A run in flight is left; if the process dies it is requeued as stale.
    this.stopped = true;
    this.kick();
  }

  // ---------------------------------------------------------------- admin

  async enqueue(
    campaignIds: string[],
    date = istDayFromToday(),
    by = '',
    rerun = false,
  ): Promise<PmEnqueueResult> {
    const t = this.env.tenantId;
    const ids = [...new Set(campaignIds)];
    const camps = await this.entities
      .find(
        { tenantId: t, level: 'campaign', entityId: { $in: ids } },
        { entityId: 1, name: 1, accountId: 1, product: 1 },
      )
      .lean();
    const byId = new Map(camps.map((c) => [c.entityId, c]));
    const out: PmEnqueueResult = { queued: [], skipped: [] };
    const skip = (campaignId: string, reason: string) =>
      out.skipped.push({ campaignId, reason });

    for (const campaignId of ids) {
      const camp = byId.get(campaignId);
      if (!camp) {
        skip(campaignId, 'campaign not found');
        continue;
      }
      const key = { tenantId: t, campaignId, date };
      const fresh = {
        status: 'queued',
        step: '',
        error: '',
        queuedAt: new Date(),
        queuedBy: by,
        campaignName: camp.name,
        accountId: camp.accountId,
        product: camp.product,
      };
      const existing = await this.runs
        .findOne(key, { status: 1, costUsd: 1, priorCostUsd: 1 })
        .lean();
      if (!existing) {
        try {
          await this.runs.create({ ...key, ...fresh });
          out.queued.push(campaignId);
        } catch (e) {
          if ((e as { code?: number }).code !== 11000) throw e;
          skip(campaignId, 'already queued or running');
        }
        continue;
      }
      if (existing.status === 'queued' || existing.status === 'running') {
        skip(campaignId, `already ${existing.status}`);
        continue;
      }
      if (!rerun) {
        skip(campaignId, `already analysed for ${date} — pass rerun`);
        continue;
      }
      // Clean rerun: phase files are reused when present, so the whole folder goes.
      rmSync(this.pipeline.campaignDir(campaignId, date), {
        recursive: true,
        force: true,
      });
      const r = await this.runs.updateOne(
        { ...key, status: { $in: ['done', 'failed'] } },
        {
          $set: {
            ...fresh,
            // Finished runs don't change cost, so the read value is current.
            priorCostUsd:
              (existing.priorCostUsd ?? 0) + (existing.costUsd ?? 0),
            costUsd: 0,
            investigateRounds: 0,
            planRounds: 0,
            unresolved: [],
            actions: [],
            causes: [],
            situation: null,
            lessonsUsed: [],
            lessonsContradicted: [],
            impactRupeesPerDay: 0,
            files: {},
            journal: [],
            startedAt: null,
            finishedAt: null,
            heartbeatAt: null,
          },
        },
      );
      if (r.modifiedCount) out.queued.push(campaignId);
      else skip(campaignId, 'state changed, try again');
    }
    if (out.queued.length) this.kick();
    return out;
  }

  /** Only a queued run can be cancelled. Never ran → deleted; ran before (stale requeue) → failed. */
  async cancel(campaignId: string, date: string) {
    const key = { tenantId: this.env.tenantId, campaignId, date };
    const del = await this.runs.deleteOne({
      ...key,
      status: 'queued',
      startedAt: null,
    });
    if (del.deletedCount) return { campaignId, date, cancelled: 'deleted' };
    const upd = await this.runs.updateOne(
      { ...key, status: 'queued' },
      {
        $set: { status: 'failed', error: 'cancelled', finishedAt: new Date() },
      },
    );
    if (upd.modifiedCount)
      return { campaignId, date, cancelled: 'marked_failed' };
    const doc = await this.runs.findOne(key, { status: 1 }).lean();
    if (!doc) throw new NotFoundException('No run for this campaign and date');
    throw new ConflictException(
      `Only queued runs can be cancelled (this one is ${doc.status})`,
    );
  }

  /** Live queue (all dates, in claim order) + running + finished runs of `date`. */
  async list(date = istDayFromToday()) {
    const t = this.env.tenantId;
    const fields = {
      campaignId: 1,
      campaignName: 1,
      date: 1,
      status: 1,
      step: 1,
      error: 1,
      queuedAt: 1,
      queuedBy: 1,
      startedAt: 1,
      heartbeatAt: 1,
      finishedAt: 1,
      costUsd: 1,
      priorCostUsd: 1,
      actions: 1,
    };
    const [queued, running, finished, spent] = await Promise.all([
      this.runs
        .find({ tenantId: t, status: 'queued' }, fields)
        .sort({ queuedAt: 1 })
        .lean(),
      this.runs
        .find({ tenantId: t, status: 'running' }, fields)
        .sort({ startedAt: 1 })
        .lean(),
      this.runs
        .find(
          { tenantId: t, date, status: { $in: ['done', 'failed'] } },
          fields,
        )
        .sort({ finishedAt: -1 })
        .lean(),
      this.spentUsd([date]),
    ]);
    const base = (r: (typeof queued)[number]) => ({
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      date: r.date,
      step: r.step,
    });
    return {
      date,
      worker: this.workerEnabled,
      capUsd: this.capUsd,
      spentUsd: round2(spent.get(date) ?? 0),
      queued: queued.map((r, i) => ({
        ...base(r),
        position: i + 1,
        queuedAt: r.queuedAt,
        queuedBy: r.queuedBy,
      })),
      running: running.map((r) => ({
        ...base(r),
        startedAt: r.startedAt,
        heartbeatAt: r.heartbeatAt,
        costUsd: round2(r.costUsd),
      })),
      finished: finished.map((r) => ({
        ...base(r),
        status: r.status,
        error: r.error,
        costUsd: round2(r.costUsd),
        finishedAt: r.finishedAt,
        actionCount: r.actions?.length ?? 0,
      })),
    };
  }

  // ---------------------------------------------------------------- worker

  /** 'running' runs with no heartbeat for PM_RUN_STALE_MS → back to queued (keeps queue order). */
  async requeueStale() {
    const r = await this.runs.updateMany(
      {
        tenantId: this.env.tenantId,
        status: 'running',
        $or: [
          { heartbeatAt: null },
          { heartbeatAt: { $lt: new Date(Date.now() - PM_RUN_STALE_MS) } },
        ],
      },
      // queuedAt is kept, so it resumes its place (null = pre-queue doc, sorts first).
      { $set: { status: 'queued', step: 'requeued: stale heartbeat' } },
    );
    if (r.modifiedCount)
      this.logger.warn(`requeued ${r.modifiedCount} stale run(s)`);
    return r.modifiedCount;
  }

  /** Oldest queued run whose date is under the daily cap → running, atomically. Null if none. */
  async claimNext() {
    const t = this.env.tenantId;
    const dates: string[] = await this.runs.distinct('date', {
      tenantId: t,
      status: 'queued',
    });
    if (!dates.length) return null;
    const spent = await this.spentUsd(dates);
    const capped = dates.filter((d) => (spent.get(d) ?? 0) >= this.capUsd);
    if (capped.length) {
      await this.runs.updateMany(
        { tenantId: t, status: 'queued', date: { $in: capped } },
        { $set: { step: BUDGET_STEP } },
      );
      for (const d of capped)
        if (!this.capLogged.has(d)) {
          this.capLogged.add(d);
          this.logger.warn(
            `daily budget $${this.capUsd} reached for ${d} ($${round2(spent.get(d) ?? 0)}); its queued runs wait`,
          );
        }
    }
    // ponytail: cap is checked before the claim, so with concurrency N a date can overshoot by up to N-1 runs.
    const now = new Date();
    return this.runs
      .findOneAndUpdate(
        { tenantId: t, status: 'queued', date: { $nin: capped } },
        {
          $set: {
            status: 'running',
            step: 'claimed',
            heartbeatAt: now,
            startedAt: now,
          },
        },
        {
          sort: { queuedAt: 1 },
          returnDocument: 'after',
          projection: { campaignId: 1, date: 1 },
        },
      )
      .lean();
  }

  /** One unit of work. True if a run was processed. Never throws. */
  async tick(): Promise<boolean> {
    try {
      const run = await this.claimNext();
      if (!run) return false;
      const history = await this.loadHistory(run);
      if (history !== 'ok') return history === 'failed';
      await this.prepareDate(run.date);
      const r = await this.pipeline.runCampaign(run.date, run.campaignId, {
        claimed: true,
      });
      this.logger.log(
        `[${run.campaignId} ${run.date}] ${r.status} ($${round2(r.costUsd)})`,
      );
      return true;
    } catch (e) {
      // runCampaign marks its own failures; this is Mongo trouble around it.
      this.logger.error(`worker tick failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * The campaign's missing data first (D-30), so the analysis never runs on
   * gaps. Sync lock busy → back to queued, retried next poll. Failure → the
   * run fails with the reason.
   */
  private async loadHistory(run: {
    campaignId: string;
    date: string;
  }): Promise<'ok' | 'busy' | 'failed'> {
    const t = this.env.tenantId;
    const key = { tenantId: t, campaignId: run.campaignId, date: run.date };
    const camp = await this.entities
      .findOne(
        { tenantId: t, level: 'campaign', entityId: run.campaignId },
        { entityId: 1, accountId: 1, createdTime: 1 },
      )
      .lean();
    // No entity: runCampaign fails it with the reason.
    if (!camp) return 'ok';
    const beat = setInterval(
      () =>
        void this.runs
          .updateOne(key, { $set: { heartbeatAt: new Date() } })
          .catch(() => undefined),
      HISTORY_BEAT_MS,
    );
    try {
      await this.sync.campaignHistory(camp, addDays(run.date, -1), (step) =>
        this.runs.updateOne(key, { $set: { step, heartbeatAt: new Date() } }),
      );
      return 'ok';
    } catch (e) {
      if (e instanceof PmBusyError) {
        await this.runs.updateOne(key, {
          $set: { status: 'queued', step: SYNC_BUSY_STEP },
        });
        return 'busy';
      }
      const message = `loading history failed: ${(e as Error).message}`;
      this.logger.error(`[${run.campaignId} ${run.date}] ${message}`);
      await this.runs.updateOne(key, {
        $set: { status: 'failed', error: message, finishedAt: new Date() },
      });
      return 'failed';
    } finally {
      clearInterval(beat);
    }
  }

  kick() {
    for (const w of this.wakers) w();
    this.wakers.clear();
  }

  private async loop() {
    while (!this.stopped) {
      if (await this.tick()) continue;
      await this.requeueStale().catch(() => undefined);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, POLL_MS);
        this.wakers.add(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Day files (if missing) and lessons-daily, once per date per process. Errors are logged, never block. */
  private prepareDate(date: string) {
    let p = this.days.get(date);
    if (!p) {
      p = (async () => {
        if (!existsSync(join(this.pipeline.dayDir(date), PM_DAY_FILES.account)))
          await this.pipeline
            .prepareDay(date)
            .catch((e) =>
              this.logger.error(`prep ${date} failed: ${(e as Error).message}`),
            );
        try {
          await this.records.daily(date);
          await this.lessons.scoreDaily(date);
        } catch (e) {
          this.logger.error(
            `lessons-daily ${date} failed: ${(e as Error).message}`,
          );
        }
      })();
      this.days.set(date, p);
    }
    return p;
  }

  private async spentUsd(dates: string[]) {
    const rows = await this.runs.aggregate<{ _id: string; usd: number }>([
      { $match: { tenantId: this.env.tenantId, date: { $in: dates } } },
      {
        $group: {
          _id: '$date',
          usd: {
            $sum: {
              $add: [
                { $ifNull: ['$costUsd', 0] },
                { $ifNull: ['$priorCostUsd', 0] },
              ],
            },
          },
        },
      },
    ]);
    return new Map(rows.map((r) => [r._id, r.usd]));
  }
}

const round2 = (n: number) => Math.round((n || 0) * 100) / 100;
