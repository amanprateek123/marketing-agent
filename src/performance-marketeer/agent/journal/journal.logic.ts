/**
 * Day-to-day memory (docs/performance-marketeer/09, "Day-to-day memory"):
 * pure rules that match our past recommendations to what changed in Meta,
 * pick the read window, and write 00-journal.md. No I/O (journal.logic.spec.ts).
 */
import { DAY_MS, IST_OFFSET_MS } from '../../pm.config';
import { istDay, istDayBounds } from '../../pm.logic';
import { addDays } from '../../analysis/pm-stats';
import type { PmChangeValue } from '../../sync/meta.logic';
import type { Action, PmJournalEntry } from '../pm-agent.types';

/** One Meta change, from the activity log or (fallback) a day-to-day settings diff. */
export interface PmChangeRow {
  at: Date;
  objectType: string;
  objectId: string;
  objectName: string;
  campaignId: string;
  adsetId: string;
  eventType: string;
  field: string;
  oldValue: PmChangeValue;
  newValue: PmChangeValue;
  actorName: string;
  applicationName: string;
  source: 'log' | 'snapshot';
}

export interface PmPastRun {
  date: string;
  actions: Action[];
  userNote: string;
}

export type PmLevelName = 'campaign' | 'adset' | 'ad';

/** A journal entry plus what the service needs to compute its result. */
export interface PmJournalItem extends PmJournalEntry {
  entityId: string;
  entityName: string;
  level: PmLevelName;
  /** First matched change (null = nothing changed). */
  changeAt: Date | null;
}

export interface PmSnapshotRow {
  entityId: string;
  level: PmLevelName;
  date: string;
  name: string;
  campaignId: string;
  adsetId: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  bidStrategy: string;
  targetingSummary: unknown;
  creativeId: string;
}

export const MATCH_WINDOW_MS = 72 * 3_600_000;
/** Budget change share above which Meta re-enters learning. */
export const BIG_BUDGET_STEP = 0.2;
/** Planned vs actual budget step within this (share points) counts as the same size. */
const SAME_SIZE = 0.05;
/** A pause at least this long makes the unpause a learning reset. */
const LONG_PAUSE_MS = 7 * DAY_MS;

type Kind = 'budget' | 'status' | 'creative' | 'targeting' | 'bid' | 'other';

export function changeKind(field: string): Kind {
  if (/budget/.test(field)) return 'budget';
  if (field === 'status') return 'status';
  if (field === 'created' || field === 'creative') return 'creative';
  if (field === 'targeting') return 'targeting';
  if (/^bid|optimization_goal/.test(field)) return 'bid';
  return 'other';
}

/** What kind of Meta change would carry out this action ('hold' = none; 'offmeta' = not visible in Meta). */
export function actionKind(a: Action): Kind | 'hold' | 'offmeta' {
  const f = a.change?.field ?? '';
  if (a.type === 'hold') return 'hold';
  if (a.type === 'budget' || /budget/.test(f)) return 'budget';
  if (a.type === 'pause' || /status/.test(f)) return 'status';
  if (a.type === 'creative') return 'creative';
  if (/bid/.test(f)) return 'bid';
  if (['audience', 'geo', 'placement'].includes(a.type) || /target/.test(f))
    return 'targeting';
  return 'offmeta';
}

const num = (v: unknown) =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
    ? null
    : Number(v);
const upper = (v: unknown) => String(v ?? '').toUpperCase();

export function levelOf(c: PmChangeRow): PmLevelName {
  if (c.objectId && c.objectId === c.campaignId) return 'campaign';
  if (c.objectId && c.objectId === c.adsetId) return 'adset';
  if (!c.campaignId) {
    if (/AD_?SET/i.test(c.objectType)) return 'adset';
    if (/CAMPAIGN/i.test(c.objectType)) return 'campaign';
  }
  return 'ad';
}

/** Does this change reset learning? `history` = other changes, for the unpause-after-long-pause rule. */
export function resetsLearning(c: PmChangeRow, history: PmChangeRow[]) {
  const kind = changeKind(c.field);
  if (kind === 'creative' || kind === 'targeting' || kind === 'bid')
    return true;
  if (kind === 'budget') {
    const o = num(c.oldValue);
    const n = num(c.newValue);
    return (
      o !== null && n !== null && o > 0 && Math.abs(n / o - 1) > BIG_BUDGET_STEP
    );
  }
  if (kind === 'status' && /ACTIVE/.test(upper(c.newValue))) {
    const paused = history
      .filter(
        (h) =>
          h.objectId === c.objectId &&
          h.field === 'status' &&
          /PAUSED/.test(upper(h.newValue)) &&
          h.at < c.at,
      )
      .sort((a, b) => +b.at - +a.at)[0];
    return Boolean(paused && +c.at - +paused.at >= LONG_PAUSE_MS);
  }
  return false;
}

/** Whole IST days from `from` to `to` (YYYY-MM-DD). */
export const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );

/**
 * Read window on `date` for a change made on `changeDay`: < 2 days too soon,
 * day 2–6 early, ≥ 7 settled. A learning reset is not read before learning
 * ends (learningEnded) or day 7.
 */
export function readOf(
  changeDay: string,
  date: string,
  resets: boolean,
  learningEnded: boolean,
): { read: PmJournalEntry['read']; judgeAgainOn?: string; day: number } {
  const day = daysBetween(changeDay, date);
  if (day >= 7) return { read: 'settled', day };
  if (resets && !learningEnded)
    return { read: 'too_soon', judgeAgainOn: addDays(changeDay, 7), day };
  if (day < 2)
    return { read: 'too_soon', judgeAgainOn: addDays(changeDay, 2), day };
  return { read: 'early', judgeAgainOn: addDays(changeDay, 7), day };
}

/** How one change relates to one action: taken, partly (same direction, other size / child entity), or no match. */
export function matchChange(
  a: Action,
  c: PmChangeRow,
): 'taken' | 'partly' | null {
  const kind = actionKind(a);
  if (kind === 'hold' || kind === 'offmeta' || changeKind(c.field) !== kind)
    return null;
  const direct = c.objectId === a.entityId;
  const child =
    !direct &&
    a.entityLevel !== 'ad' &&
    (c.adsetId === a.entityId || c.campaignId === a.entityId);
  if (!direct && !child) return null;
  let verdict: 'taken' | 'partly' = 'taken';
  if (kind === 'budget') {
    const [pf, pt, cf, ct] = [
      a.change.from,
      a.change.to,
      c.oldValue,
      c.newValue,
    ].map(num);
    if (
      cf !== null &&
      ct !== null &&
      pf !== null &&
      pt !== null &&
      pf > 0 &&
      cf > 0
    ) {
      if (Math.sign(pt - pf) !== Math.sign(ct - cf)) return null;
      if (Math.abs(pt / pf - ct / cf) > SAME_SIZE) verdict = 'partly';
    }
  }
  if (kind === 'status') {
    const want = upper(a.change.to) || (a.type === 'pause' ? 'PAUSED' : '');
    if (want && !upper(c.newValue).includes(want)) return null;
  }
  // A new ad inside the ad set is exactly the creative action; anything else on a child is partial.
  if (child && kind !== 'creative') verdict = 'partly';
  return verdict;
}

const IST = (d: Date) => new Date(+d + IST_OFFSET_MS);
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** "1 Nov" from YYYY-MM-DD. */
export const dayLabel = (day: string) =>
  `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
/** "25 Oct 14:02" (IST). */
export const timeLabel = (d: Date) =>
  `${dayLabel(istDay(d))} ${IST(d).toISOString().slice(11, 16)}`;

/** ₹ with Indian grouping, whole rupees. */
export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

const LEVEL_WORD: Record<PmLevelName, string> = {
  campaign: 'campaign',
  adset: 'ad set',
  ad: 'ad',
};

const valueText = (field: string, v: PmChangeValue) =>
  v === null
    ? '?'
    : /budget/.test(field) && num(v) !== null
      ? inr(Number(v))
      : String(v);

/** "Meta log 25 Oct 14:02, ₹10,000 → ₹8,000". */
export function describeChange(c: PmChangeRow): string {
  const src = c.source === 'log' ? 'Meta log' : 'settings snapshot';
  const when = c.source === 'log' ? timeLabel(c.at) : dayLabel(istDay(c.at));
  const what =
    c.oldValue === null && c.newValue === null
      ? c.field.replace(/_/g, ' ')
      : `${c.field.replace(/_/g, ' ')} ${valueText(c.field, c.oldValue)} → ${valueText(c.field, c.newValue)}`;
  const target = `${LEVEL_WORD[levelOf(c)]} "${c.objectName || c.objectId}"`;
  return `${src} ${when}, ${target} ${what}${actorText(c)}`;
}

const actorText = (c: PmChangeRow) => {
  const who = [c.actorName, c.applicationName && `via ${c.applicationName}`]
    .filter(Boolean)
    .join(' ');
  return who ? ` by ${who}` : '';
};

/** Plain title for a change we did not recommend. */
export function outsideTitle(c: PmChangeRow): string {
  const target = `${LEVEL_WORD[levelOf(c)]} "${c.objectName || c.objectId}"`;
  const kind = changeKind(c.field);
  let what: string;
  if (c.field === 'created') what = `new ${target} created`;
  else if (
    kind === 'budget' ||
    kind === 'status' ||
    c.oldValue !== null ||
    c.newValue !== null
  )
    what = `${target} ${c.field.replace(/_/g, ' ')} ${valueText(c.field, c.oldValue)} → ${valueText(c.field, c.newValue)}`;
  else what = `${target} ${c.field.replace(/_/g, ' ')} changed`;
  return `outside change: ${what}${actorText(c)}`;
}

/** Day-to-day settings diffs (fallback when the activity log has nothing). Rows sorted by date. */
export function snapshotDiffs(rows: PmSnapshotRow[]): PmChangeRow[] {
  const out: PmChangeRow[] = [];
  const last = new Map<string, PmSnapshotRow>();
  const fields: [keyof PmSnapshotRow, string][] = [
    ['status', 'status'],
    ['dailyBudget', 'daily_budget'],
    ['lifetimeBudget', 'lifetime_budget'],
    ['bidStrategy', 'bid_strategy'],
    ['targetingSummary', 'targeting'],
    ['creativeId', 'creative'],
  ];
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const prev = last.get(r.entityId);
    last.set(r.entityId, r);
    if (!prev) continue;
    for (const [k, field] of fields) {
      const o = prev[k];
      const n = r[k];
      if (JSON.stringify(o ?? null) === JSON.stringify(n ?? null)) continue;
      const v = (x: unknown): PmChangeValue =>
        x === null || x === undefined || x === ''
          ? null
          : typeof x === 'object'
            ? JSON.stringify(x).slice(0, 300)
            : (x as string | number);
      out.push({
        at: istDayBounds(r.date).start,
        objectType: r.level.toUpperCase(),
        objectId: r.entityId,
        objectName: r.name,
        campaignId: r.campaignId,
        adsetId: r.adsetId,
        eventType: `snapshot_${field}`,
        field,
        oldValue: v(o),
        newValue: v(n),
        actorName: '',
        applicationName: '',
        source: 'snapshot',
      });
    }
  }
  return out;
}

/**
 * Match recommendations to changes and list the rest as outside changes.
 * `changes` = this campaign's changes (any time; only those within the
 * window are listed), `learningEnded(adsetId)` from the ad set's current
 * learning stage. resultSoFar is left '' for the service to fill.
 */
export function buildJournal(input: {
  date: string;
  days: number;
  runs: PmPastRun[];
  changes: PmChangeRow[];
  learningEnded: (adsetId: string) => boolean;
}): PmJournalItem[] {
  const { date, days, runs, changes, learningEnded } = input;
  const from = addDays(date, -days);
  const used = new Set<PmChangeRow>();
  const items: PmJournalItem[] = [];
  const readFor = (c: PmChangeRow | null, day: string, resets: boolean) =>
    readOf(day, date, resets, c ? learningEnded(c.adsetId) : false);

  for (const run of runs.filter((r) => r.date >= from && r.date < date)) {
    const start = +istDayBounds(run.date).start;
    const inWindow = changes.filter(
      (c) => +c.at >= start && +c.at < start + MATCH_WINDOW_MS,
    );
    for (const a of run.actions) {
      const kind = actionKind(a);
      const base = {
        date: run.date,
        actionId: a.id,
        title: a.title,
        entityId: a.entityId,
        entityName: a.entityName,
        level: (a.entityLevel === 'site'
          ? 'campaign'
          : a.entityLevel) as PmLevelName,
        resultSoFar: '',
        ...(run.userNote ? { userNote: run.userNote } : {}),
      };
      let status: PmJournalEntry['status'] = 'not_taken';
      let matched: PmChangeRow[] = [];
      if (kind === 'hold') {
        const touched = inWindow.filter(
          (c) =>
            c.objectId === a.entityId ||
            c.adsetId === a.entityId ||
            c.campaignId === a.entityId,
        );
        status = touched.length ? 'not_taken' : 'taken';
      } else {
        const verdicts = inWindow
          .map((c) => ({ c, v: matchChange(a, c) }))
          .filter((x) => x.v);
        matched = verdicts.map((x) => x.c).sort((x, y) => +x.at - +y.at);
        if (matched.length)
          status = verdicts.some((x) => x.v === 'taken') ? 'taken' : 'partly';
      }
      matched.forEach((c) => used.add(c));
      const first = matched[0] ?? null;
      const resets = first
        ? matched.some((c) => resetsLearning(c, changes)) || a.resetsLearning
        : a.resetsLearning;
      const { read, judgeAgainOn } = readFor(
        first,
        first ? istDay(first.at) : run.date,
        resets,
      );
      items.push({
        ...base,
        status,
        matched: matched.map(describeChange),
        resetsLearning: resets,
        read,
        ...(status !== 'not_taken' && judgeAgainOn ? { judgeAgainOn } : {}),
        resultSoFar:
          kind === 'offmeta'
            ? 'not visible in Meta (site / tracking change) — add a note if it was done'
            : '',
        changeAt: first?.at ?? null,
      });
    }
  }

  for (const c of changes) {
    const day = istDay(c.at);
    if (used.has(c) || day < from || day > date) continue;
    const resets = resetsLearning(c, changes);
    const { read, judgeAgainOn } = readFor(c, day, resets);
    items.push({
      date: day,
      title: outsideTitle(c),
      status: 'outside_change',
      matched: [describeChange(c)],
      resetsLearning: resets,
      read,
      ...(judgeAgainOn ? { judgeAgainOn } : {}),
      resultSoFar: '',
      entityId: c.objectId,
      entityName: c.objectName || c.objectId,
      level: levelOf(c),
      changeAt: c.at,
    });
  }

  return items.sort(
    (x, y) =>
      y.date.localeCompare(x.date) ||
      +(y.changeAt ?? 0) - +(x.changeAt ?? 0) ||
      (x.actionId ?? '').localeCompare(y.actionId ?? ''),
  );
}

export interface PmWindowMetrics {
  days: number;
  spend: number;
  firstPartyRoas: number | null;
  firstPartyCpa: number | null;
}

/**
 * "Day 2 (early): spend ₹4,000 → ₹3,200/day, CPA ₹1,120 → ₹980, ROAS 0.61 → 0.74 (first-party, 1 day before vs after)".
 */
export function resultLine(
  read: PmJournalEntry['read'],
  day: number,
  before: PmWindowMetrics | null,
  after: PmWindowMetrics | null,
): string {
  const label = `Day ${day} (${read === 'too_soon' ? 'too soon' : read})`;
  if (!before || !after || !after.days)
    return `${label}: no full day of data after the change yet`;
  const money = (v: number | null) => (v === null ? '–' : inr(v));
  const ratio = (v: number | null) => (v === null ? '–' : v.toFixed(2));
  return (
    `${label}: spend ${inr(before.spend / before.days)} → ${inr(after.spend / after.days)}/day, ` +
    `CPA ${money(before.firstPartyCpa)} → ${money(after.firstPartyCpa)}, ` +
    `ROAS ${ratio(before.firstPartyRoas)} → ${ratio(after.firstPartyRoas)} ` +
    `(first-party, ${after.days} day${after.days > 1 ? 's' : ''} before vs after)`
  );
}

const STATUS_WORD: Record<PmJournalEntry['status'], string> = {
  taken: 'TAKEN',
  partly: 'PARTLY TAKEN',
  not_taken: 'NOT TAKEN',
  outside_change: '',
};

/** Entities with an edit still inside its read window: "Hindi 25-44 until 1 Nov". */
export function settlingNow(items: PmJournalItem[], date: string) {
  const until = new Map<string, string>();
  for (const i of items) {
    if (
      !i.changeAt ||
      i.status === 'not_taken' ||
      !i.judgeAgainOn ||
      i.judgeAgainOn <= date
    )
      continue;
    const k = `${LEVEL_WORD[i.level]} "${i.entityName}"`;
    if ((until.get(k) ?? '') < i.judgeAgainOn) until.set(k, i.judgeAgainOn);
  }
  return [...until].map(([entity, day]) => ({ entity, until: day }));
}

/** 00-journal.md (format in doc 09), newest first. */
export function journalMarkdown(
  items: PmJournalItem[],
  opts: {
    campaignName: string;
    date: string;
    days: number;
    notes: { date: string; note: string }[];
  },
): string {
  const lines = [
    `# Journal — ${opts.campaignName} (last ${opts.days} days, as of ${dayLabel(opts.date)})`,
    '',
  ];
  const settling = settlingNow(items, opts.date);
  lines.push(
    settling.length
      ? `Settling now — do not stack edits on: ${settling.map((s) => `${s.entity} until ${dayLabel(s.until)}`).join('; ')}`
      : 'Settling now: nothing — no recent edit is still inside its read window.',
    '',
  );
  if (!items.length)
    lines.push('No recommendations or Meta changes in this period.', '');
  for (const i of items) {
    const head =
      i.status === 'outside_change'
        ? `## ${i.date} · ${i.title}`
        : `## ${i.date} · ${i.actionId} ${i.title} — ${STATUS_WORD[i.status]}` +
          (i.matched.length ? ` (${i.matched.join('; ')})` : '');
    lines.push(head);
    const detail = [
      i.resultSoFar,
      i.status === 'not_taken'
        ? ''
        : `resets learning: ${i.resetsLearning ? 'yes' : 'no'}`,
      i.judgeAgainOn ? `judge again ${dayLabel(i.judgeAgainOn)}` : '',
    ].filter(Boolean);
    if (detail.length) lines.push(detail.join(' · '));
    lines.push('');
  }
  for (const n of opts.notes.filter((x) => x.note))
    lines.push(`> Your note on the ${dayLabel(n.date)} run: ${n.note}`);
  return lines.join('\n').trimEnd() + '\n';
}
