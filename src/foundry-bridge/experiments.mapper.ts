/**
 * Experiments (the brain's `hypotheses`), in words a marketer reads.
 *
 * PURE: no I/O, no clock unless one is passed. The service fetches rows and hands them here.
 *
 * Exported API
 * ─────────────
 *   VIEW_STATUSES                       view → the brain statuses it shows
 *   attributeLabel(attribute)           'hook_type' → 'opening hook'
 *   valueLabel(attribute, value)        ('hook_type','question') → 'a question'
 *   metricLabel(metric)                 'ctr_pct' → 'click rate'
 *   levelLabel(level)                   'creative' → 'Ad'
 *   kindLabel(kind)                     'variant' → 'New twist on a proven idea'
 *   statusMeta(status)                  → {label, meaning, tone}
 *   renderClaim(row)                    the claim as one sentence, never the stored `statement`
 *   renderProgress(row, perf, now)      testing progress towards the floors and the horizon
 *   renderResult(row)                   a judged test's result sentence + confidence label
 *   mapExperiment(row, ctx)             one BrainExperiment for a view
 *   summariseExperiments(byView, names) counts per view and per product
 *   mixSentence(kinds)                  ['proven','proven','variant'] → '2 proven ideas, 1 new twist'
 *   humanDate(iso, now) / dayLabel(date) IST dates: 'Today' | 'Yesterday' | '24 Sep' / 'Friday, 25 Sep'
 *   stripInternalIds(text)              removes [H123], H123, Run #94, run_… tokens from prose
 *
 * Two rules, the same as campaign-run.mapper.ts: nothing internal crosses (no id, no enum code,
 * no attribute key), and a missing thing stays missing (no confidence is null, not "low").
 */

import type {
  BrainExperiment,
  BrainExperimentProductCount,
  BrainExperimentProgress,
  BrainExperimentResult,
  BrainExperimentSummary,
  BrainExperimentTone,
  BrainExperimentView,
} from './brain.types';

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function obj(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null;
}

/** `pain_point` → `pain point`. Lowercase: these land mid-sentence. */
function words(code: string): string {
  return code
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ── Views ──────────────────────────────────────────────────────────────── */

export const VIEW_STATUSES: Record<BrainExperimentView, string[]> = {
  testing: ['proposed', 'active'],
  learned: ['confirmed', 'refuted'],
  dropped: ['retired', 'inconclusive'],
};

export function isExperimentView(value: unknown): value is BrainExperimentView {
  return value === 'testing' || value === 'learned' || value === 'dropped';
}

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

const ATTRIBUTE_LABEL: Record<string, string> = {
  angle: 'message angle',
  hook_type: 'opening hook',
  visual_style: 'visual style',
  language: 'language',
  format: 'format',
  track: 'creative style',
  placement_mode: 'where ads show',
  device_targeting: 'devices',
  gender_targeting: 'gender',
  geo_scope: 'location',
  age_band: 'age group',
  audience_strategy: 'audience',
  advantage_audience: "Meta's automatic audience",
};

export function attributeLabel(attribute: string | null): string {
  if (!attribute) return 'setting';
  return ATTRIBUTE_LABEL[attribute] ?? words(attribute);
}

const VALUE_LABEL: Record<string, string> = {
  pain_point: 'pain point',
  question: 'a question',
  price_led: 'price-led',
  hindi: 'Hindi',
  english: 'English',
  hinglish: 'Hinglish',
  bengali: 'Bengali',
  tamil: 'Tamil',
  telugu: 'Telugu',
  marathi: 'Marathi',
  gujarati: 'Gujarati',
  kannada: 'Kannada',
  malayalam: 'Malayalam',
  punjabi: 'Punjabi',
  ugc: 'user-made (UGC)',
  static: 'still image',
  static_image: 'still image',
  single_image: 'single image',
  video: 'video',
  carousel: 'carousel',
  reels: 'Reels',
  mobile: 'mobile',
  desktop: 'desktop',
  all: 'everyone',
  male: 'men',
  female: 'women',
  men: 'men',
  women: 'women',
  india: 'all of India',
  national: 'all of India',
  metro: 'big cities',
  tier1: 'big cities',
  tier_1: 'big cities',
  tier2: 'smaller cities',
  tier_2: 'smaller cities',
  broad: 'broad',
  lookalike: 'lookalike',
  interest: 'interest-based',
  interests: 'interest-based',
  retargeting: 'past visitors',
  advantage_plus: "Meta's automatic",
  automatic: 'automatic',
  manual: 'hand-picked',
};

const PLATFORM_LABEL: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  messenger: 'Messenger',
  audience_network: 'Audience Network',
  threads: 'Threads',
  whatsapp: 'WhatsApp',
};

const ALL_PLACEMENTS = [
  'audience_network',
  'facebook',
  'instagram',
  'messenger',
  'threads',
];

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function valueLabel(attribute: string | null, value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return 'not set';
  const key = raw.toLowerCase();

  if (attribute === 'advantage_audience') {
    if (key === 'true' || key === 'on' || key === '1') return 'on';
    if (key === 'false' || key === 'off' || key === '0') return 'off';
  }

  if (attribute === 'placement_mode' || key.includes('+')) {
    const parts = key
      .split(/[+,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1 || PLATFORM_LABEL[parts[0] ?? '']) {
      if (ALL_PLACEMENTS.every((p) => parts.includes(p)))
        return 'all placements';
      if (key === 'advantage' || key === 'automatic')
        return "Meta's automatic placements";
      return listWords(parts.map((p) => PLATFORM_LABEL[p] ?? words(p)));
    }
    if (key === 'advantage' || key === 'automatic' || key === 'advantage_plus')
      return "Meta's automatic placements";
  }

  if (attribute === 'age_band') {
    const plus = /^(\d{2})[_-]?(plus|\+)$/.exec(key);
    if (plus) return `${plus[1]}+`;
    const band = /^(\d{2})[_-](\d{2})$/.exec(key);
    if (band) return `${band[1]}–${band[2]}`;
  }

  return VALUE_LABEL[key] ?? words(raw);
}

const METRIC_LABEL: Record<string, string> = {
  ctr_pct: 'click rate',
  roas: 'return on ad spend',
  cost_per_purchase: 'cost per sale',
  purchases: 'sales',
};

export function metricLabel(metric: string | null): string {
  if (!metric) return 'results';
  return METRIC_LABEL[metric] ?? words(metric);
}

const LEVEL_LABEL: Record<string, string> = {
  creative: 'Ad',
  audience: 'Audience',
  placement: 'Placement',
  campaign: 'Campaign',
  product: 'Product',
};

export function levelLabel(level: string | null): string {
  if (!level) return 'Other';
  return LEVEL_LABEL[level] ?? capitalise(words(level));
}

const KIND_LABEL: Record<string, string> = {
  proven: 'Proven idea',
  variant: 'New twist on a proven idea',
  seed: 'Exploring',
};

export function kindLabel(kind: string | null): string {
  if (!kind) return 'Idea';
  return KIND_LABEL[kind] ?? capitalise(words(kind));
}

const STATUS_META: Record<
  string,
  { label: string; meaning: string; tone: BrainExperimentTone }
> = {
  proposed: {
    label: 'Planned',
    meaning: 'Written down; the ads that test it have not started running yet.',
    tone: 'waiting',
  },
  active: {
    label: 'Testing now',
    meaning: 'Ads that test this are running and results are coming in.',
    tone: 'progress',
  },
  confirmed: {
    label: 'Worked',
    meaning: 'The results backed the idea up.',
    tone: 'good',
  },
  refuted: {
    label: "Didn't work",
    meaning: 'The results went against the idea.',
    tone: 'bad',
  },
  inconclusive: {
    label: 'No clear answer',
    meaning: 'The test ended without enough evidence either way.',
    tone: 'idle',
  },
  retired: {
    label: 'Dropped',
    meaning: 'Stopped before it was judged.',
    tone: 'idle',
  },
};

export function statusMeta(status: string | null): {
  label: string;
  meaning: string;
  tone: BrainExperimentTone;
} {
  return (
    STATUS_META[status ?? ''] ?? {
      label: status ? capitalise(words(status)) : 'Unknown',
      meaning: '',
      tone: 'idle',
    }
  );
}

/* ── The claim ──────────────────────────────────────────────────────────── */

/** The subject of the sentence: "Ads that open with a question", "Showing ads in all placements". */
function subjectFor(attribute: string | null, value: unknown): string {
  const v = valueLabel(attribute, value);
  switch (attribute) {
    case 'angle':
      return `Ads using the ${v} message angle`;
    case 'hook_type':
      return `Ads that open with ${v}`;
    case 'visual_style':
      return `Ads in a ${v} visual style`;
    case 'language':
      return `Ads in ${v}`;
    case 'format':
      return `${capitalise(v)} ads`;
    case 'track':
      return `Ads in the ${v} creative style`;
    case 'placement_mode':
      return `Showing ads in ${v}`;
    case 'device_targeting':
      return `Showing ads on ${v} devices`;
    case 'gender_targeting':
      return `Showing ads to ${v}`;
    case 'geo_scope':
      return `Showing ads in ${v}`;
    case 'age_band':
      return `Showing ads to people aged ${v}`;
    case 'audience_strategy':
      return `Using a ${v} audience`;
    case 'advantage_audience':
      return v === 'on'
        ? 'Letting Meta choose the audience automatically'
        : v === 'off'
          ? 'Choosing the audience ourselves instead of Meta'
          : `Meta's automatic audience set to ${v}`;
    default:
      return `Ads where the ${attributeLabel(attribute)} is ${v}`;
  }
}

/** "will get more clicks" — the metric and direction as a verb phrase. */
function predicateFor(metric: string | null, direction: string | null): string {
  const d =
    direction === 'worse'
      ? 'worse'
      : direction === 'at_least'
        ? 'at_least'
        : 'better';
  const table: Record<string, Record<string, string>> = {
    ctr_pct: {
      better: 'will get more clicks',
      worse: 'will get fewer clicks',
      at_least: 'will get at least as many clicks',
    },
    roas: {
      better: 'will earn a better return on ad spend',
      worse: 'will earn a lower return on ad spend',
      at_least: 'will earn at least as good a return on ad spend',
    },
    cost_per_purchase: {
      better: 'will get sales more cheaply',
      worse: 'will cost more per sale',
      at_least: 'will get sales at no higher cost',
    },
    purchases: {
      better: 'will bring in more sales',
      worse: 'will bring in fewer sales',
      at_least: 'will bring in at least as many sales',
    },
  };
  return (
    table[metric ?? '']?.[d] ??
    (d === 'worse'
      ? `will do worse on ${metricLabel(metric)}`
      : d === 'at_least'
        ? `will do at least as well on ${metricLabel(metric)}`
        : `will do better on ${metricLabel(metric)}`)
  );
}

/** "than the other ads in the same campaign" / "as …" for at-least claims. */
function comparisonFor(
  comparison: string | null,
  direction: string | null,
  attribute: string | null,
): string {
  const word = direction === 'at_least' ? 'as' : 'than';
  switch (comparison) {
    case 'parent_hypothesis':
      return `${word} the proven idea it builds on`;
    case 'product_baseline':
      return `${word} this product's usual ads`;
    case 'cohort_without_attribute':
      return `${word} ads with a different ${attributeLabel(attribute)}`;
    case 'absolute':
      return `${word} the target we set`;
    case 'campaign_siblings':
    default:
      return `${word} the other ads in the same campaign`;
  }
}

/**
 * The claim as one sentence, rendered from the fields. The stored `statement` is NOT used: it is
 * written for agents ("PROVEN: On saathi_report, creative hook_type=question: ctr_pct better …").
 */
export function renderClaim(row: Row): string {
  const attribute = str(row.attribute);
  const metric = str(row.metric);
  const direction = str(row.direction);
  const comparison = str(row.comparison);
  return `${subjectFor(attribute, row.value)} ${predicateFor(metric, direction)} ${comparisonFor(
    comparison,
    direction,
    attribute,
  )}.`;
}

/* ── Progress (testing) ─────────────────────────────────────────────────── */

/**
 * The brain's per-level default floors (brain/src/hypotheses.mjs DEFAULT_FLOORS), restated so a
 * progress bar has a finish line. A row's own `floors` override these. The brain remains the
 * judge — this only draws how close a test is.
 */
const DEFAULT_FLOORS: Record<
  string,
  { min_spend_inr: number; min_impressions: number; horizon_days: number }
> = {
  creative: { min_spend_inr: 500, min_impressions: 2000, horizon_days: 7 },
  audience: { min_spend_inr: 1500, min_impressions: 5000, horizon_days: 7 },
  placement: { min_spend_inr: 1500, min_impressions: 5000, horizon_days: 7 },
  campaign: { min_spend_inr: 5000, min_impressions: 5000, horizon_days: 14 },
  product: { min_spend_inr: 5000, min_impressions: 5000, horizon_days: 14 },
};

const WAITING_NOTE: Record<string, string> = {
  waiting: 'Still collecting results.',
  floors_unmet: 'Not enough has been spent yet to judge it.',
  learning_limited:
    'Meta is holding back delivery on this ad set, so results are slow to come in.',
  no_conversion_data: 'Waiting for Meta to report sales.',
  driven_by_minority:
    'So far a few big-spending ads are carrying the result — not a pattern yet.',
  no_separation: 'No clear difference yet.',
  unmeasurable: 'The numbers cannot be compared yet.',
  confirmed: 'Looking good so far — waiting for the final check.',
  refuted: 'Not looking good so far — waiting for the final check.',
};

const DAY_MS = 86_400_000;

export function renderProgress(
  row: Row,
  perf: Row | null,
  now: Date = new Date(),
): BrainExperimentProgress {
  const level = str(row.level) ?? 'creative';
  const defaults = DEFAULT_FLOORS[level] ?? DEFAULT_FLOORS.creative;
  const floors = obj(row.floors) ?? {};
  const withSide = obj(perf?.with) ?? {};
  const judgement = obj(perf?.judgement);

  const horizon = num(row.horizon_days) ?? defaults.horizon_days;
  const activated = str(row.activated_at);
  let daysLeft: number | null = null;
  if (activated) {
    const start = new Date(activated).getTime();
    if (Number.isFinite(start)) {
      const end = start + horizon * DAY_MS;
      daysLeft = Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
    }
  }

  const code = str(judgement?.code);
  const status = str(row.status);
  return {
    spentInr: Math.round(num(withSide.spend) ?? 0),
    neededInr: num(floors.min_spend_inr) ?? defaults.min_spend_inr,
    impressions: Math.round(num(withSide.impressions) ?? 0),
    neededImpressions: num(floors.min_impressions) ?? defaults.min_impressions,
    daysLeft,
    note:
      status === 'proposed'
        ? 'Starts when its ads go live.'
        : code
          ? (WAITING_NOTE[code] ?? null)
          : perf
            ? null
            : 'Results are not available right now.',
  };
}

/* ── Result (learned / dropped) ─────────────────────────────────────────── */

/** A rate in the metric's own units: "2.1%", "2.40x", "₹420", "0.8 per 1,000 views". */
export function formatRate(metric: string | null, value: number): string {
  switch (metric) {
    case 'ctr_pct':
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case 'roas':
      return `${value.toFixed(2)}x`;
    case 'cost_per_purchase':
      return `₹${Math.round(value).toLocaleString('en-IN')}`;
    case 'purchases':
      return `${value.toFixed(1)} per 1,000 views`;
    default:
      return `${Math.round(value * 100) / 100}`;
  }
}

const CONFIDENCE_LABEL: Record<string, string> = {
  low: 'Early signal',
  medium: 'Fairly sure',
  high: 'Confident',
};

const INCONCLUSIVE_SENTENCE: Record<string, string> = {
  floors_unmet: 'Not enough was spent in time to tell either way.',
  learning_limited:
    'Meta held back delivery on this ad set, so the numbers could not tell us anything.',
  no_conversion_data: 'Meta did not report enough sales to judge it.',
  driven_by_minority:
    'A few big-spending ads carried the result, so it is not a real pattern.',
  unmeasurable: 'The two sides could not be compared.',
  no_separation: 'No real difference showed up.',
};

export function renderResult(row: Row): BrainExperimentResult | null {
  const status = str(row.status);
  const verdict = obj(row.verdict);
  const metric = str(row.metric);
  const code = str(verdict?.code);
  const withRate = num(verdict?.with_rate);
  const baseRate = num(verdict?.baseline_rate);
  const withSide = obj(verdict?.with);
  const baseSide = obj(verdict?.baseline);
  const withCount = num(withSide?.creatives);
  const baseCount = num(baseSide?.creatives);

  let figures: string | null = null;
  if (withRate !== null && baseRate !== null) {
    figures = `${formatRate(metric, withRate)} vs ${formatRate(metric, baseRate)} ${metricLabel(metric)}`;
    if (withCount !== null && baseCount !== null) {
      figures += ` across ${withCount} vs ${baseCount} ads`;
    }
  }

  const confidence = str(verdict?.confidence);
  const confidenceLabel = confidence
    ? (CONFIDENCE_LABEL[confidence] ?? null)
    : null;

  let sentence: string;
  if (status === 'confirmed') {
    sentence = figures ? `It worked: ${figures}.` : 'It worked.';
  } else if (status === 'refuted') {
    sentence = figures
      ? `It didn't hold up: ${figures}.`
      : "It didn't hold up.";
  } else if (status === 'inconclusive') {
    const base =
      (code && INCONCLUSIVE_SENTENCE[code]) ??
      'The test ended without a clear answer.';
    sentence =
      figures && code !== 'floors_unmet' ? `${base} (${figures}.)` : base;
  } else if (status === 'retired') {
    sentence = 'Stopped before there were results to judge.';
  } else {
    return null;
  }
  return { sentence, confidenceLabel };
}

/* ── Dates (IST) ────────────────────────────────────────────────────────── */

const IST = 'Asia/Kolkata';

function istDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: IST });
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** "24 Sep" / "24 Sep 2025" from a YYYY-MM-DD day. Month names are ours, not ICU's ("Sept"). */
function shortDay(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

/** "Today" | "Yesterday" | "24 Sep" | "24 Sep 2025" (a different year). Null for no/invalid date. */
export function humanDate(
  value: unknown,
  now: Date = new Date(),
): string | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00+05:30` : s);
  if (!Number.isFinite(d.getTime())) return null;
  const day = istDay(d);
  if (day === istDay(now)) return 'Today';
  if (day === istDay(new Date(now.getTime() - DAY_MS))) return 'Yesterday';
  return shortDay(day, day.slice(0, 4) !== istDay(now).slice(0, 4));
}

/** "2026-09-25" → "Friday, 25 Sep". */
export function dayLabel(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!Number.isFinite(utc.getTime())) return null;
  return `${WEEKDAYS[utc.getUTCDay()]}, ${shortDay(`${m[1]}-${m[2]}-${m[3]}`, false)}`;
}

/* ── Assembling ─────────────────────────────────────────────────────────── */

export interface ExperimentContext {
  view: BrainExperimentView;
  /** slug → display name. */
  names: Map<string, string>;
  /** hypothesis id → its perf_by_hypothesis row (testing only). */
  perf?: Map<string, Row>;
  now?: Date;
}

export function mapExperiment(
  row: Row,
  ctx: ExperimentContext,
): BrainExperiment | null {
  const id = row.id === null || row.id === undefined ? null : String(row.id);
  if (!id || !str(row.attribute)) return null;
  const now = ctx.now ?? new Date();
  const slug = str(row.offering_slug);
  const status = str(row.status);
  const kind = str(row.kind);
  const meta = statusMeta(status);
  const sinceAt =
    ctx.view === 'testing'
      ? (str(row.activated_at) ?? str(row.created_at))
      : (str(row.judged_at) ?? str(row.updated_at) ?? str(row.created_at));
  return {
    ref: `exp-${id}`,
    productKey: slug,
    product: slug ? (ctx.names.get(slug) ?? capitalise(words(slug))) : null,
    levelLabel: levelLabel(str(row.level)),
    claim: renderClaim(row),
    kindLabel: kindLabel(kind),
    kind:
      kind === 'proven' || kind === 'variant' || kind === 'seed'
        ? kind
        : 'other',
    statusLabel: meta.label,
    statusMeaning: meta.meaning,
    tone: meta.tone,
    progress:
      ctx.view === 'testing'
        ? renderProgress(row, ctx.perf?.get(id) ?? null, now)
        : null,
    result: ctx.view === 'testing' ? null : renderResult(row),
    since: humanDate(sinceAt, now),
    sinceAt,
  };
}

/** Rows per view (compact rows are enough: offering_slug and status) → the summary. */
export function summariseExperiments(
  byView: Record<BrainExperimentView, Row[]>,
  names: Map<string, string>,
  partial: boolean,
): BrainExperimentSummary {
  const products = new Map<string, BrainExperimentProductCount>();
  const views: Record<BrainExperimentView, number> = {
    testing: 0,
    learned: 0,
    dropped: 0,
  };
  for (const view of ['testing', 'learned', 'dropped'] as const) {
    for (const row of byView[view]) {
      views[view] += 1;
      const slug = str(row.offering_slug);
      if (!slug) continue;
      const entry = products.get(slug) ?? {
        productKey: slug,
        product: names.get(slug) ?? capitalise(words(slug)),
        testing: 0,
        learned: 0,
        dropped: 0,
      };
      entry[view] += 1;
      products.set(slug, entry);
    }
  }
  return {
    views,
    products: [...products.values()].sort((a, b) =>
      a.product.localeCompare(b.product),
    ),
    partial,
  };
}

/** Kinds → "4 proven ideas, 2 new twists, 1 exploratory idea". Null for none. */
export function mixSentence(kinds: Array<string | null>): string | null {
  const count = (k: string) => kinds.filter((x) => x === k).length;
  const proven = count('proven');
  const variants = count('variant');
  const seeds = count('seed');
  const parts = [
    proven ? `${proven} proven idea${proven === 1 ? '' : 's'}` : null,
    variants ? `${variants} new twist${variants === 1 ? '' : 's'}` : null,
    seeds ? `${seeds} exploratory idea${seeds === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Remove internal references from prose the Brain wrote: "[H123]", "[not opened]", "→ H45",
 * "of H12", "H123", "Run #94", "run 94", "run_abc…", "agt_…", "tres_…". Whitespace is tidied
 * after, so "Question hook [H12] lifts CTR" reads "Question hook lifts CTR".
 */
export function stripInternalIds(text: string): string {
  return text
    .replace(/\[(?:H\d+|not opened)\]/g, '')
    .replace(/\s*(?:→|->)\s*H\d+\b/g, '')
    .replace(/\b(?:of|hypothesis|hypotheses)\s+H\d+\b/gi, '')
    .replace(/\bH\d+\b/g, '')
    .replace(/\bRun\s*#\d+\s*/gi, '')
    .replace(/\b(?:run|agt|tres)_[A-Za-z0-9_-]+\b/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:)])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}
