/**
 * Pure loop rules for the per-campaign pipeline (docs/performance-marketeer/09):
 * when to send a phase back, how investigator and verifier scores merge, which
 * actions survive the plan verifier, and the code checks behind 05-checks.md.
 * No I/O, so every rule is unit-tested in loop.logic.spec.ts.
 */
import {
  Action,
  Cause,
  Confidence,
  InvestigateOutput,
  Issue,
  LessonContradiction,
  PlanOutput,
  PlanVerifyOutput,
  PM_LOOP,
  PmEvidence,
  VerifyOutput,
} from '../pm-agent.types';
import type { PmOwnerRule, PmSituation } from '../lessons/lessons.types';

export interface SendBack {
  sendBack: boolean;
  reasons: string[];
  blockers: number;
  majors: number;
  minors: number;
}

const count = (issues: Issue[]) => ({
  blockers: issues.filter((i) => i.severity === 'blocker').length,
  majors: issues.filter((i) => i.severity === 'major').length,
  minors: issues.filter((i) => i.severity === 'minor').length,
});

const causeRank = (c: Cause) => c.impactRupeesPerDay * c.confidence;

/** Any blocker, ≥ 3 majors, or the investigator's top-ranked cause rejected. */
export function shouldSendBackInvestigation(
  verify: VerifyOutput,
  investigate: InvestigateOutput,
): SendBack {
  const n = count(verify.issues);
  const reasons: string[] = [];
  if (n.blockers) reasons.push(`${n.blockers} blocker(s)`);
  if (n.majors >= PM_LOOP.investigate.majors)
    reasons.push(`${n.majors} majors`);
  const top = [...investigate.causes].sort(
    (a, b) => causeRank(b) - causeRank(a),
  )[0];
  const topVerdict = verify.causeVerdicts.find((v) => v.causeId === top?.id);
  if (topVerdict?.verdict === 'rejected')
    reasons.push(`top cause ${top.id} rejected`);
  return { sendBack: reasons.length > 0, reasons, ...n };
}

/** Any blocker, ≥ 2 majors, or more than a third of the actions rejected. */
export function shouldSendBackPlan(
  planVerify: PlanVerifyOutput,
  plan: PlanOutput,
): SendBack {
  const n = count(planVerify.issues);
  const reasons: string[] = [];
  if (n.blockers) reasons.push(`${n.blockers} blocker(s)`);
  if (n.majors >= PM_LOOP.plan.majors) reasons.push(`${n.majors} majors`);
  const ids = new Set(plan.actions.map((a) => a.id));
  const rejected = planVerify.actionVerdicts.filter(
    (v) => v.verdict === 'reject' && ids.has(v.actionId),
  ).length;
  if (
    plan.actions.length &&
    rejected / plan.actions.length > PM_LOOP.plan.rejectedShare
  )
    reasons.push(`${rejected}/${plan.actions.length} actions rejected`);
  return { sendBack: reasons.length > 0, reasons, ...n };
}

/** Stop sending back when the verifier's issue count did not fall since the previous round. */
export const stopEarly = (issues: number, previous: number | undefined) =>
  previous !== undefined && issues >= previous;

/** Blocker/major issues left open when a loop stops, as one line each. */
export const unresolvedOf = (label: string, round: number, issues: Issue[]) =>
  issues
    .filter((i) => i.severity !== 'minor')
    .map(
      (i) =>
        `${label} v${round} ${i.id} (${i.severity}${i.target ? ` on ${i.target}` : ''}): ${i.claim} — required: ${i.requiredChange}`,
    );

// ---------------------------------------------------------------- causes

export interface MergedCause extends Cause {
  investigatorConfidence: Confidence | null; // null = added by the verifier
  verifierConfidence: Confidence | null; // null = not verified
  verdict: 'confirmed' | 'weakened' | 'rejected' | 'added' | 'unverified';
  /** Investigator and verifier two bins apart (0.2 vs 0.8). */
  disputed: boolean;
  rank: number;
  /** Set when the category's diagnosis track record capped the confidence. */
  capNote?: string;
}

/** Diagnosis track record per cause category: n checked, held = cause held up later. */
export type CategoryAccuracy = Record<string, { n: number; held: number }>;

/** Cap for a category with a poor record: n ≥ 5 and held share < 0.2 → 0.2, < 0.4 → 0.5. */
export function accuracyCap(
  a: { n: number; held: number } | undefined,
): Confidence | null {
  if (!a || a.n < 5) return null;
  const share = a.held / a.n;
  return share < 0.2 ? 0.2 : share < 0.4 ? 0.5 : null;
}

const BINS: Confidence[] = [0.2, 0.5, 0.8];
const lower = (a: Confidence, b: Confidence) => (a < b ? a : b);

/**
 * Final cause scores: the verifier's confidence when it cites evidence, else
 * the lower of the two; rejected with evidence = dropped; the verifier's
 * added causes are included. Ranked by ₹ impact × confidence.
 */
export function mergeCauses(
  investigate: InvestigateOutput,
  verify: VerifyOutput,
  accuracy: CategoryAccuracy = {},
): { causes: MergedCause[]; dropped: Cause[] } {
  const dropped: Cause[] = [];
  const causes: MergedCause[] = [];
  for (const c of investigate.causes) {
    const v = verify.causeVerdicts.find((x) => x.causeId === c.id);
    if (!v) {
      causes.push({
        ...c,
        investigatorConfidence: c.confidence,
        verifierConfidence: null,
        verdict: 'unverified',
        disputed: false,
        rank: causeRank(c),
      });
      continue;
    }
    const backed = v.evidence.length > 0;
    if (v.verdict === 'rejected' && backed) {
      dropped.push(c);
      continue;
    }
    const confidence = backed
      ? v.confidence
      : lower(c.confidence, v.confidence);
    causes.push({
      ...c,
      confidence,
      investigatorConfidence: c.confidence,
      verifierConfidence: v.confidence,
      verdict: v.verdict,
      disputed:
        Math.abs(BINS.indexOf(c.confidence) - BINS.indexOf(v.confidence)) >= 2,
      rank: c.impactRupeesPerDay * confidence,
    });
  }
  for (const c of verify.addedCauses)
    causes.push({
      ...c,
      investigatorConfidence: null,
      verifierConfidence: c.confidence,
      verdict: 'added',
      disputed: false,
      rank: causeRank(c),
    });
  for (const c of causes) {
    const a = accuracy[c.category];
    const cap = accuracyCap(a);
    if (cap === null || c.confidence <= cap) continue;
    c.capNote = `confidence ${c.confidence} capped at ${cap}: ${c.category} causes held up ${a!.held}/${a!.n} times`;
    c.confidence = cap;
    c.rank = c.impactRupeesPerDay * cap;
  }
  causes.sort((a, b) => b.rank - a.rank);
  return { causes, dropped };
}

// ---------------------------------------------------------------- actions

export interface FinalAction extends Action {
  verdict: 'approve' | 'change' | 'unresolved';
  rank: number;
  /** Any cause behind the action is disputed (investigator and verifier two bins apart). */
  disputed: boolean;
  /** Plan verifier's note and open issues. */
  notes: string[];
  /** Names of failed code checks, and their messages. */
  checksFailed: string[];
  checkMessages: string[];
  /** Track record of this action type, (hits+1)/(n+2) ÷ 0.5 clamped 0.5–1.5; 1 = no record. */
  hitRateFactor: number;
}

/** Action type track record from graded outcomes. */
export type HitRates = Record<string, { n: number; hits: number }>;

export const hitRateFactor = (r: { n: number; hits: number } | undefined) =>
  r ? Math.min(1.5, Math.max(0.5, (r.hits + 1) / (r.n + 2) / 0.5)) : 1;

/** Final ordering score: ₹ impact × confidence × hit-rate factor. */
export const actionScore = (a: {
  impactRupeesPerDay: number;
  confidence: number;
  hitRateFactor?: number;
}) => a.impactRupeesPerDay * a.confidence * (a.hitRateFactor ?? 1);

/**
 * Drops rejected actions; 'change' is kept with the verifier's note; an
 * action with no verdict, or with an open blocker/major issue when the plan
 * loop hit its cap, is flagged 'unresolved'. Ranked by ₹ impact × confidence
 * × the action type's hit-rate factor.
 */
export function finalActions(
  plan: PlanOutput,
  planVerify: PlanVerifyOutput,
  causes: MergedCause[],
  openIssues: Issue[] = [],
  hitRates: HitRates = {},
): FinalAction[] {
  const disputed = new Set(causes.filter((c) => c.disputed).map((c) => c.id));
  const out: FinalAction[] = [];
  for (const a of plan.actions) {
    const v = planVerify.actionVerdicts.find((x) => x.actionId === a.id);
    if (v?.verdict === 'reject') continue;
    const open = openIssues.filter(
      (i) => i.target === a.id && i.severity !== 'minor',
    );
    const notes = [
      ...(v?.note ? [`verifier (${v.verdict}): ${v.note}`] : []),
      ...open.map((i) => `open ${i.severity} ${i.id}: ${i.claim}`),
    ];
    out.push({
      ...a,
      verdict: !v || open.length ? 'unresolved' : v.verdict,
      rank: 0,
      disputed: a.causeIds.some((id) => disputed.has(id)),
      notes,
      checksFailed: [],
      checkMessages: [],
      hitRateFactor: hitRateFactor(hitRates[a.type]),
    });
  }
  out.sort((a, b) => actionScore(b) - actionScore(a));
  out.forEach((a, i) => (a.rank = i + 1));
  return out;
}

// ---------------------------------------------------------------- code checks

export interface CheckInput {
  evidence: Pick<PmEvidence, 'id' | 'tool'>[];
  causes: Cause[];
  actions: FinalAction[];
  /** Campaign, ad set and ad ids of this campaign in pm_meta_entities. */
  entityIds: Set<string>;
  /** Entity ids the journal says are still settling. */
  settling: Set<string>;
  /** Campaign first-party ROAS (null = no verdict possible). */
  campaignRoas: number | null;
  /** Run date YYYY-MM-DD; judgeOn may not be before it. */
  date: string;
  /** Owner rules; those with a `check` are enforced here. */
  ownerRules?: PmOwnerRule[];
  situation?: Pick<PmSituation, 'season' | 'product'>;
  /** Entity id → created time (ISO or YYYY-MM-DD), for no_pause_before_days. */
  entityCreated?: Map<string, string>;
  /** Action id → the lesson that measured this kind of action (PmLessonsService.effectFor). */
  lessonEffects?: Map<
    string,
    {
      lessonId: string;
      effect: { metric: string; median: number; low: number; high: number };
    }
  >;
}

export interface CheckResult {
  check: string;
  target: string; // C… / A… id
  message: string;
}

export const IMPACT_TOOL = 'impact_rupees';
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const isBudget = (a: Action) =>
  a.type === 'budget' || /budget/i.test(a.change.field);
const EPS = 1e-9;

/**
 * Guardrails re-checked by code after the plan verifier. Failures never delete
 * an action: they are attached to it (checksFailed, mutating `actions`) and
 * listed in 05-checks.md. A failing cause marks every action that cites it.
 */
export function runChecks(i: CheckInput): CheckResult[] {
  const ev = new Map(i.evidence.map((e) => [e.id, e.tool]));
  const out: CheckResult[] = [];
  const missing = (ids: string[]) => ids.filter((id) => !ev.has(id));

  for (const c of i.causes) {
    const m = missing([...c.evidence, c.impactEvidence]);
    if (m.length)
      out.push({
        check: 'evidence_exists',
        target: c.id,
        message: `cites unknown evidence ${m.join(', ')}`,
      });
    const tool = ev.get(c.impactEvidence);
    if (tool && tool !== IMPACT_TOOL)
      out.push({
        check: 'impact_from_tool',
        target: c.id,
        message: `impactEvidence ${c.impactEvidence} is a ${tool} call, not ${IMPACT_TOOL}`,
      });
  }
  const badCauses = new Map<string, string[]>();
  for (const r of out)
    badCauses.set(r.target, [...(badCauses.get(r.target) ?? []), r.message]);

  const roasBelow =
    i.campaignRoas !== null && i.campaignRoas < PM_LOOP.targetRoas;
  let spendDelta = 0;
  for (const a of i.actions) {
    const fail = (check: string, message: string) =>
      out.push({ check, target: a.id, message });
    const m = missing(a.expectedEffect.evidence);
    if (m.length)
      fail('evidence_exists', `cites unknown evidence ${m.join(', ')}`);
    for (const id of a.causeIds)
      if (badCauses.has(id))
        fail(
          'cause_checks',
          `cause ${id} failed checks: ${badCauses.get(id)!.join('; ')}`,
        );
    if (isBudget(a)) {
      const from = num(a.change.from);
      const to = num(a.change.to);
      if (from === null || to === null)
        fail('budget_step', 'budget change needs numeric from and to');
      else {
        spendDelta += to - from;
        if (
          from > 0 &&
          Math.abs(to - from) / from > PM_LOOP.maxBudgetStep + EPS
        )
          fail(
            'budget_step',
            `${from} → ${to} is a ${Math.round(((to - from) / from) * 100)}% step (max ±${PM_LOOP.maxBudgetStep * 100}%)`,
          );
        if (from === 0 && to > 0)
          fail(
            'budget_step',
            `0 → ${to} cannot be checked against the ±${PM_LOOP.maxBudgetStep * 100}% step`,
          );
      }
    }
    if (a.entityLevel !== 'site' && !i.entityIds.has(a.entityId))
      fail(
        'entity_exists',
        `${a.entityLevel} ${a.entityId} is not in this campaign's entities`,
      );
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.judgeOn) || a.judgeOn < i.date)
      fail(
        'judge_on',
        `judgeOn ${a.judgeOn} must be a YYYY-MM-DD on or after the run date ${i.date}`,
      );
    if (a.type !== 'hold' && i.settling.has(a.entityId))
      fail(
        'settling',
        `${a.entityLevel} ${a.entityId} is still settling from an earlier change (journal)`,
      );
  }
  for (const a of i.actions) {
    for (const r of ownerRuleBreaks(a, i))
      out.push({
        check: `owner_rule:${r.rule.ruleId}`,
        target: a.id,
        message: `${r.why} (${r.rule.ruleId}: ${r.rule.text})`,
      });
    const l = i.lessonEffects?.get(a.id);
    const e = a.expectedEffect;
    if (
      l &&
      normMetric(l.effect.metric) === normMetric(e.metric) &&
      (e.high < l.effect.low - EPS || e.low > l.effect.high + EPS)
    )
      out.push({
        check: 'prediction_vs_lesson',
        target: a.id,
        message: `expected ${e.metric} ${e.low}…${e.high} does not overlap ${l.lessonId}'s measured ${l.effect.low}…${l.effect.high} (median ${l.effect.median})`,
      });
  }
  if (roasBelow && spendDelta > 0)
    for (const a of i.actions)
      if (isBudget(a) && (num(a.change.to) ?? 0) > (num(a.change.from) ?? 0))
        out.push({
          check: 'no_spend_increase_below_target',
          target: a.id,
          message: `raises spend while first-party ROAS ${i.campaignRoas!.toFixed(2)} < ${PM_LOOP.targetRoas} (net +₹${Math.round(spendDelta)}/day)`,
        });

  const byAction = new Map(i.actions.map((a) => [a.id, a]));
  for (const r of out) {
    const a = byAction.get(r.target);
    if (!a) continue;
    if (!a.checksFailed.includes(r.check)) a.checksFailed.push(r.check);
    a.checkMessages.push(`${r.check}: ${r.message}`);
  }
  return out;
}

const normMetric = (m: string) => m.toLowerCase().replace(/[^a-z0-9]/g, '');
const isPause = (a: Action) =>
  a.type === 'pause' || /^paused$/i.test(String(a.change.to ?? ''));
const daysBetween = (from: string, to: string) =>
  Math.floor(
    (Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000,
  );

/** Owner rules (with a code check) this action breaks. */
export function ownerRuleBreaks(
  a: Action,
  i: Pick<CheckInput, 'ownerRules' | 'situation' | 'entityCreated' | 'date'>,
): { rule: PmOwnerRule; why: string }[] {
  const out: { rule: PmOwnerRule; why: string }[] = [];
  const from = num(a.change.from);
  const to = num(a.change.to);
  const budgetUp = isBudget(a) && from !== null && to !== null && to > from;
  const productOk = (p?: string) =>
    !p || p.toLowerCase() === i.situation?.product?.toLowerCase();
  for (const rule of i.ownerRules ?? []) {
    const c = rule.check;
    if (!rule.active || !c) continue;
    const brk = (why: string) => out.push({ rule, why });
    switch (c.kind) {
      case 'no_pause_before_days': {
        const created = i.entityCreated?.get(a.entityId);
        if (!isPause(a) || !created) break;
        const age = daysBetween(created, i.date);
        if (age < c.days)
          brk(
            `pauses ${a.entityLevel} ${a.entityId} on day ${age} (created ${created.slice(0, 10)}), before day ${c.days}`,
          );
        break;
      }
      case 'max_budget_step':
        if (
          isBudget(a) &&
          from !== null &&
          to !== null &&
          from > 0 &&
          Math.abs(to - from) / from > c.step + EPS
        )
          brk(
            `${from} → ${to} is a ${Math.round(((to - from) / from) * 100)}% step (owner max ±${Math.round(c.step * 100)}%)`,
          );
        break;
      case 'no_budget_increase_in_season':
        if (
          budgetUp &&
          productOk(c.product) &&
          (i.situation?.season ?? []).includes(c.season)
        )
          brk(`raises budget ${from} → ${to} during ${c.season}`);
        break;
      case 'no_action_type':
        if (a.type === c.type && productOk(c.product))
          brk(`action type ${a.type} is not allowed`);
        break;
    }
  }
  return out;
}

/** Lesson ids cited by the final causes and actions, sorted by number. */
export const lessonsUsed = (items: { lessonIds?: string[] }[]) =>
  [...new Set(items.flatMap((x) => x.lessonIds ?? []))].sort(
    (a, b) => Number(a.slice(2)) - Number(b.slice(2)),
  );

/** lessonsContradicted from several phase outputs, merged by lesson id (evidence unioned, notes joined). */
export function mergeContradictions(
  lists: LessonContradiction[][],
): LessonContradiction[] {
  const by = new Map<string, LessonContradiction>();
  for (const x of lists.flat()) {
    const m = by.get(x.id);
    if (!m) by.set(x.id, { ...x, evidence: [...x.evidence] });
    else {
      m.evidence = [...new Set([...m.evidence, ...x.evidence])];
      if (x.note && !m.note.includes(x.note)) m.note = `${m.note} | ${x.note}`;
    }
  }
  return [...by.values()];
}

/** An action as a decision shape (field, direction, relative step) for lesson matching — same rule as records.service. */
export function decisionShape(a: Action) {
  const [f, t] = [num(a.change.from), num(a.change.to)];
  const step =
    f !== null && t !== null && f > 0
      ? Math.round((t / f - 1) * 1000) / 1000
      : undefined;
  const to = String(a.change.to ?? '');
  const direction: 'up' | 'down' | undefined =
    step !== undefined && step !== 0
      ? step > 0
        ? 'up'
        : 'down'
      : isPause(a)
        ? 'down'
        : /ACTIVE/i.test(to)
          ? 'up'
          : undefined;
  return { type: a.type, field: a.change.field, direction, step };
}
