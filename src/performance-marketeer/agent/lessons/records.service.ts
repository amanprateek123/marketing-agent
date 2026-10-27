import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { Model } from 'mongoose';
import { z } from 'zod';
import { PmAnalysisService } from '../../analysis/pm-analysis.service';
import type { PmMetrics, PmQuery } from '../../analysis/pm-analysis.types';
import { addDays, previousPeriod } from '../../analysis/pm-stats';
import { findPmProduct, pmEnv, PmEnv } from '../../pm.config';
import { istDay, istDayBounds } from '../../pm.logic';
import { PmAgentRun } from '../../schemas/pm-agent-run.schema';
import { PmMetaEntitySnapshot } from '../../schemas/pm-entity-snapshot.schema';
import {
  PmDecisionRecord as DecisionModel,
  PmDiagnosisCheck as DiagnosisModel,
  PmOutcomeRecord as OutcomeModel,
} from '../../schemas/pm-lesson-records.schema';
import { PmMetaChange, PmMetaDaily, PmMetaEntity } from '../../schemas/pm-meta.schema';
import {
  buildJournal,
  changeKind,
  daysBetween,
  dayLabel,
  inr,
  levelOf,
  outsideTitle,
  PmChangeRow,
  resetsLearning,
} from '../journal/journal.logic';
import { PmJournalService } from '../journal/journal.service';
import type { PmToolCtx } from '../pm-agent.types';
import { PmCalendarTools } from '../tools/calendar.tools';
import { PmCreativeTools } from '../tools/creatives.tools';
import { PmDataTools } from '../tools/data.tools';
import { compareProportions, comparePoisson } from '../tools/maths.logic';
import type { PmToolDef } from '../tools/pm-tool';
import {
  confoundersOf,
  diagnosisOf,
  gradeOutcome,
  isDue,
  PmMove,
  PmWindowSums,
  seasonEdges,
  windowsFor,
} from './grading.logic';
import type { PmDecisionRecord, PmDiagnosisCheck, PmOutcomeRecord } from './lessons.types';
import { PmSituationService } from './situation.service';
import { structureOf } from './situation.logic';

type Level = 'campaign' | 'adset' | 'ad';
type RunAction = PmAgentRun['actions'][number] & { lessonIds?: string[] };
/** Merged causes the pipeline stores on the run (optional until it does). */
interface RunCause {
  id: string;
  category: string;
  confidence: number;
  verdict?: string;
  disputed?: boolean;
}
type Run = PmAgentRun & { causes?: RunCause[]; lessonIds?: string[] };

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
/** Decisions older than this are not graded by the daily job (bootstrap covers the past). */
const GRADE_LOOKBACK_DAYS = 30;
/** Extra change history so an unpause can be compared with the pause before it. */
const HISTORY_DAYS = 45;
const ALL_KINDS = ['festival', 'astro_event', 'market_event'] as ('festival' | 'astro_event' | 'market_event')[];

/** Meta change kind → decision type (Action['type'] where one fits). */
const CHANGE_TYPE: Record<string, string> = {
  budget: 'budget',
  status: 'pause',
  targeting: 'audience',
  creative: 'creative',
  bid: 'bid',
  other: 'other',
};

/**
 * Diagnosis check map: cause category → follow-up metric, compared over the
 * 7 days before the run vs the run day + 6 (see diagnosisOf for held / not held):
 *   creative        campaign CTR (link clicks ÷ impressions, Newcombe interval) — up = better
 *   auction_cost    account CPM (impressions per ₹, Poisson) — down = better
 *   landing_funnel  campaign visit-to-order (orders ÷ Meta visitors) — up = better
 *   payment         campaign payment success (orders ÷ payments started) — up = better
 *   audience        campaign daily frequency, ±10% = a move — down = better
 *   tracking        product attribution coverage (orders linked to a Meta ad), ±5 points — up = better
 *   learning_edits  share of the campaign's ad sets in LEARNING / FAIL (settings snapshots) — down = better
 *   season_festival a non-neutral calendar row overlapped the week before the run and the
 *                   product's orders per ₹ in it differ significantly from the 14 days before it → held;
 *                   no row or no difference → not held
 *   others          unclear
 */
const FREQ_MOVE = 0.1;
const COVERAGE_MOVE = 0.05;

const sha8 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sums = (q: { from: string; to: string }, m: PmMetrics): PmWindowSums => ({
  from: q.from,
  to: q.to,
  orders: m.firstPartyOrders,
  revenue: m.firstPartyRevenue,
  spend: m.spend,
});
const minus = (a: PmWindowSums, b: PmWindowSums): PmWindowSums => ({
  ...a,
  orders: Math.max(0, a.orders - b.orders),
  revenue: Math.max(0, a.revenue - b.revenue),
  spend: Math.max(0, a.spend - b.spend),
});
/** Significant move with the "good" sign. */
const moveOf = (significant: boolean, diff: number | null, goodSign: 1 | -1): PmMove | null =>
  diff === null ? null : !significant ? 'same' : Math.sign(diff) === goodSign ? 'better' : 'worse';
const relMove = (before: number | null, after: number | null, threshold: number, goodSign: 1 | -1, relative = true) => {
  if (before === null || after === null || (relative && !before)) return null;
  const d = relative ? after / before - 1 : after - before;
  return moveOf(Math.abs(d) >= threshold, d, goodSign);
};

/**
 * Lesson records by code (docs/performance-marketeer/10, "Records"): decision
 * records with their context snapshot, graded outcomes and diagnosis checks,
 * the per-campaign history card and the curator's read-only tools. Reuses
 * the journal's change matching; never writes to Meta.
 */
@Injectable()
export class PmRecordsService {
  private readonly logger = new Logger(PmRecordsService.name);

  constructor(
    @InjectModel(PmAgentRun.name) private readonly runs: Model<PmAgentRun>,
    @InjectModel(PmMetaEntity.name) private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmMetaChange.name) private readonly changeLog: Model<PmMetaChange>,
    @InjectModel(PmMetaDaily.name) private readonly metaDaily: Model<PmMetaDaily>,
    @InjectModel(PmMetaEntitySnapshot.name)
    private readonly snapshots: Model<PmMetaEntitySnapshot>,
    @InjectModel(DecisionModel.name) private readonly decisions: Model<DecisionModel>,
    @InjectModel(OutcomeModel.name) private readonly outcomes: Model<OutcomeModel>,
    @InjectModel(DiagnosisModel.name) private readonly checks: Model<DiagnosisModel>,
    private readonly journal: PmJournalService,
    private readonly situation: PmSituationService,
    private readonly analysis: PmAnalysisService,
    private readonly calendar: PmCalendarTools,
    private readonly dataTools: PmDataTools,
    private readonly creativeTools: PmCreativeTools,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  private get tenantId() {
    return this.env.tenantId;
  }

  /** Daily (code only): decisions of the last 14 days, outcomes due, diagnosis checks of runs 7–14 days old. */
  async daily(date: string) {
    const memo = new Map<string, Promise<unknown>>();
    const decisions = await this.syncDecisions(date, 14, memo);
    const outcomes = await this.gradeDue(date, addDays(date, -GRADE_LOOKBACK_DAYS), memo);
    const diagnosis = await this.diagnose(date, memo);
    return { date, decisions, outcomes, diagnosisChecks: diagnosis };
  }

  /** Past Meta changes in [from, to] → decision records, graded with data through `to`. */
  async bootstrap(from: string, to: string) {
    const memo = new Map<string, Promise<unknown>>();
    const asOf = addDays(to, 1);
    const decisions = await this.syncDecisions(asOf, daysBetween(from, asOf), memo);
    const outcomes = await this.gradeDue(asOf, from, memo);
    return { from, to, decisions, outcomes };
  }

  // ---------------------------------------------------------------- cache

  private cached<T>(memo: Map<string, Promise<unknown>>, key: string, f: () => Promise<T>): Promise<T> {
    if (!memo.has(key)) memo.set(key, f());
    return memo.get(key) as Promise<T>;
  }
  private metrics(memo: Map<string, Promise<unknown>>, q: PmQuery, level: Level | 'account' = 'account', id?: string) {
    return this.cached(memo, `m|${JSON.stringify(q)}|${level}|${id ?? ''}`, () => this.analysis.scopeMetrics(q, level, id));
  }
  private changes(memo: Map<string, Promise<unknown>>, campaignId: string, from: string, to: string) {
    return this.cached(memo, `c|${campaignId}|${from}|${to}`, () => this.journal.changeRows(campaignId, from, to));
  }

  // ---------------------------------------------------------------- (a) decisions

  private async syncDecisions(date: string, days: number, memo: Map<string, Promise<unknown>>) {
    const tenantId = this.tenantId;
    const from = addDays(date, -days);
    const runs = (await this.runs
      .find(
        { tenantId, date: { $gte: from, $lt: date }, 'actions.0': { $exists: true } },
        { files: 0, journal: 0 },
      )
      .lean()) as Run[];
    const range = { $gte: from, $lte: date };
    // Campaigns with a run, a logged change, or spend (spend = snapshot-diff fallback).
    const [logged, spending] = await Promise.all([
      this.changeLog.distinct('campaignId', {
        tenantId,
        eventTime: { $gte: istDayBounds(from).start, $lt: istDayBounds(date).end },
      }),
      this.metaDaily.distinct('campaignId', { tenantId, date: range, spend: { $gt: 0 } }),
    ]);
    const campaigns = [...new Set([...runs.map((r) => r.campaignId), ...logged, ...spending])].filter(Boolean);
    let inserted = 0;
    let updated = 0;
    for (const campaignId of campaigns) {
      const changes = await this.changes(memo, campaignId, addDays(from, -HISTORY_DAYS), date);
      const own = runs.filter((r) => r.campaignId === campaignId);
      const items = buildJournal({
        date: addDays(date, 1), // runs and changes up to and including `date`
        days: days + 1,
        runs: own.map((r) => ({ date: r.date, actions: r.actions ?? [], userNote: r.userNote ?? '' })),
        changes,
        learningEnded: () => true, // read windows are not used here
      });
      const records: Omit<PmDecisionRecord, 'context'>[] = [];
      for (const i of items) {
        if (i.status === 'outside_change') {
          const c = changes.find(
            (x) => +x.at === +(i.changeAt ?? 0) && x.objectId === i.entityId && outsideTitle(x) === i.title,
          );
          if (c) records.push(this.outsideRecord(c, campaignId));
          continue;
        }
        const run = own.find((r) => r.date === i.date);
        const a = run?.actions.find((x) => x.id === i.actionId) as RunAction | undefined;
        if (run && a)
          records.push(this.recommendedRecord(run, a, i.status as 'taken' | 'partly' | 'not_taken', i.changeAt));
      }
      if (!records.length) continue;
      const existing = new Set(
        (await this.decisions.find({ tenantId, decisionId: { $in: records.map((r) => r.decisionId) } }, { decisionId: 1 }).lean()).map(
          (d) => d.decisionId,
        ),
      );
      for (const r of records) {
        if (existing.has(r.decisionId)) {
          // Only what the journal can still learn (taken status inside the match window, your note).
          await this.decisions.updateOne(
            { tenantId, decisionId: r.decisionId },
            { $set: { taken: r.taken, date: r.date, changedAt: r.changedAt, userNote: r.userNote, from: r.from, to: r.to } },
          );
          updated++;
          continue;
        }
        const ctxDate = r.source === 'recommended' ? r.runDate! : r.date;
        const context = await this.cached(memo, `s|${r.entityLevel}|${r.entityId}|${ctxDate}`, () =>
          r.entityLevel === 'site'
            ? this.situation.forCampaign(campaignId, ctxDate)
            : this.situation.forEntity(r.entityLevel as Level, r.entityId, ctxDate),
        );
        await this.decisions.updateOne(
          { tenantId, decisionId: r.decisionId },
          { $setOnInsert: { tenantId, ...r, context } },
          { upsert: true },
        );
        inserted++;
      }
    }
    return { campaigns: campaigns.length, inserted, updated };
  }

  private recommendedRecord(
    run: Run,
    a: RunAction,
    taken: 'taken' | 'partly' | 'not_taken',
    changeAt: Date | null,
  ): Omit<PmDecisionRecord, 'context'> {
    const causes = new Map((run.causes ?? []).map((c) => [c.id, c]));
    const [f, t] = [num(a.change.from), num(a.change.to)];
    const step = f !== null && t !== null && f > 0 ? Math.round((t / f - 1) * 1000) / 1000 : undefined;
    const direction =
      step !== undefined && step !== 0
        ? step > 0
          ? 'up'
          : 'down'
        : a.type === 'pause' || /PAUSED/i.test(String(a.change.to ?? ''))
          ? 'down'
          : /ACTIVE/i.test(String(a.change.to ?? ''))
            ? 'up'
            : undefined;
    return {
      decisionId: `D-${run.date}-${run.campaignId}-${a.id}`,
      source: 'recommended',
      date: changeAt ? istDay(changeAt) : run.date,
      runDate: run.date,
      actionId: a.id,
      campaignId: run.campaignId,
      entityLevel: a.entityLevel,
      entityId: a.entityId,
      entityName: a.entityName,
      type: a.type,
      field: a.change.field,
      from: a.change.from,
      to: a.change.to,
      ...(direction ? { direction } : {}),
      ...(step !== undefined ? { step } : {}),
      taken,
      ...(changeAt ? { changedAt: changeAt.toISOString() } : {}),
      ...(run.userNote ? { userNote: run.userNote } : {}),
      causes: a.causeIds.map((id) => ({
        id,
        category: causes.get(id)?.category ?? '',
        confidence: causes.get(id)?.confidence ?? a.confidence,
      })),
      lessonIds: a.lessonIds ?? run.lessonIds ?? [],
      expected: { metric: a.expectedEffect.metric, low: a.expectedEffect.low, high: a.expectedEffect.high },
    };
  }

  private outsideRecord(c: PmChangeRow, campaignId: string): Omit<PmDecisionRecord, 'context'> {
    const kind = changeKind(c.field);
    const [f, t] = [num(c.oldValue), num(c.newValue)];
    const step = kind === 'budget' && f !== null && t !== null && f > 0 ? Math.round((t / f - 1) * 1000) / 1000 : undefined;
    const direction =
      step !== undefined && step !== 0
        ? step > 0
          ? 'up'
          : 'down'
        : kind === 'status'
          ? /PAUSED/i.test(String(c.newValue ?? ''))
            ? 'down'
            : /ACTIVE/i.test(String(c.newValue ?? ''))
              ? 'up'
              : undefined
          : undefined;
    const day = istDay(c.at);
    return {
      decisionId: `D-${day}-out-${sha8(`${+c.at}|${c.objectId}|${c.field}|${String(c.newValue)}`)}`,
      source: 'outside',
      date: day,
      campaignId: c.campaignId || campaignId,
      entityLevel: levelOf(c),
      entityId: c.objectId,
      entityName: c.objectName || c.objectId,
      type: CHANGE_TYPE[kind],
      field: c.field,
      from: c.oldValue,
      to: c.newValue,
      ...(direction ? { direction } : {}),
      ...(step !== undefined ? { step } : {}),
      taken: 'outside',
      changedAt: c.at.toISOString(),
      causes: [],
      lessonIds: [],
    };
  }

  // ---------------------------------------------------------------- (b) outcomes

  private async gradeDue(date: string, since: string, memo: Map<string, Promise<unknown>>) {
    const tenantId = this.tenantId;
    const due = await this.decisions
      .find({ tenantId, date: { $gte: since, $lte: addDays(date, -4) } })
      .sort({ date: 1 })
      .lean();
    const done = new Set(
      (await this.outcomes.find({ tenantId, decisionId: { $in: due.map((d) => d.decisionId) } }, { decisionId: 1, read: 1 }).lean()).map(
        (o) => `${o.decisionId}|${o.read}`,
      ),
    );
    const counts: Record<string, number> = { early: 0, settled: 0 };
    for (const d of due)
      for (const read of ['early', 'settled'] as const) {
        if (done.has(`${d.decisionId}|${read}`) || !isDue(d.date, date, read)) continue;
        try {
          const o = await this.grade(d, read, date, memo);
          await this.outcomes.updateOne(
            { tenantId, decisionId: d.decisionId, read },
            { $setOnInsert: { tenantId, ...o } },
            { upsert: true },
          );
          counts[read]++;
        } catch (e) {
          this.logger.warn(`grade ${d.decisionId} ${read}: ${(e as Error).message}`);
        }
      }
    return counts;
  }

  /** The entity whose ROAS judges the decision. */
  private async measuredEntity(d: PmDecisionRecord): Promise<{ level: Level; id: string }> {
    if (d.entityLevel === 'site' || (d.type === 'pause' && d.entityLevel !== 'campaign'))
      return { level: 'campaign', id: d.campaignId };
    if (d.entityLevel === 'ad' && d.type === 'creative') {
      // New ads have no "before": judge their ad set.
      const ad = await this.entities.findOne({ tenantId: this.tenantId, level: 'ad', entityId: d.entityId }, { adsetId: 1 }).lean();
      if (ad?.adsetId) return { level: 'adset', id: ad.adsetId };
    }
    return { level: d.entityLevel as Level, id: d.entityId };
  }

  private async grade(
    d: PmDecisionRecord,
    read: 'early' | 'settled',
    date: string,
    memo: Map<string, Promise<unknown>>,
  ): Promise<PmOutcomeRecord> {
    const { before, after } = windowsFor(d.date, read);
    const m = await this.measuredEntity(d);
    const product = findPmProduct(d.context?.product ?? '') ? d.context.product : undefined;
    const [eb, ea, ab, aa, cb, ca] = await Promise.all([
      this.metrics(memo, before, m.level, m.id),
      this.metrics(memo, after, m.level, m.id),
      this.metrics(memo, before),
      this.metrics(memo, after),
      this.metrics(memo, before, 'campaign', d.campaignId),
      this.metrics(memo, after, 'campaign', d.campaignId),
    ]);
    // Baseline: the rest of the account (covered products) without this campaign.
    const camp = await this.entities.findOne({ tenantId: this.tenantId, level: 'campaign', entityId: d.campaignId }, { product: 1 }).lean();
    const inAccount = Boolean(findPmProduct(camp?.product ?? ''));
    const baseBefore = inAccount ? minus(sums(before, ab), sums(before, cb)) : sums(before, ab);
    const baseAfter = inAccount ? minus(sums(after, aa), sums(after, ca)) : sums(after, aa);

    const confounders = await this.confounders(d, m, before.from, after.to, product, memo);
    return {
      decisionId: d.decisionId,
      ...gradeOutcome({
        decision: d,
        read,
        before: sums(before, eb),
        after: sums(after, ea),
        baseBefore,
        baseAfter,
        confounders,
        quality: d.source === 'recommended' ? await this.quality(d) : null,
      }),
      weak: d.taken === 'not_taken',
      gradedAt: date,
    };
  }

  private async confounders(
    d: PmDecisionRecord,
    m: { level: Level; id: string },
    from: string,
    to: string,
    product: string | undefined,
    memo: Map<string, Promise<unknown>>,
  ) {
    const all = await this.changes(memo, d.campaignId, addDays(from, -HISTORY_DAYS), to);
    const inWindow = all.filter((c) => {
      const day = istDay(c.at);
      return day >= from && day <= to;
    });
    const ownKind = changeKind(d.field);
    const touchesDecision = (c: PmChangeRow) =>
      c.objectId === d.entityId || c.adsetId === d.entityId || c.campaignId === d.entityId;
    const own = (c: PmChangeRow) => istDay(c.at) === d.date && touchesDecision(c) && changeKind(c.field) === ownKind;
    // Same entity, its parents or children; at campaign level, anything in the campaign.
    const related = (c: PmChangeRow) =>
      m.level === 'campaign' || touchesDecision(c) || c.objectId === m.id || c.adsetId === m.id || c.objectId === d.campaignId;
    const others = inWindow.filter((c) => !own(c) && related(c));
    const before = { from, to: addDays(d.date, -1) };
    const after = { from: addDays(d.date, 1), to };
    const [missing, covB, covA] = await Promise.all([
      this.cached(memo, `md|${from}|${to}`, () => this.analysis.metaMissingDays(from, to)),
      this.cached(memo, `cov|${JSON.stringify(before)}|${product}`, () => this.analysis.coverage({ ...before, product })),
      this.cached(memo, `cov|${JSON.stringify(after)}|${product}`, () => this.analysis.coverage({ ...after, product })),
    ]);
    return confoundersOf({
      otherEdits: others.length,
      resetByOther: others.some((c) => resetsLearning(c, all)),
      missingDays: missing.length,
      coverageBefore: covB.linkedToMetaAd,
      coverageAfter: covA.linkedToMetaAd,
      seasonEdges: seasonEdges(this.calendar.query(from, to, ALL_KINDS), from, to).length,
    });
  }

  private async quality(d: PmDecisionRecord) {
    const run = (await this.runs
      .findOne({ tenantId: this.tenantId, campaignId: d.campaignId, date: d.runDate }, { actions: 1, causes: 1 })
      .lean()) as Run | null;
    const a = run?.actions.find((x) => x.id === d.actionId);
    if (!run || !a) return null;
    const verdict = new Map((run.causes ?? []).map((c) => [c.id, c.verdict ?? '']));
    const disputedCause = (run.causes ?? []).some((c) => a.causeIds.includes(c.id) && c.disputed);
    return {
      checksFailed: a.checksFailed ?? [],
      causeVerdicts: a.causeIds.map((id) => verdict.get(id) ?? '').filter(Boolean),
      disputed: Boolean(a.disputed) || disputedCause,
    };
  }

  // ---------------------------------------------------------------- (c) diagnosis checks

  private async diagnose(date: string, memo: Map<string, Promise<unknown>>) {
    const tenantId = this.tenantId;
    const runs = (await this.runs
      .find({ tenantId, status: 'done', date: { $gte: addDays(date, -14), $lte: addDays(date, -7) } }, { files: 0, journal: 0 })
      .lean()) as Run[];
    let written = 0;
    for (const run of runs) {
      const causes = run.causes ?? [];
      if (!causes.length) continue;
      const ids = causes.map((c) => `DC-${run.date}-${run.campaignId}-${c.id}`);
      const have = new Set((await this.checks.find({ tenantId, checkId: { $in: ids } }, { checkId: 1 }).lean()).map((c) => c.checkId));
      const fixes = await this.decisions
        .find(
          { tenantId, campaignId: run.campaignId, runDate: run.date, source: 'recommended', taken: { $in: ['taken', 'partly'] } },
          { causes: 1 },
        )
        .lean();
      const lessonIds = run.lessonIds ?? [...new Set(run.actions.flatMap((a) => (a as RunAction).lessonIds ?? []))];
      for (const c of causes) {
        const checkId = `DC-${run.date}-${run.campaignId}-${c.id}`;
        if (have.has(checkId)) continue;
        const fixed = fixes.some((f) => f.causes.some((x) => x.id === c.id));
        const { result, note } = await this.checkCause(run, c.category, fixed, memo);
        const doc: PmDiagnosisCheck = {
          checkId,
          runDate: run.date,
          campaignId: run.campaignId,
          causeId: c.id,
          category: c.category,
          confidence: c.confidence,
          result,
          note,
          lessonIds,
          checkedAt: date,
        };
        await this.checks.updateOne({ tenantId, checkId }, { $setOnInsert: { tenantId, ...doc } }, { upsert: true });
        written++;
      }
    }
    return written;
  }

  private async checkCause(
    run: Run,
    category: string,
    fixed: boolean,
    memo: Map<string, Promise<unknown>>,
  ): Promise<{ result: PmDiagnosisCheck['result']; note: string }> {
    const before = { from: addDays(run.date, -7), to: addDays(run.date, -1) };
    const after = { from: run.date, to: addDays(run.date, 6) };
    const cid = run.campaignId;
    const camp = () => Promise.all([this.metrics(memo, before, 'campaign', cid), this.metrics(memo, after, 'campaign', cid)]);
    const prop = (b: { k: number; n: number }, a: { k: number; n: number }, goodSign: 1 | -1) => {
      if (!(b.n > 0 && a.n > 0)) return null;
      const r = compareProportions({ k: Math.min(a.k, a.n), n: a.n }, { k: Math.min(b.k, b.n), n: b.n });
      return moveOf(r.verdict === 'significant', r.diff, goodSign);
    };
    const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(2)}%`);
    const done = (move: PmMove | null, what: string) => ({
      result: diagnosisOf(fixed, move),
      note: `${what}; ${fixed ? 'a fix was taken' : 'no fix taken'} → ${move ?? 'no data'}`,
    });
    switch (category) {
      case 'creative': {
        const [b, a] = await camp();
        return done(prop({ k: b.linkClicks, n: b.impressions }, { k: a.linkClicks, n: a.impressions }, 1), `CTR ${pct(b.ctr)} → ${pct(a.ctr)}`);
      }
      case 'auction_cost': {
        const [b, a] = await Promise.all([this.metrics(memo, before), this.metrics(memo, after)]);
        if (!(b.spend > 0 && a.spend > 0)) return done(null, 'account CPM: no spend');
        const r = comparePoisson({ count: a.impressions, exposure: a.spend }, { count: b.impressions, exposure: b.spend });
        // More impressions per ₹ = CPM down = better.
        return done(moveOf(r.verdict === 'significant', r.diff, 1), `account CPM ₹${b.cpm?.toFixed(0)} → ₹${a.cpm?.toFixed(0)}`);
      }
      case 'landing_funnel': {
        const [b, a] = await camp();
        return done(
          prop({ k: b.firstPartyOrders, n: b.siteVisitors }, { k: a.firstPartyOrders, n: a.siteVisitors }, 1),
          `visit-to-order ${pct(b.visitToOrderRate)} → ${pct(a.visitToOrderRate)}`,
        );
      }
      case 'payment': {
        const [b, a] = await camp();
        return done(
          prop({ k: b.firstPartyOrders, n: b.sitePaymentsStarted }, { k: a.firstPartyOrders, n: a.sitePaymentsStarted }, 1),
          `orders ÷ payments started ${b.firstPartyOrders}/${b.sitePaymentsStarted} → ${a.firstPartyOrders}/${a.sitePaymentsStarted}`,
        );
      }
      case 'audience': {
        const [b, a] = await camp();
        return done(relMove(b.frequency, a.frequency, FREQ_MOVE, -1), `daily frequency ${b.frequency?.toFixed(2)} → ${a.frequency?.toFixed(2)}`);
      }
      case 'tracking': {
        const product = findPmProduct(run.product) ? run.product : undefined;
        const [b, a] = await Promise.all([this.analysis.coverage({ ...before, product }), this.analysis.coverage({ ...after, product })]);
        return done(
          relMove(b.linkedToMetaAd, a.linkedToMetaAd, COVERAGE_MOVE, 1, false),
          `orders linked to a Meta ad ${pct(b.linkedToMetaAd)} → ${pct(a.linkedToMetaAd)}`,
        );
      }
      case 'learning_edits': {
        const share = async (day: string) => {
          const rows = await this.snapshots
            .find({ tenantId: this.tenantId, campaignId: cid, level: 'adset', date: day, status: 'ACTIVE' }, { learningStage: 1 })
            .lean();
          return rows.length ? rows.filter((r) => r.learningStage === 'LEARNING' || r.learningStage === 'FAIL').length / rows.length : null;
        };
        const [b, a] = await Promise.all([share(before.to), share(after.to)]);
        return done(
          b === null || a === null ? null : moveOf(a !== b, a - b, -1),
          `ad sets learning / limited ${pct(b)} → ${pct(a)}`,
        );
      }
      case 'season_festival': {
        const rows = this.calendar.query(before.from, before.to, ALL_KINDS).filter((r) => r.mood !== 'neutral');
        if (!rows.length) return { result: 'not_held', note: 'no calendar row in the week before the run' };
        const r = rows[0];
        const product = findPmProduct(run.product) ? run.product : undefined;
        const during = { from: r.start > before.from ? r.start : before.from, to: r.end < before.to ? r.end : before.to, product };
        const prior = { from: addDays(r.start, -14), to: addDays(r.start, -1), product };
        const [m1, m0] = await Promise.all([this.metrics(memo, during), this.metrics(memo, prior)]);
        if (!(m1.spend > 0 && m0.spend > 0)) return { result: 'unclear', note: `${r.id}: no spend to compare` };
        const t = comparePoisson({ count: m1.firstPartyOrders, exposure: m1.spend }, { count: m0.firstPartyOrders, exposure: m0.spend });
        return {
          result: t.verdict === 'significant' ? 'held' : 'not_held',
          note: `${r.id}: orders per ₹1k ${(t.rateA * 1000).toFixed(2)} vs ${(t.rateB * 1000).toFixed(2)} in the 14 days before (${t.verdict})`,
        };
      }
      default:
        return { result: 'unclear', note: `no follow-up metric for ${category}` };
    }
  }

  // ---------------------------------------------------------------- history card

  /** campaigns/<id>/history.md, rendered by code (no AI summary). */
  async historyMarkdown(campaignId: string, date: string): Promise<string> {
    const tenantId = this.tenantId;
    const [camp, decisions] = await Promise.all([
      this.entities.findOne({ tenantId, level: 'campaign', entityId: campaignId }).lean(),
      this.decisions.find({ tenantId, campaignId, date: { $lt: date } }).sort({ date: -1, decisionId: 1 }).lean(),
    ]);
    const outs = await this.outcomes.find({ tenantId, decisionId: { $in: decisions.map((d) => d.decisionId) } }).lean();
    const latest = new Map<string, OutcomeModel>();
    for (const o of outs) if (!latest.has(o.decisionId) || o.read === 'settled') latest.set(o.decisionId, o);

    const weeks = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const q = { from: addDays(date, -7 * (i + 1)), to: addDays(date, -7 * i - 1) };
        return this.analysis.scopeMetrics(q, 'campaign', campaignId).then((m) => ({ q, m }));
      }),
    );
    const live = weeks.filter((w) => w.m.spend > 0 && w.m.firstPartyRoas !== null);
    const best = live.reduce<(typeof live)[number] | null>((x, w) => (!x || w.m.firstPartyRoas! > x.m.firstPartyRoas! ? w : x), null);
    const worst = live.reduce<(typeof live)[number] | null>((x, w) => (!x || w.m.firstPartyRoas! < x.m.firstPartyRoas! ? w : x), null);
    const roas = (x: number | null) => (x === null ? '–' : x.toFixed(2));

    const lines = [
      `# History — ${camp?.name || campaignId} (${campaignId}), as of ${dayLabel(date)}`,
      '',
      `Launched ${camp?.createdTime ? istDay(camp.createdTime) : 'unknown'} · ${structureOf(camp?.budgetLevel ?? '', camp?.name ?? '')} · ` +
        `${camp?.objective || 'objective unknown'} · product ${camp?.product ?? 'other'} · status ${camp?.status || '–'}`,
      '',
      '## Weekly first-party ROAS (last 8 weeks)',
      '| Week | Spend | Orders | ROAS | CPA |',
      '|---|---|---|---|---|',
      ...weeks.map(
        ({ q, m }) =>
          `| ${q.from} → ${q.to}${w(best, q) ? ' (best)' : w(worst, q) ? ' (worst)' : ''} | ${inr(m.spend)} | ${m.firstPartyOrders} | ${roas(m.firstPartyRoas)} | ${m.firstPartyCpa === null ? '–' : inr(m.firstPartyCpa)} |`,
      ),
      '',
      `## Decisions (${decisions.length}, newest first)`,
      ...(decisions.length
        ? decisions.map((d) => {
            const o = latest.get(d.decisionId);
            const what = `${d.type} on ${d.entityLevel} "${d.entityName}"${d.field ? `: ${d.field} ${d.from ?? '–'} → ${d.to ?? '–'}` : ''}`;
            const verdict = o ? `${o.verdict} (${o.read}${o.weak ? ', weak' : ''}, DiD ${roas(o.diffInDiff.roas)})` : 'not graded yet';
            const lessons = d.lessonIds.length ? ` · lessons ${d.lessonIds.join(', ')}` : '';
            return `- ${d.date} · ${d.actionId ? `${d.actionId} ` : ''}${what} — ${d.taken.replace('_', ' ')} · ${verdict}${lessons}`;
          })
        : ['- none recorded']),
      '',
      '## Lessons cited',
      [...new Set(decisions.flatMap((d) => d.lessonIds))].join(', ') || 'none',
      '',
    ];
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- curator tools

  /** Read-only tools for the weekly curator. */
  curatorDefs(): PmToolDef[] {
    const t = this.tenantId;
    const limit = z.number().int().min(1).max(500).default(200);
    const decisionsByIds = async (ids: string[]) =>
      new Map((await this.decisions.find({ tenantId: t, decisionId: { $in: ids } }).lean()).map((d) => [d.decisionId, d]));
    const strip = <T extends { _id?: unknown; __v?: unknown; tenantId?: unknown; createdAt?: unknown; updatedAt?: unknown }>(x: T) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, __v, tenantId, createdAt, updatedAt, ...rest } = x;
      return rest;
    };
    const reuse = (defs: PmToolDef[], name: string) => {
      const d = defs.find((x) => x.name === name);
      if (!d) throw new Error(`tool ${name} not found`);
      return d;
    };
    const asCampaign = (ctx: PmToolCtx, campaignId: string, date: string): PmToolCtx => ({ ...ctx, campaignId, date });
    return [
      {
        name: 'decisions',
        description:
          'Decision records (ours = recommended, or outside changes from the Meta log) with their context snapshot (PmSituation), causes, lessons used and expected effect. Filters optional.',
        shape: {
          since: DAY.optional(),
          until: DAY.optional(),
          campaignId: z.string().optional(),
          source: z.enum(['recommended', 'outside']).optional(),
          type: z.string().optional(),
          taken: z.enum(['taken', 'partly', 'not_taken', 'outside']).optional(),
          limit,
        },
        run: async (a: { since?: string; until?: string; campaignId?: string; source?: string; type?: string; taken?: string; limit?: number }) => {
          const q: Record<string, unknown> = { tenantId: t };
          if (a.since || a.until) q.date = { ...(a.since ? { $gte: a.since } : {}), ...(a.until ? { $lte: a.until } : {}) };
          for (const k of ['campaignId', 'source', 'type', 'taken'] as const) if (a[k]) q[k] = a[k];
          const rows = await this.decisions.find(q).sort({ date: -1 }).limit(a.limit ?? 200).lean();
          return { rows: rows.map(strip) };
        },
      },
      {
        name: 'outcomes',
        description:
          'Graded outcomes (early = day 3, settled = day 7): before/after first-party ROAS of the touched entity vs the baseline, difference-in-differences with a 95% interval, verdict, confounders, prediction check and decision quality — each with its decision (type, entity, context). weak = a not-taken recommendation (never teaches on its own).',
        shape: {
          since: DAY.optional().describe('graded on or after'),
          verdict: z.enum(['worked', 'no_effect', 'hurt', 'inconclusive', 'contaminated']).optional(),
          read: z.enum(['early', 'settled']).optional(),
          limit,
        },
        run: async (a: { since?: string; verdict?: string; read?: string; limit?: number }) => {
          const q: Record<string, unknown> = { tenantId: t };
          if (a.since) q.gradedAt = { $gte: a.since };
          if (a.verdict) q.verdict = a.verdict;
          if (a.read) q.read = a.read;
          const rows = await this.outcomes.find(q).sort({ gradedAt: -1 }).limit(a.limit ?? 200).lean();
          const ds = await decisionsByIds(rows.map((r) => r.decisionId));
          return {
            rows: rows.map((r) => {
              const d = ds.get(r.decisionId);
              return {
                ...strip(r),
                decision: d && {
                  source: d.source,
                  campaignId: d.campaignId,
                  type: d.type,
                  field: d.field,
                  direction: d.direction,
                  step: d.step,
                  entityLevel: d.entityLevel,
                  entityName: d.entityName,
                  taken: d.taken,
                  context: d.context,
                  causes: d.causes,
                  lessonIds: d.lessonIds,
                  expected: d.expected,
                },
              };
            }),
          };
        },
      },
      {
        name: 'diagnosis_checks',
        description:
          'Did the causes the analyst named hold up a week later (held / not_held / unclear, with the follow-up metric in note)? Optional category filter.',
        shape: { since: DAY.optional().describe('checked on or after'), category: z.string().optional(), limit },
        run: async (a: { since?: string; category?: string; limit?: number }) => {
          const q: Record<string, unknown> = { tenantId: t };
          if (a.since) q.checkedAt = { $gte: a.since };
          if (a.category) q.category = a.category;
          return { rows: (await this.checks.find(q).sort({ checkedAt: -1 }).limit(a.limit ?? 200).lean()).map(strip) };
        },
      },
      {
        name: 'rejections',
        description: "Recommendations you did not take and left a note on (the run's note) — material for analyst-habit lessons.",
        shape: { since: DAY },
        run: async (a: { since: string }) => {
          const rows = await this.decisions
            .find({ tenantId: t, source: 'recommended', taken: 'not_taken', date: { $gte: a.since }, userNote: { $nin: [null, ''] } })
            .sort({ date: -1 })
            .limit(200)
            .lean();
          return {
            rows: rows.map((d) => ({
              decisionId: d.decisionId,
              date: d.date,
              campaignId: d.campaignId,
              type: d.type,
              entityLevel: d.entityLevel,
              entityName: d.entityName,
              change: `${d.field} ${d.from ?? '–'} → ${d.to ?? '–'}`,
              userNote: d.userNote,
              context: d.context,
            })),
          };
        },
      },
      {
        name: 'verifier_catches',
        description:
          "Issues the verifiers raised (02-verify / 04-plan-verify, every round) in finished runs since a date: id, severity, target cause/action, claim — material for analyst-habit lessons (what the investigator / planner keeps getting wrong). Also each run's unresolved list.",
        shape: { since: DAY },
        run: async (a: { since: string }) => {
          const rows = await this.runs
            .find({ tenantId: t, status: 'done', date: { $gte: a.since } }, { date: 1, campaignId: 1, files: 1, unresolved: 1 })
            .sort({ date: -1 })
            .limit(200)
            .lean();
          return { rows: rows.map((r) => ({ date: r.date, campaignId: r.campaignId, issues: verifierIssues(r.files ?? {}), unresolved: r.unresolved })) };
        },
      },
      {
        name: 'measure_segment',
        description:
          "Code-computed breakdown of one campaign's ad sets (region / age_gender / placement / device) between two days: spend share, CPM, CTR, Meta ROAS, and for region first-party orders/ROAS by state. Use to check a segment_fact claim. Read missingDays.",
        shape: {
          campaignId: z.string(),
          breakdown: z.enum(['region', 'age_gender', 'placement', 'device']).default('region'),
          from: DAY,
          to: DAY,
        },
        run: async (a: { campaignId: string; breakdown?: string; from: string; to: string }, ctx: PmToolCtx) =>
          reuse(this.dataTools.defs(), 'breakdowns').run(
            { breakdown: a.breakdown ?? 'region', from: a.from, to: a.to },
            asCampaign(ctx, a.campaignId, addDays(a.to, 1)),
          ),
      },
      {
        name: 'measure_creative',
        description:
          "Code-computed per-ad metrics of one campaign over the 7 and 14 days before `date`: CTR, CPM, frequency, hook rate, hold rate, first-party orders/ROAS, CTR fatigue flag. Use to check a creative_pattern claim (compare ads by type / hook / language).",
        shape: { campaignId: z.string(), date: DAY.describe('data runs to the day before') },
        run: async (a: { campaignId: string; date: string }, ctx: PmToolCtx) =>
          reuse(this.creativeTools.defs(), 'creative_metrics').run({}, asCampaign(ctx, a.campaignId, a.date)),
      },
      {
        name: 'measure_season',
        description:
          'Code-computed season / market effect: Meta-attributed first-party orders, ROAS, CPM and spend for a date window (e.g. a calendar row) vs the same-length window just before, with a Poisson test on orders per ₹ and on orders per day. Optional product. Lists the calendar rows overlapping the window.',
        shape: { from: DAY, to: DAY, product: z.string().optional() },
        run: async (a: { from: string; to: string; product?: string }) => {
          if (a.from > a.to) throw new Error('from must be <= to');
          const cur = { from: a.from, to: a.to, ...(a.product ? { product: a.product } : {}) };
          const prev = { ...previousPeriod(a.from, a.to), ...(a.product ? { product: a.product } : {}) };
          const [m1, m0] = await Promise.all([this.analysis.scopeMetrics(cur), this.analysis.scopeMetrics(prev)]);
          const days = daysBetween(a.from, a.to) + 1;
          const brief = (m: PmMetrics) => ({
            spend: Math.round(m.spend),
            orders: m.firstPartyOrders,
            revenue: Math.round(m.firstPartyRevenue),
            roas: m.firstPartyRoas,
            cpm: m.cpm,
          });
          return {
            window: cur,
            before: prev,
            during: brief(m1),
            prior: brief(m0),
            ordersPerSpend:
              m1.spend > 0 && m0.spend > 0
                ? comparePoisson({ count: m1.firstPartyOrders, exposure: m1.spend }, { count: m0.firstPartyOrders, exposure: m0.spend })
                : null,
            ordersPerDay: comparePoisson({ count: m1.firstPartyOrders, exposure: days }, { count: m0.firstPartyOrders, exposure: days }),
            cpmChange: m1.cpm !== null && m0.cpm ? Math.round((m1.cpm / m0.cpm - 1) * 1000) / 1000 : null,
            calendar: this.calendar.query(a.from, a.to, ALL_KINDS).map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end, mood: r.mood })),
          };
        },
      },
    ];
  }
}

const w = (x: { q: { from: string } } | null, q: { from: string }) => Boolean(x && x.q.from === q.from);

const ISSUE_LINE = /^- (I\d+) · (blocker|major|minor)(?: · on (\S+))? — (.*)$/;

/**
 * Verifier issues from a run's files: the phase JSON (`*.md.json`) when it
 * was copied, else the code-written "### Issues" lines of the .md.
 */
export function verifierIssues(files: Record<string, string>) {
  const out: { file: string; id: string; severity: string; target: string; claim: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    const m = /^(02-verify|04-plan-verify)\.v\d+\.md(\.json)?$/.exec(file);
    if (!m) continue;
    if (m[2]) {
      try {
        for (const i of (JSON.parse(text).issues ?? []) as { id: string; severity: string; target: string; claim: string }[])
          out.push({ file, id: i.id, severity: i.severity, target: i.target, claim: i.claim });
      } catch {
        /* cut or invalid JSON: fall back to the .md */
      }
      continue;
    }
    if (files[`${file}.json`]) continue;
    const at = text.indexOf('### Issues');
    if (at < 0) continue;
    for (const line of text.slice(at).split('\n').slice(1)) {
      if (line.startsWith('###')) break;
      const x = ISSUE_LINE.exec(line);
      if (x) out.push({ file, id: x[1], severity: x[2], target: x[3] ?? '', claim: x[4].slice(0, 400) });
    }
  }
  return out;
}
