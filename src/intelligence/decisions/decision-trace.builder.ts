import { EngineContext } from '../shared/engine-context';
import {
  BusinessData,
  ConfidenceData,
  DecisionContext,
  SnapshotData,
  DiagnosisData,
  ENGINE_STEP,
  EngineSliceKey,
  ExecutionData,
  ExplainabilityData,
  ForecastData,
  LearningData,
  LifecycleData,
  MemoryData,
  ObjectiveData,
  PortfolioData,
  RecommendationData,
  RevenueData,
  SignalData,
  TrendData,
} from '../orchestrator/decision-context';

/**
 * Renders a finished cycle's 16 engine slices as plain-English steps, so an
 * operator can read HOW a decision was reached instead of only WHAT was
 * proposed.
 *
 * Why this lives apart from the engines: each engine writes for the next
 * engine, not for a human — slices are dense numeric structures (TrendReading
 * has slope/ema/velocity/acceleration per metric) that are correct but
 * unreadable. Translating inside the engines would mix presentation into
 * computation and force a redeploy of the cascade to reword a sentence.
 *
 * Everything here is a PURE function over already-persisted slices. It never
 * recomputes, re-derives, or infers anything the engines didn't record — if a
 * step reads oddly, that is the engine's actual output, which is the whole
 * point of showing it. A slice missing entirely (engine skipped, or the cycle
 * predates it) renders as `no_data` rather than a fabricated summary.
 */

export interface DecisionTraceStep {
  step: number;
  engine: EngineSliceKey;
  /** Ready-to-render "Step 7 → Why it is happening". */
  label: string;
  /** Layman name for the step — not the engine's class name. */
  title: string;
  /** The question this step answers, phrased as an operator would ask it. */
  question: string;
  /** One-line answer, with the real numbers in it. */
  headline: string;
  /** Supporting plain-English lines. Empty when the step had nothing to add. */
  details: string[];
  /**
   * The engine's own recorded output, flattened to `key = value` lines — the
   * log behind the prose. Kept alongside the summary rather than instead of
   * it: the summary is this file's interpretation, and an operator judging
   * whether the system works needs to be able to check the interpretation
   * against what the engine actually wrote.
   */
  logs: string[];
  /** Engine-reported provenance for this step. Absent when the step wrote nothing. */
  meta?: {
    engineConfidence?: number;
    computedAt?: string;
    ms?: number;
    deterministic?: boolean;
    degraded?: string;
    evidenceCount?: number;
  };
  status: 'ok' | 'no_data';
  /**
   * True when this step materially shaped THIS decision — the signal that
   * fired it, the diagnosis it cites, the gate that held it back. Lets the UI
   * dim the steps that merely ran so the causal path stands out.
   */
  decisive: boolean;
}

const money = (n: number | undefined): string =>
  n === undefined || !Number.isFinite(n)
    ? '—'
    : `₹${Math.round(n).toLocaleString('en-IN')}`;

const times = (n: number | undefined): string =>
  n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(2)}×`;

const pct = (n: number | undefined): string =>
  n === undefined || !Number.isFinite(n) ? '—' : `${Math.round(n * 100)}%`;

/** "budget_saturation" -> "budget saturation" — engine enums are snake_case. */
const words = (s: string | undefined): string => (s ?? '').replace(/[_-]+/g, ' ').trim();

const STAGE_PLAIN: Record<string, string> = {
  draft: 'not launched yet',
  pending_approval: 'waiting for approval',
  launching: 'just launched',
  learning: "still in Meta's learning phase",
  growing: 'picking up',
  scaling: 'scaling',
  stable: 'steady',
  fatigue: 'wearing out',
  recovery: 'recovering',
  retirement: 'winding down',
  unknown: 'unclear',
};

const DIRECTION_PLAIN: Record<string, string> = {
  improving: 'getting better',
  stable: 'holding steady',
  declining: 'getting worse',
  volatile: 'jumping around',
};

/**
 * Caps on the flattened log. A snapshot slice can carry hundreds of nested
 * Meta fields; past this depth/among this many lines it stops being readable
 * and starts being a wall. Truncation is always announced in-band so the
 * reader knows they're seeing a subset.
 */
const LOG_MAX_LINES = 150;
const LOG_MAX_DEPTH = 4;
const LOG_MAX_VALUE_CHARS = 300;

/** Flattens an engine slice to `a.b[0].c = value` lines, in key order. */
function flattenSlice(value: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (out.length >= LOG_MAX_LINES) return out;

  if (value === null || value === undefined) {
    out.push(`${prefix} = ${value === null ? 'null' : 'not set'}`);
    return out;
  }
  if (value instanceof Date) {
    out.push(`${prefix} = ${value.toISOString()}`);
    return out;
  }
  if (typeof value !== 'object') {
    const s = String(value);
    out.push(`${prefix} = ${s.length > LOG_MAX_VALUE_CHARS ? `${s.slice(0, LOG_MAX_VALUE_CHARS)}…` : s}`);
    return out;
  }
  if (depth >= LOG_MAX_DEPTH) {
    out.push(`${prefix} = ${Array.isArray(value) ? `[${value.length} items]` : '{…}'} (nested too deep to show)`);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${prefix} = [] (none)`);
      return out;
    }
    value.forEach((v, i) => flattenSlice(v, `${prefix}[${i}]`, depth + 1, out));
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out.push(`${prefix} = {} (empty)`);
    return out;
  }
  for (const [k, v] of entries) {
    flattenSlice(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

/**
 * Every slice is stored as EngineContext<T> — the payload under `.data`,
 * wrapped in the engine's own confidence, evidence refs and timing. The log
 * leads with that wrapper because "which engine produced this, how sure was
 * it, and did it run degraded" is the first thing you need when judging
 * whether a step's output should be trusted.
 */
function sliceLogs(ctx: EngineContext<unknown> | undefined): string[] {
  if (!ctx) return ['(this step wrote no output for this cycle)'];

  const header: string[] = [];
  if (ctx.computedAt) header.push(`computedAt = ${new Date(ctx.computedAt).toISOString()}`);
  if (Number.isFinite(ctx.confidence)) header.push(`engineConfidence = ${ctx.confidence}`);
  if (Number.isFinite(ctx.ms)) header.push(`tookMs = ${ctx.ms}`);
  if (ctx.version) header.push(`engineVersion = ${ctx.version}`);
  header.push(`deterministic = ${ctx.deterministic}`);
  if (ctx.degraded) {
    header.push(`degraded = ${ctx.degraded.mode} (fullDataAvailable = ${ctx.degraded.fullDataAvailable})`);
  }
  for (const [i, e] of (ctx.evidence ?? []).entries()) {
    header.push(`evidence[${i}] = ${e.kind}:${e.ref} (weight ${e.weight})${e.note ? ` — ${e.note}` : ''}`);
  }

  const lines = [...header, '—', ...flattenSlice(ctx.data)];
  if (lines.length >= LOG_MAX_LINES) {
    lines.push(`… truncated at ${LOG_MAX_LINES} lines — the full slice is stored in intelligence_engine_outputs.`);
  }
  return lines;
}

export interface TraceInput {
  slices: Partial<DecisionContext>;
  /**
   * The decision being explained — used to mark which steps were decisive.
   *
   * OPTIONAL because a cycle can legitimately finish having proposed nothing
   * (every candidate action gated, or the campaign is simply healthy), and
   * that cycle's sixteen steps are exactly as worth reading as one that ended
   * in a recommendation — arguably more so, since "why did it do nothing?" is
   * the harder question. When absent the decision-specific highlighting is
   * skipped and every step still renders from its own slice.
   */
  decision?: {
    actionId: string;
    actionType: string;
    targetId: string;
    expectedProfitDeltaINR7d: number;
    confidence?: number;
    gatedBy?: string[];
    evidenceSnapshot?: { signalKind?: string };
  };
}

/**
 * The decision as the step builders see it — always present, because
 * buildDecisionTrace substitutes a neutral placeholder for cycle-level traces
 * before any builder runs. Keeps the sixteen builders free of null checks.
 */
type TraceDecision = NonNullable<TraceInput['decision']>;

/**
 * What each step builder returns. `label` and `logs` are attached centrally in
 * buildDecisionTrace so the numbering and the raw-log rendering can never drift
 * between the sixteen builders.
 */
type StepBody = Omit<DecisionTraceStep, 'label' | 'logs'>;

export function buildDecisionTrace(input: TraceInput): DecisionTraceStep[] {
  const { slices } = input;
  // Neutral placeholder for cycle-level traces. Every consumer below looks its
  // id up with .find(), which yields undefined for '' and falls through to the
  // step's own no-decision rendering — no special-casing needed per builder.
  const decision = input.decision ?? {
    actionId: '',
    actionType: '',
    targetId: '',
    expectedProfitDeltaINR7d: 0,
  };
  const firedSignal = decision.evidenceSnapshot?.signalKind;

  const steps: StepBody[] = [
    snapshotStep(slices.snapshot?.data),
    objectiveStep(slices.objective?.data),
    lifecycleStep(slices.lifecycle?.data, decision.actionType),
    trendStep(slices.trend?.data),
    revenueStep(slices.revenue?.data, slices.objective?.data),
    signalStep(slices.signal?.data, firedSignal),
    diagnosisStep(slices.diagnosis?.data),
    businessStep(slices.business?.data),
    portfolioStep(slices.portfolio?.data),
    forecastStep(slices.forecast?.data),
    confidenceStep(slices.confidence?.data),
    memoryStep(slices.memory?.data, decision.actionType),
    recommendationStep(slices.recommendation?.data, decision),
    explainabilityStep(slices.explainability?.data, decision.actionId),
    executionStep(slices.execution?.data, decision.actionId),
    learningStep(slices.learning?.data),
  ];

  return steps
    .sort((a, b) => a.step - b.step)
    .map((body) => {
      const ctx = (slices as Record<string, EngineContext<unknown> | undefined>)[body.engine];
      return {
        ...body,
        label: `Step ${body.step} → ${body.title}`,
        logs: sliceLogs(ctx),
        meta: ctx
          ? {
              engineConfidence: ctx.confidence,
              computedAt: ctx.computedAt ? new Date(ctx.computedAt).toISOString() : undefined,
              ms: ctx.ms,
              deterministic: ctx.deterministic,
              // A degraded engine still produces output — surfacing this stops
              // a partial-data step from reading as confidently as a full one.
              degraded: ctx.degraded?.mode,
              evidenceCount: (ctx.evidence ?? []).length,
            }
          : undefined,
      };
    });
}

// ── Step builders ─────────────────────────────────────────────────────────
// Each takes its own slice (possibly undefined) and answers one question.

function blank(
  engine: EngineSliceKey,
  title: string,
  question: string,
  note: string,
): StepBody {
  return {
    step: ENGINE_STEP[engine],
    engine,
    title,
    question,
    headline: note,
    details: [],
    status: 'no_data',
    decisive: false,
  };
}

function snapshotStep(s: SnapshotData | undefined): StepBody {
  const title = 'The numbers we pulled from Meta';
  const question = 'What did we actually measure, and when?';
  if (!s) return blank('snapshot', title, question, 'No snapshot was recorded for this cycle.');

  const raw = s as Record<string, unknown>;
  const spend = typeof raw.spend === 'number' ? raw.spend : undefined;
  const collected = s.collectedAt ? new Date(s.collectedAt) : undefined;

  const details: string[] = [];
  if (collected) details.push(`Figures were read from Meta at ${collected.toLocaleString('en-IN')}.`);
  if (spend !== undefined) details.push(`Spend in the measured window: ${money(spend)}.`);
  details.push('Every later step reads only from this snapshot, so the whole decision is based on one consistent set of numbers rather than figures that shifted mid-analysis.');

  return {
    step: ENGINE_STEP.snapshot,
    engine: 'snapshot',
    title,
    question,
    headline: collected
      ? `Live campaign figures were captured from Meta at ${collected.toLocaleString('en-IN')}.`
      : 'Live campaign figures were captured from Meta.',
    details,
    status: 'ok',
    decisive: false,
  };
}

function objectiveStep(o: ObjectiveData | undefined): StepBody {
  const title = 'What this campaign is being judged on';
  const question = 'What counts as success here?';
  if (!o) return blank('objective', title, question, 'No objective was resolved for this campaign.');

  const sourcePlain: Record<string, string> = {
    campaign_field: 'set explicitly on the campaign',
    meta_objective: "taken from Meta's campaign objective",
    company_default: 'your company default',
    inferred: 'inferred, because nothing explicit was set',
  };

  return {
    step: ENGINE_STEP.objective,
    engine: 'objective',
    title,
    question,
    headline: `Goal is ${words(o.objective)}, so the number that matters most is ${words(o.primaryKPI)}.`,
    details: [
      `That goal was ${sourcePlain[o.source] ?? words(o.source)}.`,
      o.supportingKPIs?.length
        ? `Also watched: ${o.supportingKPIs.map(words).join(', ')}.`
        : 'No secondary metrics are being watched.',
      o.policy?.scaleBudgetIf ? `Rule for spending more: ${o.policy.scaleBudgetIf}.` : '',
      o.policy?.pauseIf ? `Rule for stopping: ${o.policy.pauseIf}.` : '',
    ].filter(Boolean),
    status: 'ok',
    decisive: false,
  };
}

function lifecycleStep(l: LifecycleData | undefined, actionType: string): StepBody {
  const title = 'How settled this campaign is';
  const question = 'Is it old enough and stable enough to touch?';
  if (!l) return blank('lifecycle', title, question, 'No lifecycle stage was recorded.');

  const blocked = (l.blockedActions ?? []).find((b) => b.action === actionType);
  const days = Math.floor((l.ageHours ?? 0) / 24);
  const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${Math.round(l.ageHours ?? 0)} hours`;

  return {
    step: ENGINE_STEP.lifecycle,
    engine: 'lifecycle',
    title,
    question,
    headline: `It's ${age} old and ${STAGE_PLAIN[l.stage] ?? words(l.stage)} — ${
      // actionType is '' on cycle-level traces (no single decision being
      // explained) — say what the stage permits instead of quoting an
      // empty string.
      !actionType
        ? `permitted here: ${(l.allowedActions ?? []).map(words).join(', ') || 'nothing'}`
        : blocked
          ? `which BLOCKS "${words(actionType)}"`
          : `so "${words(actionType)}" is allowed`
    }.`,
    details: [
      l.metaLearningStage ? `Meta says this is in "${words(l.metaLearningStage)}".` : '',
      `Budget increases are ${l.gates?.canScale ? 'permitted' : 'not permitted'} at this stage; pausing is ${l.gates?.canPause ? 'permitted' : 'not permitted'}.`,
      blocked ? `Blocked because: ${blocked.reason}.` : '',
      `Next stage expected: ${STAGE_PLAIN[l.nextExpectedStage] ?? words(l.nextExpectedStage)}.`,
      `Being re-checked roughly every ${l.monitoringCadenceMinutes} minutes.`,
    ].filter(Boolean),
    status: 'ok',
    // Only decisive when it actually constrained this action.
    decisive: !!blocked,
  };
}

function trendStep(t: TrendData | undefined): StepBody {
  const title = 'Which way the numbers are moving';
  const question = 'Is this getting better or worse over time?';
  if (!t) return blank('trend', title, question, 'Not enough history to read a trend.');

  const details: string[] = [];
  // A slope is meaningless to read raw; state direction per metric instead.
  for (const [metric, r] of Object.entries(t.perMetric ?? {}).slice(0, 5)) {
    const dir = r.slope7d > 0 ? 'rising' : r.slope7d < 0 ? 'falling' : 'flat';
    const vs = Number.isFinite(r.vsBaseline)
      ? ` (${r.vsBaseline >= 0 ? '+' : ''}${Math.round(r.vsBaseline * 100)}% vs its own baseline)`
      : '';
    details.push(`${words(metric)} is ${dir} over 7 days${vs}.`);
  }
  for (const a of (t.anomalies ?? []).slice(0, 3)) {
    details.push(`Unusual: ${a.note}`);
  }
  details.push(
    `Stability ${pct(t.stabilityScore)} — ${
      (t.stabilityScore ?? 0) > 0.7
        ? 'the numbers are consistent enough to read as a real trend'
        : 'the numbers bounce around, so treat the direction with caution'
    }.`,
  );

  return {
    step: ENGINE_STEP.trend,
    engine: 'trend',
    title,
    question,
    headline: `Overall the campaign is ${DIRECTION_PLAIN[t.overallDirection] ?? words(t.overallDirection)}.`,
    details,
    status: 'ok',
    decisive: false,
  };
}

function revenueStep(
  r: RevenueData | undefined,
  o: ObjectiveData | undefined,
): StepBody {
  const title = 'Whether it is actually making money';
  const question = 'After costs, is this profitable?';
  if (!r) return blank('revenue', title, question, 'No revenue figures were available.');

  // A traffic/awareness/app campaign has no purchase expectation, so its
  // breakeven is 0 and every comparison against it is meaningless — this read
  // "below the 0.00x needed to break even", which sounds like a failure and
  // is really just the wrong question for this campaign.
  const revenueObjective =
    !o?.objective || ['sales', 'catalog_sales', 'retargeting'].includes(o.objective);
  if (!revenueObjective) {
    return {
      step: ENGINE_STEP.revenue,
      engine: 'revenue',
      title,
      question,
      headline: `Not measured on profit — this campaign optimises for ${words(o!.objective)}.`,
      details: [
        `Spend so far is real, but revenue is not the yardstick here; ${words(o!.primaryKPI)} is (see step 2).`,
        r.grossRevenue > 0
          ? `It did bring in ${money(r.grossRevenue)} of tracked revenue anyway — a bonus, not the goal.`
          : 'No tracked revenue, which is the expected outcome for this objective.',
      ],
      status: 'ok',
      decisive: false,
    };
  }

  const d = r.roasDecomposition;
  const details: string[] = [
    `Revenue ${money(r.grossRevenue)} gross, ${money(r.netRevenue)} after refunds and costs.`,
    // RevenueData.contributionMargin is a CURRENCY AMOUNT — the engine defines
    // it as `netRevenue * marginPct - spend` (revenue-engine.service.ts:163),
    // i.e. profit in rupees, not a ratio. Rendering it with pct() multiplied a
    // ₹8,338 profit by 100 and printed "833829%" on the one step whose entire
    // job is answering "is this making money?".
    `Contribution profit ${money(r.contributionMargin)} — what's left from sales after product costs and ad spend.`,
    `Break-even is ${times(r.breakeven?.roas)}; the profit target is ${times(r.targetROAS)} (twice break-even, so it scales with this product's margin instead of being one flat number).`,
  ];
  if (r.breakeven?.isProfitable && r.breakeven?.daysSinceBreakeven > 0) {
    details.push(`It has been above break-even for ${r.breakeven.daysSinceBreakeven} day(s).`);
  }
  if (d) {
    // Which lever is carrying (or dragging) ROAS — the actionable part.
    const parts = Object.entries(d)
      .filter(([, v]) => Number.isFinite(v?.delta) && Math.abs(v.delta) > 0.001)
      .sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta))
      .slice(0, 2)
      .map(([k, v]) => `${words(k)} ${v.delta >= 0 ? 'helped' : 'hurt'}`);
    if (parts.length) details.push(`Biggest movers behind the return: ${parts.join(', ')}.`);
  }

  return {
    step: ENGINE_STEP.revenue,
    engine: 'revenue',
    title,
    question,
    headline: r.breakeven?.isProfitable
      ? `Yes — profitable, earning above the ${times(r.breakeven?.roas)} it needs to break even.`
      : `No — currently below the ${times(r.breakeven?.roas)} needed to break even.`,
    details,
    status: 'ok',
    decisive: true,
  };
}

function signalStep(s: SignalData | undefined, firedSignal?: string): StepBody {
  const title = 'Specific things worth reacting to';
  const question = 'What stood out as unusual or actionable?';
  if (!s || !(s.signals ?? []).length) {
    return blank('signal', title, question, 'Nothing crossed a threshold this cycle.');
  }

  const signals = s.signals;
  const details = signals.slice(0, 6).map((sig) => {
    const mine = sig.kind === firedSignal ? ' ← this is the one that triggered this suggestion' : '';
    return `${words(sig.kind)} (${sig.severity}, ${pct(sig.strength)} sure): ${sig.reasoning}${mine}`;
  });
  details.push(
    'Each of these is a rule firing on measured numbers, not a judgement call — the rule that fired is shown above.',
  );

  return {
    step: ENGINE_STEP.signal,
    engine: 'signal',
    title,
    question,
    headline: `${signals.length} thing${signals.length === 1 ? '' : 's'} flagged: ${signals
      .slice(0, 3)
      .map((x) => words(x.kind))
      .join(', ')}${signals.length > 3 ? '…' : ''}.`,
    details,
    status: 'ok',
    decisive: !!firedSignal && signals.some((x) => x.kind === firedSignal),
  };
}

function diagnosisStep(d: DiagnosisData | undefined): StepBody {
  const title = 'Why it is happening';
  const question = 'What does the system think the underlying cause is?';
  if (!d) return blank('diagnosis', title, question, 'No root-cause analysis was recorded.');

  const top = (d.rootCauses ?? [])[0];
  const details: string[] = [];
  for (const rc of (d.rootCauses ?? []).slice(0, 3)) {
    details.push(
      `${rc.hypothesis} — ${pct(rc.confidence)} confident, points at ${words(rc.suggestedFocus)}${
        rc.evidenceSignals?.length ? `, based on: ${rc.evidenceSignals.map(words).join(', ')}` : ''
      }.`,
    );
  }
  if (d.leakDiagnosis && d.leakDiagnosis !== 'none') {
    details.push(`Where money is leaking: ${words(d.leakDiagnosis)}.`);
  }
  if (d.narrative) details.push(d.narrative);

  return {
    step: ENGINE_STEP.diagnosis,
    engine: 'diagnosis',
    title,
    question,
    headline: top
      ? `Most likely cause: ${top.hypothesis} (${pct(top.confidence)} confident) — the fix belongs in ${words(top.suggestedFocus)}.`
      : 'No single cause stood out.',
    details,
    status: 'ok',
    decisive: true,
  };
}

function businessStep(b: BusinessData | undefined): StepBody {
  const title = 'Your rules and spending limits';
  const question = 'What is the system allowed to do with your money?';
  if (!b) return blank('business', title, question, 'No business rules were loaded.');

  const p = b.budgetPolicy;
  const details: string[] = [];
  if (p) {
    details.push(
      `Weekly cap ${money(p.weeklyCapINR)}, of which ${money(p.weeklyCapUsedINR)} is used — ${money(p.weeklyCapRemainingINR)} left.`,
    );
    details.push(`No single campaign may exceed ${money(p.perCampaignCapINR)}.`);
  }
  if (b.activePromotions?.length) {
    details.push(`Live promotions: ${b.activePromotions.map((x) => x.name).join(', ')}.`);
  }
  if (b.seasonalContext) details.push(`Season: ${b.seasonalContext}.`);
  if (b.inventoryStatus) details.push(`Stock: ${words(b.inventoryStatus)}.`);
  details.push('These are hard limits enforced in code — the AI cannot talk its way past them.');

  return {
    step: ENGINE_STEP.business,
    engine: 'business',
    title,
    question,
    headline: p
      ? `${money(p.weeklyCapRemainingINR)} of this week's budget is still available to allocate.`
      : 'Business limits were applied.',
    details,
    status: 'ok',
    decisive: false,
  };
}

function portfolioStep(p: PortfolioData | undefined): StepBody {
  const title = 'How it compares to your other campaigns';
  const question = 'Is this the best place for the next rupee?';
  if (!p) return blank('portfolio', title, question, 'No cross-campaign comparison was made.');

  const details: string[] = [];
  for (const prop of (p.budgetProposals ?? []).slice(0, 4)) {
    const dir = prop.delta > 0 ? 'more' : 'less';
    details.push(
      `${prop.campaignId}: ${money(prop.currentINR)} → ${money(prop.proposedINR)} (${money(Math.abs(prop.delta))} ${dir}) — ${prop.reason}`,
    );
  }
  if (p.ranking?.length) {
    details.push(`Ranked tiers: ${p.ranking.slice(0, 5).map((r) => `${r.campaignId} = ${r.tier}`).join(', ')}.`);
  }
  details.push(
    `Concentration ${pct(p.concentration)} — ${
      (p.concentration ?? 0) > 0.6
        ? 'most of your spend sits in a few campaigns, so a single bad call hurts more'
        : 'spend is reasonably spread across campaigns'
    }.`,
  );

  return {
    step: ENGINE_STEP.portfolio,
    engine: 'portfolio',
    title,
    question,
    headline: `Across everything running, blended return is ${times(p.totalPortfolioROAS)}.`,
    details,
    status: 'ok',
    decisive: false,
  };
}

function forecastStep(f: ForecastData | undefined): StepBody {
  const title = 'Where this is heading if nothing changes';
  const question = 'What happens over the next week?';
  if (!f) return blank('forecast', title, question, 'Not enough history to project forward.');

  if (f.method === 'insufficient_history') {
    return {
      step: ENGINE_STEP.forecast,
      engine: 'forecast',
      title,
      question,
      headline: "Too little history to project — the campaign hasn't run long enough.",
      details: ['Any ₹ estimate on this suggestion is therefore a rough one.'],
      status: 'ok',
      decisive: false,
    };
  }

  const d7 = f.horizons?.next7d;
  const methodPlain: Record<string, string> = {
    ema_projection: 'recent days weighted more heavily than older ones',
    linear: 'a straight line through recent days',
    seasonal: 'recent days adjusted for weekly seasonality',
  };

  return {
    step: ENGINE_STEP.forecast,
    engine: 'forecast',
    title,
    question,
    headline: d7
      ? `Over 7 days: about ${money(d7.spend)} spent, ${money(d7.revenue)} back — roughly ${times(d7.roas)}.`
      : 'A projection was made.',
    details: [
      d7?.band
        ? `Realistic range on revenue: ${money(d7.band.lowRevenue)} to ${money(d7.band.highRevenue)}. The spread is the honest uncertainty, not a rounding error.`
        : '',
      d7?.conversions !== undefined ? `Expected purchases: about ${Math.round(d7.conversions)}.` : '',
      `Projected using ${methodPlain[f.method] ?? words(f.method)}.`,
    ].filter(Boolean),
    status: 'ok',
    decisive: true,
  };
}

function confidenceStep(c: ConfidenceData | undefined): StepBody {
  const title = 'How sure the system is';
  const question = 'Is the data good enough to act on?';
  if (!c) return blank('confidence', title, question, 'No confidence assessment was recorded.');

  const q = c.quality;
  const details: string[] = [];
  if (q) {
    details.push(`Data is ${Math.round((q.dataFreshnessSec ?? 0) / 60)} minutes old.`);
    details.push(`History depth ${q.historyDepthDays} day(s); coverage of the campaign ${pct(q.snapshotCoverage)}.`);
    details.push(
      `Statistical power ${pct(q.statisticalPower)} — ${
        (q.statisticalPower ?? 0) > 0.7
          ? 'enough conversions for this not to be noise'
          : 'thin data, so this could still be noise'
      }.`,
    );
  }
  if (c.gates?.reasonsBlocked?.length) {
    details.push(`Held back by: ${c.gates.reasonsBlocked.map(words).join(', ')}.`);
  }
  details.push(
    `Allowed to suggest: ${c.gates?.okToRecommend ? 'yes' : 'no'}. Allowed to act on its own: ${
      c.gates?.okToExecute ? 'yes' : 'no'
    }.`,
  );

  return {
    step: ENGINE_STEP.confidence,
    engine: 'confidence',
    title,
    question,
    headline: `${pct(c.overall)} confident overall${
      c.gates?.okToExecute === false ? ' — not enough to act without you' : ''
    }.`,
    details,
    status: 'ok',
    decisive: true,
  };
}

function memoryStep(m: MemoryData | undefined, actionType: string): StepBody {
  const title = 'What happened last time';
  const question = 'Have we tried this before, and did it work?';
  if (!m) return blank('memory', title, question, 'No past history was consulted.');

  const same = (m.pastActions ?? []).filter((a) => a.actionType === actionType);
  const details: string[] = [];
  for (const a of same.slice(0, 4)) {
    details.push(
      `${new Date(a.executedAt).toLocaleDateString('en-IN')}: ${words(a.actionType)} on ${a.targetId} → ${a.outcomeLabel}. ${a.context}`,
    );
  }
  for (const ci of (m.causalInsights ?? []).slice(0, 3)) {
    details.push(`Learned: ${ci.finding} (${pct(ci.confidence)} confident, isolated on ${words(ci.isolatedVariable)}).`);
  }
  if (!details.length) details.push('No directly comparable past action to learn from.');

  const improved = same.filter((a) => a.outcomeLabel === 'improved').length;
  const worsened = same.filter((a) => a.outcomeLabel === 'worsened').length;

  return {
    step: ENGINE_STEP.memory,
    engine: 'memory',
    title,
    question,
    headline: !actionType
      ? `${(m.pastActions ?? []).length} past action(s) on record for this campaign.`
      : same.length
        ? `"${words(actionType)}" has been tried ${same.length} time(s) on this campaign — ${improved} helped, ${worsened} backfired.`
        : `"${words(actionType)}" has not been tried on this campaign before.`,
    details,
    status: 'ok',
    decisive: same.length > 0,
  };
}

function recommendationStep(
  r: RecommendationData | undefined,
  decision: TraceDecision,
): StepBody {
  const title = 'What it decided to suggest';
  const question = 'Of everything it could do, why this?';
  if (!r) return blank('recommendation', title, question, 'No recommendation slice was recorded.');

  const mine = (r.actions ?? []).find((a) => a.actionId === decision.actionId);
  const details: string[] = [];

  if (r.candidatesConsidered !== undefined) {
    details.push(`${r.candidatesConsidered} possible action(s) were considered; ${(r.actions ?? []).length} survived the filters.`);
  }
  if (r.gateReasonCounts && Object.keys(r.gateReasonCounts).length) {
    details.push(
      `Rejected candidates were blocked by: ${Object.entries(r.gateReasonCounts)
        .map(([k, v]) => `${words(k)} (${v})`)
        .join(', ')}.`,
    );
  }
  if (mine) {
    details.push(`Expected effect: ${words(mine.expectedImpact?.metric)} ${mine.expectedImpact?.deltaPct >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(mine.expectedImpact?.deltaPct ?? 0))}%.`);
    details.push(`Risk rated ${mine.risk}; priority score ${mine.score?.toFixed?.(2) ?? mine.score}.`);
    if (mine.gatedBy?.length) details.push(`Flagged by: ${mine.gatedBy.map(words).join(', ')}.`);
    for (const e of (mine.evidenceChain ?? []).slice(0, 6)) {
      details.push(`Evidence — ${e.step}: ${e.source}`);
    }
  }
  const others = (r.actions ?? []).filter((a) => a.actionId !== decision.actionId);
  if (others.length) {
    details.push(
      `Also proposed alongside this: ${others.map((a) => `${words(a.type)} (${money(a.expectedProfitDeltaINR7d)})`).join(', ')}.`,
    );
  }

  return {
    step: ENGINE_STEP.recommendation,
    engine: 'recommendation',
    title,
    question,
    headline: decision.actionType
      ? `${words(decision.actionType)} on ${decision.targetId} — worth about ${money(
          decision.expectedProfitDeltaINR7d,
        )} of extra profit over 7 days.`
      : (r.actions ?? []).length
        ? `${(r.actions ?? []).length} action(s) proposed: ${(r.actions ?? [])
            .map((a) => words(a.type))
            .join(', ')}.`
        : 'Nothing was proposed this cycle.',
    details,
    status: 'ok',
    decisive: true,
  };
}

function explainabilityStep(
  e: ExplainabilityData | undefined,
  actionId: string,
): StepBody {
  const title = 'The reasoning, in its own words';
  const question = 'How does the system justify this?';
  if (!e) return blank('explainability', title, question, 'No written explanation was produced.');

  const mine = e.perAction?.[actionId];
  if (!mine) {
    return blank('explainability', title, question, 'No written explanation for this specific action.');
  }

  return {
    step: ENGINE_STEP.explainability,
    engine: 'explainability',
    title,
    question,
    headline: mine.summary || 'A written justification was produced.',
    details: [
      mine.reasoning || '',
      // The counterfactual is the most decision-useful line here: it says what
      // is expected to happen if you decline.
      mine.counterfactual ? `If you do nothing instead: ${mine.counterfactual}` : '',
      mine.llmRendered && mine.llmRendered !== mine.reasoning ? mine.llmRendered : '',
    ].filter(Boolean),
    status: 'ok',
    decisive: true,
  };
}

function executionStep(x: ExecutionData | undefined, actionId: string): StepBody {
  const title = 'Whether anything was actually changed';
  const question = 'Did the system touch my live campaign?';
  if (!x) {
    return {
      step: ENGINE_STEP.execution,
      engine: 'execution',
      title,
      question,
      headline: 'Nothing was changed — this is waiting for your approval.',
      details: ['The automatic cascade never writes to Meta. Only your approval does.'],
      status: 'ok',
      decisive: false,
    };
  }

  const applied = (x.applied ?? []).find((a) => a.actionId === actionId);
  const deferred = (x.deferred ?? []).find((a) => a.actionId === actionId);
  const failed = (x.failed ?? []).find((a) => a.actionId === actionId);

  let headline = 'Nothing was changed — this is waiting for your approval.';
  const details: string[] = [];
  if (applied) {
    headline = `Applied to Meta at ${new Date(applied.appliedAt).toLocaleString('en-IN')}.`;
    details.push(
      applied.rollback?.supported ? 'This change can be rolled back.' : 'This change cannot be automatically rolled back.',
    );
  } else if (failed) {
    headline = `Tried and failed: ${failed.error}`;
    details.push(`Rollback: ${words(failed.rollback)}.`);
  } else if (deferred) {
    headline = `Held back — ${deferred.reason}.`;
    details.push('The automatic cascade never writes to Meta; every action it produces is deferred by design.');
  }

  return {
    step: ENGINE_STEP.execution,
    engine: 'execution',
    title,
    question,
    headline,
    details,
    status: 'ok',
    decisive: !!(applied || failed),
  };
}

function learningStep(l: LearningData | undefined): StepBody {
  const title = 'What it learned afterwards';
  const question = 'Did past predictions turn out to be right?';
  if (!l) {
    return blank('learning', title, question, 'Nothing to learn from yet — this measures actions after they run.');
  }

  const details: string[] = [];
  for (const m of (l.measurements ?? []).slice(0, 4)) {
    details.push(`After ${m.horizon}, the change ${m.outcomeLabel}.`);
  }
  for (const c of (l.calibrations ?? []).slice(0, 4)) {
    details.push(
      `${words(c.engine)} predicted ${c.predicted?.toFixed?.(2) ?? c.predicted} for ${words(c.field)}, actual was ${
        c.actual?.toFixed?.(2) ?? c.actual
      } — off by ${c.calibrationError?.toFixed?.(2) ?? c.calibrationError}.`,
    );
  }
  for (const u of (l.updates ?? []).slice(0, 4)) {
    details.push(`Adjusted ${words(u.target)} "${words(u.key)}": ${String(u.oldValue)} → ${String(u.newValue)} because ${u.reason}.`);
  }
  if (!details.length) details.push('No completed actions to measure yet in this cycle.');

  return {
    step: ENGINE_STEP.learning,
    engine: 'learning',
    title,
    question,
    headline: (l.updates ?? []).length
      ? `${l.updates.length} internal threshold(s) were adjusted based on how past predictions turned out.`
      : 'No adjustments were needed this cycle.',
    details,
    status: 'ok',
    decisive: false,
  };
}
