/**
 * A PLAN gate as facts, not as the Slack message.
 *
 * PURE: the service reads the rows (the approval, the day's `daily_plans` row, the `pipeline_runs`
 * its decisions opened, and the hypotheses those decisions carry) and hands them here.
 *
 * Exported API
 * ─────────────
 *   cleanPlanSummary(text)   the gate's Slack text minus the "Reply: …" grammar line and internal
 *                            ids ([H123], Run #94, → H45). The fallback when rows are missing.
 *   planDecisionIds(approval, dailyPlan)
 *                            the decisions this gate owns: the approval's snapshot (migration 039),
 *                            else the day plan's, else null (unknown — not "none").
 *   planHeadline(view)       one line for the gate card: "2 campaigns · ₹4,000 a day of ₹5,000".
 *   buildPlanView(input)     → BrainPlanView. `structured` is true only when the day plan row was
 *                            read; otherwise every structured field is empty and `summaryText`
 *                            carries the cleaned text.
 *
 * NOT PARSED FROM THE TEXT. The summary is written for Slack by an LLM-adjacent step and its shape
 * drifts; a regex over it would silently start lying the day a line changes. The rows are what the
 * gate snapshots, so they are what is shown.
 */

import type {
  BrainPlanAudience,
  BrainPlanClaim,
  BrainPlanRun,
  BrainPlanView,
} from './brain.types';
import {
  CAMPAIGN_TYPE_LABEL,
  audienceBetRow,
  audienceName,
} from './campaign-run.mapper';
import {
  dayLabel,
  kindLabel,
  levelLabel,
  linkedIds,
  mixSentence,
  renderClaim,
  stripInternalIds,
} from './experiments.mapper';

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

/** A JSONB column may arrive parsed or as its JSON text; accept both. */
function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function titleize(slug: string): string {
  return slug
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Whether a hypothesis is one of this run's bets: it names the run, links to it, is listed in the
 * run's `hypothesis_ids`, or (only when the decision opened this one run) shares its decision.
 */
export function belongsToRun(h: Row, run: Row, runs: Row[]): boolean {
  const runId = run.id === null || run.id === undefined ? null : String(run.id);
  if (runId && linkedIds(h, 'pipeline_run').has(runId)) return true;
  const listed = list(run.hypothesis_ids).map((x) => String(x));
  if (listed.includes(String(h.id))) return true;
  const decision =
    run.decision_id === null || run.decision_id === undefined
      ? null
      : String(run.decision_id);
  const hDecision =
    h.decision_id === null || h.decision_id === undefined
      ? null
      : String(h.decision_id);
  if (!decision || decision !== hDecision) return false;
  // A hypothesis that names no run, on a decision that opened exactly this one.
  const sameDecision = runs.filter((r) => String(r.decision_id) === decision);
  const hRun = h.pipeline_run_id;
  return sameDecision.length === 1 && (hRun === null || hRun === undefined);
}

/**
 * The Slack text, cleaned for a page: the "Reply: approve · approve at <amount> …" line is Slack
 * grammar (the console has buttons), and [H123] / Run #94 are ids nobody on this page can use.
 */
export function cleanPlanSummary(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*Reply\s*:/i.test(line))
    .map((line) =>
      stripInternalIds(line)
        .replace(/\s*\((?:already open; returned, not re-opened)\)/g, '')
        .replace(/\s*\(no hypothesis recorded for this run\)/g, ''),
    )
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

/** The decision ids this gate owns, or null when neither row says. */
export function planDecisionIds(
  approval: Row,
  dailyPlan: Row | null,
): Set<string> | null {
  const snapshot = approval.decision_ids;
  if (snapshot !== null && snapshot !== undefined) {
    return new Set(list(snapshot).map((x) => String(x)));
  }
  if (
    dailyPlan &&
    dailyPlan.decision_ids !== undefined &&
    dailyPlan.decision_ids !== null
  ) {
    return new Set(list(dailyPlan.decision_ids).map((x) => String(x)));
  }
  return null;
}

export interface PlanViewInput {
  /** The approvals row (gate = 'plan'). */
  approval: Row;
  /** The daily_plans row for the gate's plan_date, or null when it could not be read. */
  dailyPlan: Row | null;
  /** pipeline_runs for that date — the builder filters them to the gate's decisions. */
  runs: Row[];
  /** Hypotheses carried by the gate's decisions (hypotheses_read by decision_id, full rows). */
  hypotheses: Row[];
  /** slug → display name. */
  names: Map<string, string>;
}

function runBudget(
  run: Row,
  allocationBySlug: Map<string, number>,
  runsPerSlug: Map<string, number>,
): number | null {
  const contract = obj(run.creative_contract);
  const plan = list(contract?.audience_plan);
  let total = 0;
  let seen = false;
  for (const raw of plan) {
    const entry = obj(raw);
    const v = num(entry?.budget_value_inr);
    if (v !== null) {
      total += v;
      seen = true;
    }
  }
  if (seen) return total;
  // No audience plan yet: the day's allocation is the run's budget only when it is the product's
  // only run that day — otherwise splitting it would be a guess.
  const slug = str(run.offering_slug);
  if (slug && runsPerSlug.get(slug) === 1)
    return allocationBySlug.get(slug) ?? null;
  return null;
}

export function buildPlanView(input: PlanViewInput): BrainPlanView {
  const { approval, dailyPlan, names } = input;
  const summaryText = cleanPlanSummary(str(approval.summary));
  const planDate = str(approval.plan_date) ?? str(dailyPlan?.plan_date);
  const empty: BrainPlanView = {
    dateLabel: dayLabel(planDate),
    totalDailyInr: null,
    budgetInr: null,
    unspentInr: null,
    runs: [],
    testing: [],
    mix: null,
    why: null,
    structured: false,
    summaryText,
  };
  if (!dailyPlan) return empty;

  const nameOf = (slug: string | null): string | null =>
    slug ? (names.get(slug) ?? titleize(slug)) : null;

  const allocationBySlug = new Map<string, number>();
  let totalDailyInr: number | null = null;
  for (const raw of list(dailyPlan.allocations)) {
    const row = obj(raw);
    const slug = str(row?.offering_slug);
    const amount = num(row?.amount_inr);
    if (!slug || amount === null) continue;
    allocationBySlug.set(slug, (allocationBySlug.get(slug) ?? 0) + amount);
    totalDailyInr = (totalDailyInr ?? 0) + amount;
  }
  const budgetInr = num(dailyPlan.budget_inr);

  const owned = planDecisionIds(approval, dailyPlan);
  const runs = input.runs.filter((run) => {
    if (owned === null) return true;
    const decision =
      run.decision_id === null || run.decision_id === undefined
        ? null
        : String(run.decision_id);
    return decision !== null && owned.has(decision);
  });
  const runsPerSlug = new Map<string, number>();
  for (const run of runs) {
    const slug = str(run.offering_slug);
    if (slug) runsPerSlug.set(slug, (runsPerSlug.get(slug) ?? 0) + 1);
  }

  // Retired claims are not part of what the day is testing.
  const live = input.hypotheses.filter(
    (h) => str(h.status) !== 'retired' && str(h.attribute),
  );
  const claimOf = (h: Row): BrainPlanClaim => ({
    claim: renderClaim(h),
    kindLabel: kindLabel(str(h.kind)),
    levelLabel: levelLabel(str(h.level)),
    product: nameOf(str(h.offering_slug)),
  });

  const planRuns: BrainPlanRun[] = runs.map((run) => {
    const slug = str(run.offering_slug);
    const contract = obj(run.creative_contract);
    const audiencePlan = list(contract?.audience_plan);
    const own = live.filter((h) => belongsToRun(h, run, runs));
    const audiences: BrainPlanAudience[] = audiencePlan
      .map((raw) => obj(raw))
      .filter((entry): entry is Row => entry !== null)
      .map((entry) => {
        const hit = audienceBetRow(entry, live);
        return {
          name: audienceName(str(entry.kind)),
          budgetInr: num(entry.budget_value_inr),
          bet: hit ? renderClaim(hit) : null,
        };
      });
    return {
      product: nameOf(slug) ?? 'A product',
      typeLabel:
        CAMPAIGN_TYPE_LABEL[str(run.campaign_type) ?? ''] ?? 'Campaign',
      dailyBudgetInr: runBudget(run, allocationBySlug, runsPerSlug),
      creatives: num(run.target_creative_count),
      adSets: audiencePlan.length ? audiencePlan.length : null,
      bets: own.map(claimOf),
      audiences,
    };
  });

  const testing: BrainPlanClaim[] = live.map(claimOf);

  const reasoning = str(dailyPlan.reasoning);
  return {
    dateLabel: dayLabel(planDate),
    totalDailyInr,
    budgetInr,
    unspentInr:
      budgetInr !== null && totalDailyInr !== null
        ? Math.max(0, Math.round((budgetInr - totalDailyInr) * 100) / 100)
        : null,
    runs: planRuns,
    testing,
    mix: mixSentence(live.map((h) => str(h.kind))),
    why: reasoning ? stripInternalIds(reasoning) || null : null,
    structured: true,
    summaryText,
  };
}

/** One line for the gate card, in words: "2 campaigns · ₹4,000 a day of ₹5,000 · 2 ideas to test". */
export function planHeadline(view: BrainPlanView): string {
  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  if (!view.structured) {
    const first = view.summaryText.split('\n')[0] ?? '';
    return first.replace(/^PLAN\s+\d{4}-\d{2}-\d{2}\s*[—-]\s*/i, '').trim();
  }
  const parts: string[] = [];
  const n = view.runs.length;
  parts.push(n ? `${n} campaign${n === 1 ? '' : 's'}` : 'No campaigns');
  if (view.totalDailyInr !== null) {
    parts.push(
      `${inr(view.totalDailyInr)} a day${view.budgetInr !== null ? ` of ${inr(view.budgetInr)}` : ''}`,
    );
  }
  if (view.testing.length) {
    parts.push(
      `${view.testing.length} idea${view.testing.length === 1 ? '' : 's'} to test`,
    );
  }
  return parts.join(' · ');
}
