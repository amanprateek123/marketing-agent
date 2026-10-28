import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { z } from 'zod';
import { PmAnalysisService } from '../../analysis/pm-analysis.service';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { istDay, istDayBounds } from '../../pm.logic';
import { PmAgentRun } from '../../schemas/pm-agent-run.schema';
import { PmMetaEntitySnapshot } from '../../schemas/pm-entity-snapshot.schema';
import { PmMetaChange, PmMetaEntity } from '../../schemas/pm-meta.schema';
import { parseExtraData } from '../../sync/meta.logic';
import type { PmJournalEntry } from '../pm-agent.types';
import type { PmToolDef } from '../tools/pm-tool';
import {
  buildJournal,
  daysBetween,
  journalMarkdown,
  PmChangeRow,
  PmJournalItem,
  PmWindowMetrics,
  resultLine,
  snapshotDiffs,
  timeLabel,
} from './journal.logic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHANGES_LIMIT = 500;
/** Extra history so an unpause can be compared with the pause before it. */
const HISTORY_DAYS = 45;

/**
 * Builds 00-journal.md for one campaign by code (doc 09, "Day-to-day
 * memory"): our stored recommendations vs Meta's change log (settings
 * snapshots as fallback), each with a before/after first-party read. No LLM.
 */
const JOURNAL_CACHE_MS = 10 * 60 * 1000;

@Injectable()
export class PmJournalService {
  constructor(
    @InjectModel(PmAgentRun.name) private readonly runs: Model<PmAgentRun>,
    @InjectModel(PmMetaChange.name)
    private readonly changesModel: Model<PmMetaChange>,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmMetaEntitySnapshot.name)
    private readonly snapshots: Model<PmMetaEntitySnapshot>,
    private readonly analysis: PmAnalysisService,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  /**
   * The journal tool is called many times per run; the result can't change
   * within minutes, so reuse it. ponytail: per-process map, fine for one box.
   */
  private readonly cache = new Map<
    string,
    { at: number; value: ReturnType<PmJournalService['build']> }
  >();

  cachedBuild(campaignId: string, date: string, days: number) {
    const key = `${campaignId}|${date}|${days}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < JOURNAL_CACHE_MS) return hit.value;
    const value = this.build(campaignId, date, days);
    value.catch(() => this.cache.delete(key));
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async build(
    campaignId: string,
    date: string,
    days = 14,
  ): Promise<{ entries: PmJournalEntry[]; markdown: string }> {
    const tenantId = this.env.tenantId;
    const from = addDays(date, -days);
    const [runs, changes, adsets, campaign] = await Promise.all([
      this.runs
        .find(
          { tenantId, campaignId, date: { $gte: from, $lt: date } },
          { date: 1, actions: 1, userNote: 1 },
        )
        .sort({ date: -1 })
        .lean(),
      this.changeRows(campaignId, addDays(from, -HISTORY_DAYS), date),
      this.entities
        .find(
          { tenantId, campaignId, level: 'adset' },
          { entityId: 1, learningStage: 1 },
        )
        .lean(),
      this.entities
        .findOne(
          { tenantId, level: 'campaign', entityId: campaignId },
          { name: 1 },
        )
        .lean(),
    ]);
    const learning = new Map(adsets.map((s) => [s.entityId, s.learningStage]));
    const items = buildJournal({
      date,
      days,
      runs: runs.map((r) => ({
        date: r.date,
        actions: r.actions ?? [],
        userNote: r.userNote ?? '',
      })),
      changes,
      // Learning has ended once Meta reports anything but LEARNING for the ad set.
      learningEnded: (id) =>
        Boolean(learning.get(id)) && learning.get(id) !== 'LEARNING',
    });
    await Promise.all(
      items
        .filter((i) => !i.resultSoFar)
        .map(async (i) => (i.resultSoFar = await this.result(i, date))),
    );
    // Contract shape only (drop the service-side fields; entityId feeds the settling check).
    const entries = items.map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ entityName, level, changeAt, ...e }) => e,
    );
    const markdown = journalMarkdown(items, {
      campaignName: campaign?.name || campaignId,
      date,
      days,
      notes: runs.map((r) => ({ date: r.date, note: r.userNote ?? '' })),
    });
    return { entries, markdown };
  }

  /**
   * This campaign's Meta changes in [from, to] (IST days), enriched: parsed
   * field/old/new (also for rows synced before parsing existed) and the
   * campaign / ad set mapping. Falls back to settings-snapshot diffs when the
   * activity log has nothing.
   */
  async changeRows(
    campaignId: string,
    from: string,
    to: string,
  ): Promise<PmChangeRow[]> {
    const tenantId = this.env.tenantId;
    const ents = await this.entities
      .find(
        { tenantId, campaignId },
        { entityId: 1, adsetId: 1, campaignId: 1 },
      )
      .lean();
    const byId = new Map(ents.map((e) => [e.entityId, e]));
    const rows = await this.changesModel
      .find({
        tenantId,
        eventTime: {
          $gte: istDayBounds(from).start,
          $lt: istDayBounds(to).end,
        },
        $or: [
          { campaignId },
          { objectId: { $in: [...byId.keys(), campaignId] } },
        ],
      })
      .sort({ eventTime: -1 }) // newest kept when capped
      .limit(CHANGES_LIMIT)
      .lean();
    if (rows.length)
      return rows.reverse().map((r) => {
        const parsed = r.field
          ? {
              field: r.field,
              oldValue: r.oldValue ?? null,
              newValue: r.newValue ?? null,
            }
          : parseExtraData(r.eventType, r.extraData);
        const e = byId.get(r.objectId);
        return {
          at: new Date(r.eventTime),
          objectType: r.objectType,
          objectId: r.objectId,
          objectName: r.objectName,
          campaignId: r.campaignId || e?.campaignId || campaignId,
          adsetId: r.adsetId || e?.adsetId || '',
          eventType: r.eventType,
          ...parsed,
          actorName: r.actorName ?? '',
          applicationName: r.applicationName ?? '',
          source: 'log' as const,
        };
      });
    const snaps = await this.snapshots
      .find({
        tenantId,
        campaignId,
        date: { $gte: addDays(from, -1), $lte: to },
      })
      .sort({ date: 1 })
      .lean();
    return snapshotDiffs(snaps).filter((c) => istDay(c.at) >= from);
  }

  /** Before/after first-party read: equal windows either side of the change day, change day excluded. */
  private async result(i: PmJournalItem, date: string): Promise<string> {
    if (!i.changeAt || i.status === 'not_taken') return '';
    const changeDay = istDay(i.changeAt);
    const lastDay = addDays(date, -1); // data runs to the day before
    const n = Math.min(7, daysBetween(changeDay, lastDay));
    const read = i.read;
    const day = daysBetween(changeDay, date);
    if (n < 1) return resultLine(read, day, null, null);
    const window = async (
      from: string,
      to: string,
    ): Promise<PmWindowMetrics> => {
      const m = await this.analysis.scopeMetrics(
        { from, to },
        i.level,
        i.entityId,
      );
      return {
        days: n,
        spend: m.spend,
        firstPartyRoas: m.firstPartyRoas,
        firstPartyCpa: m.firstPartyCpa,
      };
    };
    const [before, after] = await Promise.all([
      window(addDays(changeDay, -n), addDays(changeDay, -1)),
      window(addDays(changeDay, 1), addDays(changeDay, n)),
    ]);
    return resultLine(read, day, before, after);
  }

  /** Memory tools for the phase agents. */
  defs(): PmToolDef[] {
    const day = z.string().regex(DAY, 'YYYY-MM-DD');
    return [
      {
        name: 'journal',
        description:
          'This campaign\'s journal for the last N days (default 14): each past recommendation marked taken / partly / not taken from Meta\'s change log, changes we did not recommend ("outside changes"), the read window (too_soon / early / settled — early is signal only), and what is still settling (do not stack edits on it).',
        shape: { days: z.number().int().min(1).max(60).optional() },
        run: async (args: { days?: number }, ctx) =>
          this.cachedBuild(ctx.campaignId, ctx.date, args.days ?? 14),
      },
      {
        name: 'changes',
        description:
          "Meta changes on this campaign's entities between two IST days: field old → new (budgets in ₹), who made it (person / app such as an automated rule), and which ad set / campaign it belongs to. Falls back to daily settings snapshots when Meta's log has nothing.",
        shape: { from: day, to: day },
        run: async (args: { from: string; to: string }, ctx) => {
          if (args.from > args.to) throw new Error('from must be <= to');
          const rows = await this.changeRows(
            ctx.campaignId,
            args.from,
            args.to,
          );
          return {
            rows: rows.map((c) => ({
              at: timeLabel(c.at),
              objectType: c.objectType,
              objectId: c.objectId,
              objectName: c.objectName,
              adsetId: c.adsetId,
              campaignId: c.campaignId,
              eventType: c.eventType,
              field: c.field,
              old: c.oldValue,
              new: c.newValue,
              actor: c.actorName,
              app: c.applicationName,
              source: c.source,
            })),
            ...(rows.length >= CHANGES_LIMIT ? { truncated: true } : {}),
          };
        },
      },
    ];
  }
}
