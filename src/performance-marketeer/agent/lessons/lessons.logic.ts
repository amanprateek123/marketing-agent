/**
 * Lessons core — pure logic (docs/performance-marketeer/10-lessons.md):
 * scope matching, per-phase selection, confidence, lifecycle, code-counted
 * support from records, proposal validation and the brief's markdown block.
 * No I/O; PmLessonsService does the reads and writes.
 */
import type { PmPhase } from '../pm-agent.types';
import {
  PM_LESSON_RULES,
  PM_PHASE_LESSON_TYPES,
  PmDecisionRecord,
  PmDiagnosisCheck,
  PmLesson,
  PmLessonCase,
  PmLessonClaim,
  PmLessonProposal,
  PmLessonScope,
  PmLessonStatus,
  PmLessonType,
  PmOutcomeRecord,
  PmOwnerRule,
  PmSituation,
} from './lessons.types';

/** Record (not an array) so a new PmSituation field fails to compile until listed. */
const SITUATION_KEYS: Record<keyof PmSituation, true> = {
  product: true,
  structure: true,
  objective: true,
  audience: true,
  spendBand: true,
  learning: true,
  daysSinceLaunch: true,
  daysSinceLastEdit: true,
  roas7d: true,
  cpa7d: true,
  ctr7d: true,
  cpm7d: true,
  freqDay: true,
  accountCpmTrend: true,
  season: true,
  festivalInDays: true,
  symptoms: true,
  level: true,
  entityId: true,
};
/** Scope keys that route (to a phase / cause category) instead of matching the situation. */
const ROUTE_KEYS = ['phase', 'category'];
export const PM_SCOPE_KEYS = new Set([
  ...Object.keys(SITUATION_KEYS),
  ...ROUTE_KEYS,
]);
export const PM_LESSON_TYPES = Object.keys(
  PM_LESSON_RULES.caps,
) as PmLessonType[];

const DAY_MS = 864e5;
const day = (s: string | Date | undefined) =>
  s ? new Date(s).toISOString().slice(0, 10) : '';
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// ---------------------------------------------------------------- scope

const CMP = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/;

/** One scope value against one situation field (grammar in lessons.types PmLessonScope). */
export function matchValue(rule: string, value: unknown): boolean {
  const cmp = CMP.exec(rule.trim());
  if (cmp) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const n = Number(cmp[2]);
    switch (cmp[1]) {
      case '>':
        return value > n;
      case '>=':
        return value >= n;
      case '<':
        return value < n;
      default:
        return value <= n;
    }
  }
  const any = rule.split('|').map((s) => s.trim().toLowerCase());
  const eq = (v: unknown) =>
    v !== null && v !== undefined && any.includes(String(v).toLowerCase());
  return Array.isArray(value) ? value.some(eq) : eq(value);
}

/** Every situation key of the scope must match (AND). 'phase'/'category' are routing only and skipped here. */
export function matchScope(scope: PmLessonScope, situation: PmSituation): boolean {
  return Object.entries(scope).every(
    ([k, rule]) =>
      ROUTE_KEYS.includes(k) ||
      matchValue(rule, (situation as unknown as Record<string, unknown>)[k]),
  );
}

export const specificity = (scope: PmLessonScope) => Object.keys(scope).length;

// ---------------------------------------------------------------- selection

/** hits / uses once there are ≥ 3 graded uses; null before that (neutral). */
export const hitRate = (l: Pick<PmLesson, 'uses' | 'hits'>) =>
  l.uses >= 3 ? l.hits / l.uses : null;

const lastCaseAt = (l: PmLesson) =>
  l.cases.reduce((m, c) => (c.at > m ? c.at : m), '');

/** Best first: specificity, confidence, hit rate (neutral 0.5 under 3 uses), most recent case. */
export function rankLessons(lessons: PmLesson[]): PmLesson[] {
  return [...lessons].sort(
    (a, b) =>
      specificity(b.scope) - specificity(a.scope) ||
      b.confidence - a.confidence ||
      (hitRate(b) ?? 0.5) - (hitRate(a) ?? 0.5) ||
      lastCaseAt(b).localeCompare(lastCaseAt(a)),
  );
}

export function selectForPhase(
  lessons: PmLesson[],
  phase: PmPhase,
  situation: PmSituation,
  opts: { perPhase?: number; perTypePerPhase?: number } = {},
): PmLesson[] {
  const perPhase = opts.perPhase ?? PM_LESSON_RULES.perPhase;
  const perType = opts.perTypePerPhase ?? PM_LESSON_RULES.perTypePerPhase;
  const types = PM_PHASE_LESSON_TYPES[phase];
  const fits = lessons.filter(
    (l) =>
      l.status === 'active' &&
      types.includes(l.type) &&
      (!l.scope.phase || matchValue(l.scope.phase, phase)) &&
      matchScope(l.scope, situation),
  );
  const count: Record<string, number> = {};
  const out: PmLesson[] = [];
  for (const l of rankLessons(fits)) {
    if (out.length >= perPhase) break;
    if ((count[l.type] ?? 0) >= perType) continue;
    count[l.type] = (count[l.type] ?? 0) + 1;
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------- confidence + lifecycle

const share = (cases: PmLessonCase[]) =>
  cases.length ? cases.filter((c) => c.supports).length / cases.length : 0;

export function confidenceOf(cases: PmLessonCase[]): 0.2 | 0.5 | 0.8 {
  if (cases.length < PM_LESSON_RULES.minCases) return 0.2;
  const s = share(cases);
  if (cases.length >= 8 && s >= 0.8) return 0.8;
  return s >= PM_LESSON_RULES.minShare ? 0.5 : 0.2;
}

/** Evidence bar to go active (approval still needed): ≥3 supporting, ≥2 campaigns, share ≥75%. */
export function meetsBar(l: Pick<PmLesson, 'cases'>): boolean {
  const sup = l.cases.filter((c) => c.supports);
  return (
    sup.length >= PM_LESSON_RULES.minCases &&
    new Set(sup.map((c) => c.campaignId)).size >= PM_LESSON_RULES.minCampaigns &&
    share(l.cases) >= PM_LESSON_RULES.minShare
  );
}

/** Season lessons stay until the same window next year (+ a month of slack for date drift). */
const SEASON_STALE_DAYS = 395;
export function staleDaysFor(type: PmLessonType): number {
  if (type === 'season_effect') return SEASON_STALE_DAYS;
  return PM_LESSON_RULES.staleDays[type] ?? PM_LESSON_RULES.staleDays.default;
}

/**
 * The lifecycle (doc 10): candidates expire after 60 days (promotion is a
 * PROMOTE proposal, never automatic); active → review on 2 contradictions in
 * a row or share < 60% over the last 8; review → active when share is back
 * ≥ 75% and the last two support; retire on share < 50% over ≥ 6 recent
 * cases or no supporting case for staleDays.
 */
export function nextStatus(l: PmLesson, today: string): PmLessonStatus {
  if (l.status === 'retired') return 'retired';
  if (l.status === 'candidate') {
    const born = day(l.createdAt) || today;
    return daysBetween(born, today) > PM_LESSON_RULES.candidateExpireDays
      ? 'retired'
      : 'candidate';
  }
  const cases = [...l.cases].sort((a, b) => a.at.localeCompare(b.at));
  const recent = cases.slice(-PM_LESSON_RULES.reviewWindow);
  const lastSupport = [...cases].reverse().find((c) => c.supports)?.at;
  const since = lastSupport || day(l.approvedAt) || day(l.createdAt);
  if (since && daysBetween(since, today) > staleDaysFor(l.type)) return 'retired';
  if (
    recent.length >= PM_LESSON_RULES.retireMinUses &&
    share(recent) < PM_LESSON_RULES.retireShare
  )
    return 'retired';
  const lastTwo = cases.slice(-2);
  const twoContradict = lastTwo.length === 2 && lastTwo.every((c) => !c.supports);
  const twoSupport = lastTwo.length === 2 && lastTwo.every((c) => c.supports);
  const weak =
    recent.length >= PM_LESSON_RULES.minCases &&
    share(recent) < PM_LESSON_RULES.reviewShare;
  if (l.status === 'active') return twoContradict || weak ? 'review' : 'active';
  // review
  return share(recent) >= PM_LESSON_RULES.minShare && twoSupport ? 'active' : 'review';
}

// ---------------------------------------------------------------- support from records

const CLEAN = ['worked', 'no_effect', 'hurt'];

/** Does the decision match the claim's action (type, field, direction, max step)? */
export function actionMatches(
  a: Extract<PmLessonClaim, { kind: 'action_effect' }>['action'],
  d: Pick<PmDecisionRecord, 'type' | 'field' | 'direction' | 'step'>,
): boolean {
  if (d.type !== a.type) return false;
  if (a.field && d.field !== a.field) return false;
  if (a.direction && d.direction !== a.direction) return false;
  if (a.maxStep !== undefined && !(d.step !== undefined && Math.abs(d.step) <= a.maxStep + 1e-9))
    return false;
  return true;
}

/**
 * true = supports, false = contradicts, null = does not count (other claim
 * kind, weak / unclean read, not taken, different action or context).
 */
export function supportFromOutcome(
  l: Pick<PmLesson, 'claim' | 'scope'>,
  d: PmDecisionRecord,
  o: PmOutcomeRecord,
): boolean | null {
  if (l.claim.kind !== 'action_effect') return null;
  if (o.weak || !CLEAN.includes(o.verdict) || d.taken === 'not_taken') return null;
  if (!actionMatches(l.claim.action, d) || !matchScope(l.scope, d.context)) return null;
  return o.verdict === l.claim.expect;
}

export function supportFromCheck(
  l: Pick<PmLesson, 'claim' | 'scope'>,
  c: PmDiagnosisCheck,
): boolean | null {
  if (l.claim.kind !== 'diagnosis_pattern' || c.result === 'unclear') return null;
  if (c.category !== l.claim.category) return null;
  if (l.scope.category && !matchValue(l.scope.category, c.category)) return null;
  return (c.result === 'held') === l.claim.holds;
}

// ---------------------------------------------------------------- proposal validation

export interface ProposalCtx {
  lessons: PmLesson[];
  /** Every record / evidence id that exists (D-…, DC-…, cev-…). */
  knownIds: Set<string>;
  /** Curator evidence ids that came from a measure_* tool. */
  measureIds: Set<string>;
  caps?: Record<PmLessonType, number>;
  maxActive?: number;
}

const claimKindFor = (t: PmLessonType): PmLessonClaim['kind'] =>
  t === 'action_effect' || t === 'diagnosis_pattern' ? t : 'measured';

export function claimProblems(type: PmLessonType, claim: PmLessonClaim | undefined): string[] {
  if (!claim) return ['claim is missing'];
  const want = claimKindFor(type);
  if (claim.kind !== want) return [`a ${type} lesson needs a "${want}" claim, got "${claim.kind}"`];
  if (claim.kind === 'action_effect' && !claim.action?.type) return ['claim.action.type is missing'];
  if (claim.kind === 'diagnosis_pattern' && !claim.category) return ['claim.category is missing'];
  if (claim.kind === 'measured' && !claim.metric) return ['claim.metric is missing'];
  return [];
}

export const scopeProblems = (scope: PmLessonScope | undefined) =>
  Object.entries(scope ?? {}).flatMap(([k, v]) =>
    !PM_SCOPE_KEYS.has(k)
      ? [`unknown scope key "${k}"`]
      : typeof v !== 'string' || !v.trim()
        ? [`scope.${k} must be a non-empty string`]
        : [],
  );

/** Key-order-independent JSON, for comparing claims. */
const canon = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(v);
/** Same claim = same action+expect / category+holds / metric; effect numbers may differ. */
const claimKey = (c: PmLessonClaim) =>
  c.kind === 'action_effect'
    ? canon({ k: c.kind, a: c.action, e: c.expect })
    : c.kind === 'diagnosis_pattern'
      ? canon({ k: c.kind, c: c.category, h: c.holds })
      : canon({ k: c.kind, m: c.metric });
const sameClaim = (a: PmLessonClaim, b: PmLessonClaim) => claimKey(a) === claimKey(b);
const sameScope = (a: PmLessonScope, b: PmLessonScope) =>
  specificity(a) === specificity(b) &&
  Object.entries(a).every(([k, v]) => b[k]?.toLowerCase() === v.toLowerCase());

/** Code checks on a curator delta (doc 10, "Who writes"); [] = valid. */
export function validateProposal(
  p: Pick<PmLessonProposal, 'op' | 'lesson' | 'lessonId' | 'mergeIds' | 'cases'>,
  ctx: ProposalCtx,
): string[] {
  const problems: string[] = [];
  const byId = new Map(ctx.lessons.map((l) => [l.lessonId, l]));
  const target = p.lessonId ? byId.get(p.lessonId) : undefined;
  const caps = ctx.caps ?? PM_LESSON_RULES.caps;
  const live = (l: PmLesson) => l.status !== 'retired';

  const checkCases = (type: PmLessonType | undefined, cases: PmLessonCase[] | undefined, need: boolean) => {
    if (need && !cases?.length) problems.push('cites no cases');
    for (const c of cases ?? []) {
      if (!ctx.knownIds.has(c.ref)) problems.push(`case ${c.ref} does not exist`);
      if (!c.campaignId || !/^\d{4}-\d{2}-\d{2}$/.test(c.at)) problems.push(`case ${c.ref} needs campaignId and at (YYYY-MM-DD)`);
    }
    if (type && claimKindFor(type) === 'measured' && cases?.length && !cases.some((c) => ctx.measureIds.has(c.ref)))
      problems.push(`a ${type} lesson must cite measure_* evidence ids`);
  };
  const checkDraft = (l: Partial<PmLesson> | undefined, full: boolean) => {
    if (!l) return problems.push('lesson is missing');
    if (full || l.type !== undefined)
      if (!l.type || !PM_LESSON_TYPES.includes(l.type)) problems.push(`unknown lesson type "${l.type}"`);
    if ((full || l.statement !== undefined) && !l.statement?.trim()) problems.push('statement is empty');
    problems.push(...scopeProblems(l.scope));
    if ((full || l.claim !== undefined) && l.type) problems.push(...claimProblems(l.type, l.claim));
  };
  const needTarget = () => {
    if (!p.lessonId) problems.push('lessonId is missing');
    else if (!target) problems.push(`lesson ${p.lessonId} does not exist`);
    else if (!live(target)) problems.push(`lesson ${p.lessonId} is retired`);
  };

  switch (p.op) {
    case 'ADD': {
      checkDraft(p.lesson, true);
      const cases = p.cases ?? p.lesson?.cases;
      checkCases(p.lesson?.type, cases, true);
      if (cases?.length && !cases.some((c) => c.supports)) problems.push('a new lesson needs ≥ 1 supporting case');
      const l = p.lesson;
      const dup =
        l?.type && l.claim &&
        ctx.lessons.find(
          (x) => live(x) && x.type === l.type && sameScope(x.scope, l.scope ?? {}) && sameClaim(x.claim, l.claim!),
        );
      if (dup) problems.push(`near-duplicate of ${dup.lessonId}: use EDIT or MERGE`);
      break;
    }
    case 'EDIT':
      needTarget();
      checkDraft(target && p.lesson ? { type: target.type, ...p.lesson } : p.lesson, false);
      if (target && p.lesson?.type && p.lesson.type !== target.type) problems.push('EDIT cannot change the lesson type');
      break;
    case 'ATTACH': {
      needTarget();
      checkCases(target?.type, p.cases, true);
      const have = new Set(target?.cases.map((c) => c.ref));
      for (const c of p.cases ?? []) if (have.has(c.ref)) problems.push(`case ${c.ref} is already attached`);
      break;
    }
    case 'MERGE': {
      const ids = p.mergeIds ?? [];
      if (ids.length < 2) problems.push('MERGE needs ≥ 2 mergeIds');
      const ls = ids.map((id) => byId.get(id));
      ids.forEach((id, i) => {
        if (!ls[i]) problems.push(`lesson ${id} does not exist`);
        else if (!live(ls[i]!)) problems.push(`lesson ${id} is retired`);
      });
      const types = new Set(ls.filter(Boolean).map((l) => l!.type));
      if (types.size > 1) problems.push('MERGE lessons must share one type');
      checkDraft(p.lesson && { type: [...types][0], ...p.lesson }, true);
      break;
    }
    case 'RETIRE':
      needTarget();
      break;
    case 'PROMOTE': {
      needTarget();
      if (target && target.status !== 'candidate') problems.push(`lesson ${p.lessonId} is ${target.status}, not a candidate`);
      if (target && !meetsBar(target)) problems.push('does not meet the evidence bar (≥3 supporting cases, ≥2 campaigns, ≥75%)');
      const active = ctx.lessons.filter((l) => l.status === 'active');
      if (active.length >= (ctx.maxActive ?? PM_LESSON_RULES.maxActive)) problems.push('active lessons are at the cap');
      if (target && active.filter((l) => l.type === target.type).length >= caps[target.type])
        problems.push(`${target.type} lessons are at the cap (${caps[target.type]})`);
      break;
    }
    default:
      problems.push(`unknown op "${(p as { op: string }).op}"`);
  }
  return problems;
}

// ---------------------------------------------------------------- markdown

const pct = (x: number) => `${Math.round(x * 100)}%`;
export function hitLabel(l: Pick<PmLesson, 'uses' | 'hits'>): string {
  const r = hitRate(l);
  return r === null ? `hit rate n/a (${l.uses} uses)` : `hit ${l.hits}/${l.uses} (${pct(r)})`;
}
const checkText = (r: PmOwnerRule) => (r.check ? ` [code-checked: ${r.check.kind}]` : '');

/** The `## Lessons` + `## Owner rules` block of 00-brief.md for one phase. */
export function renderLessonsMarkdown(
  lessons: PmLesson[],
  ownerRules: PmOwnerRule[],
  phase: PmPhase,
  activeTotal = lessons.length,
): string {
  const rules = ownerRules.filter((r) => r.active);
  return [
    `## Lessons (code-picked, ${lessons.length} of ${activeTotal} active)`,
    lessons.length
      ? `Priors from measured past outcomes for the ${phase} phase, not rules: today's evidence wins. Check each against today's data; list the ids you relied on in lessonsUsed and the ones today's data contradicts in lessonsContradicted (with ev ids).`
      : 'No active lesson matches this campaign today.',
    ...lessons.map((l) => {
      const sup = l.cases.filter((c) => c.supports).length;
      const because = l.because ? ` Because (a reading, not measured): ${l.because}` : '';
      return `- ${l.lessonId} · ${l.type} · conf ${l.confidence} · ${hitLabel(l)} · ${sup} of ${l.cases.length} cases — Check whether it holds today: ${l.statement}${because}`;
    }),
    '',
    '## Owner rules (all)',
    rules.length ? 'Standing instructions from the owner. These are rules, not priors: follow them.' : 'None set.',
    ...rules.map((r) => `- ${r.ruleId} — ${r.text}${checkText(r)}`),
    '',
  ].join('\n');
}
