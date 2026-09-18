import { AGENTS_BY_KEY, BRAIN_AGENTS } from './agents.registry';
import type {
  BrainAgentKey,
  BrainAllocation,
  BrainDecision,
  BrainDecisionKind,
  BrainEvidence,
  BrainRunDetail,
  BrainRunEvent,
  BrainRunOutput,
  BrainRunStatus,
  BrainRunStep,
  BrainRunSummary,
  BrainRunTrigger,
} from './brain.types';

/**
 * Translation. Foundry and the 91astro brain each have their own vocabulary; the console has one
 * of its own, written before either was wired up. Everything that reconciles the three lives here
 * so the service stays about transport and the controller stays about HTTP.
 *
 * The rule the whole file is built on: WHEN A SHAPE DOES NOT SAY SOMETHING, SAY SO. A missing cost
 * is null, not zero. An unrecognised trust token is `unknown` provenance, not `measured`. An
 * unmeasured decision's outcome is null, not an invented "executed". The console renders each of
 * those differently on purpose — `BrainEvidence.provenance` and `BrainDecision.outcome` exist
 * precisely so an inference is never dressed as a fact, and a mapper that defaults its way out of
 * an absence defeats the types rather than satisfying them.
 */

// ── small helpers ──────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `select_mode` → "Select mode". Foundry node keys are snake_case and mean something to a reader. */
export function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

// ── runs ───────────────────────────────────────────────────────────────────

export function agentKeyFor(foundryAgentId: string): BrainAgentKey | null {
  const found = BRAIN_AGENTS.find((a) => a.foundryAgentId === foundryAgentId);
  return found ? found.key : null;
}

/**
 * Foundry's run status vocabulary → the console's.
 *
 * `paused` is the one that matters: Foundry pauses a run to ask a person something, which the
 * console draws as `waiting_for_human` — a state with an action attached, not a stalled run. A
 * status this bridge has never seen maps to `running`, because the alternative (calling it
 * `failed`) would put a red badge on a run that is very likely still working.
 */
export function mapRunStatus(
  status: unknown,
  pauseReason?: unknown,
): BrainRunStatus {
  const s = (str(status) ?? '').toLowerCase();
  if (s === 'paused' || s === 'waiting' || str(pauseReason))
    return 'waiting_for_human';
  if (s === 'queued' || s === 'pending' || s === 'scheduled') return 'queued';
  if (s === 'succeeded' || s === 'success' || s === 'completed' || s === 'done')
    return 'succeeded';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled' || s === 'aborted')
    return 'cancelled';
  return 'running';
}

export function mapRunTrigger(trigger: unknown): BrainRunTrigger {
  const t = (str(trigger) ?? '').toLowerCase();
  if (t === 'schedule' || t === 'cron' || t === 'scheduled') return 'schedule';
  if (t === 'slack') return 'slack';
  if (t === 'webhook' || t === 'agent' || t === 'dispatch') return 'brain';
  return 'dashboard';
}

export function mapRunSummary(
  row: Record<string, unknown>,
): BrainRunSummary | null {
  const runId = str(row.run_id) ?? str(row.id);
  const agentId = str(row.agent_id);
  if (!runId || !agentId) return null;
  const key = agentKeyFor(agentId);
  // A run belonging to an agent this console does not show is dropped rather than relabelled.
  // The run token may grant agents from entirely different products; listing a PRD writer's run on
  // a marketing page would be a lie about what this system does.
  if (!key) return null;
  const definition = AGENTS_BY_KEY.get(key);
  return {
    runId,
    agentKey: key,
    agentName: definition?.name ?? humanizeKey(key),
    status: mapRunStatus(row.status, row.pause_reason),
    trigger: mapRunTrigger(row.trigger),
    startedAt: str(row.started_at) ?? new Date(0).toISOString(),
    finishedAt: str(row.finished_at),
    durationMs: num(row.duration_ms),
    // Foundry reports null while a run is unsettled, and null is the truth — a zero here would
    // read on the page as "this run was free".
    costUsd: num(row.cost_usd),
    summary: str(row.summary) ?? str(row.error),
  };
}

export function mapRunStep(step: Record<string, unknown>): BrainRunStep {
  const key = str(step.node_key) ?? `step_${num(step.idx) ?? 0}`;
  const s = (str(step.status) ?? '').toLowerCase();
  const state: BrainRunStep['state'] =
    s === 'ok' ||
    s === 'succeeded' ||
    s === 'success' ||
    s === 'completed' ||
    s === 'done'
      ? 'done'
      : s === 'failed' || s === 'error'
        ? 'failed'
        : s === 'skipped'
          ? 'skipped'
          : s === 'running' || s === 'in_progress'
            ? 'running'
            : 'pending';
  return {
    key,
    label: str(step.title) ?? humanizeKey(key),
    state,
    detail: str(step.summary) ?? str(step.error),
  };
}

/**
 * Steps become the event stream.
 *
 * Foundry has no event feed — it has a run with steps, each carrying a status and a time. So the
 * console's log is derived rather than streamed, and `seq` is the step index, which is already
 * monotonic within a run and already what a `?after=` cursor needs. Retries appear as separate
 * steps with the same `node_key`, which is honest: a step that timed out twice before succeeding
 * really did happen three times, and collapsing them would hide the most useful thing in the log.
 *
 * A settled run appends one terminal event so the reader sees an ending rather than a log that
 * simply stops.
 */
export function mapRunEvents(run: Record<string, unknown>): BrainRunEvent[] {
  const steps = arr(run.steps).map(obj);
  const events: BrainRunEvent[] = steps.map((step, index) => {
    const mapped = mapRunStep(step);
    const level: BrainRunEvent['level'] =
      mapped.state === 'failed'
        ? 'error'
        : mapped.state === 'done'
          ? 'success'
          : 'info';
    return {
      seq: num(step.idx) ?? index + 1,
      at:
        str(step.finished_at) ??
        str(step.started_at) ??
        new Date().toISOString(),
      level,
      message: mapped.detail
        ? `${mapped.label} — ${mapped.detail}`
        : mapped.label,
    };
  });
  if (run.finished === true) {
    const status = mapRunStatus(run.status, run.pause_reason);
    const last = events.length ? events[events.length - 1].seq : 0;
    events.push({
      seq: last + 1,
      at: str(run.finished_at) ?? new Date().toISOString(),
      level:
        status === 'succeeded'
          ? 'success'
          : status === 'failed'
            ? 'error'
            : 'warn',
      message:
        str(run.error) ??
        str(run.summary) ??
        (status === 'succeeded' ? 'Run finished.' : `Run ${status}.`),
    });
  }
  return events;
}

// ── evidence ───────────────────────────────────────────────────────────────

/**
 * The manifest's `trust` token → the console's three-way provenance.
 *
 * Read from a source of record is `measured`. Derived from a contrast, a cohort or a written-down
 * note is `estimate` — `accepted_learning_support` entries say so themselves ("a contrast, not a
 * cause"), and `recorded_platform_fact` entries say "recorded from project notes, not re-read".
 *
 * THE DEFAULT IS `unknown`, DELIBERATELY. A trust token this bridge has not seen is a token whose
 * epistemic status nobody here has established, and the safe direction for an unknown is not
 * `measured`. Adding a token to the measured list should be a decision somebody makes, not
 * something that happens by falling through a switch.
 */
const MEASURED_TRUST = new Set([
  'current_meta_read',
  'current_scorecard',
  'verified_current',
  'current_offering',
  'active_policy',
  'recorded_valid',
  'gap_register',
]);
const ESTIMATE_TRUST = new Set([
  'accepted_learning_support',
  'recorded_platform_fact',
  'cohort_contrast',
  'inferred',
]);

export function provenanceForTrust(
  trust: unknown,
): BrainEvidence['provenance'] {
  const t = (str(trust) ?? '').toLowerCase();
  if (MEASURED_TRUST.has(t)) return 'measured';
  if (ESTIMATE_TRUST.has(t)) return 'estimate';
  return 'unknown';
}

/** One `evidence_manifest` entry from `validate_review` → one console evidence row. */
export function mapManifestEntry(
  entry: Record<string, unknown>,
): BrainEvidence | null {
  const ref = str(entry.ref);
  if (!ref) return null;
  const summary = str(entry.summary);
  const limitations = str(entry.limitations);
  return {
    label: ref,
    // The summary is the claim; the limitation is inseparable from it. v2 writes limitations on
    // every manifest entry precisely so a figure never travels without its caveat, and dropping
    // them here would undo that at the last step before a human reads it.
    value: limitations
      ? `${summary ?? ref} (${limitations})`
      : (summary ?? ref),
    source: str(entry.source_type) ?? str(entry.source_id) ?? 'brain',
    freshness: str(entry.window) ?? str(entry.source_version),
    provenance: provenanceForTrust(entry.trust),
  };
}

/**
 * A decision's `evidence_ids` → evidence rows.
 *
 * These are POINTERS (`policies:7`, `computed:product_scorecard`), not values: the bridge has not
 * read the row behind them, so every one is `unknown` provenance. Resolving them would mean a read
 * per citation per decision on every page load, and a citation the reader can chase is already the
 * thing `decisions_citing` exists to answer.
 */
export function mapEvidenceIds(ids: unknown): BrainEvidence[] {
  return arr(ids)
    .map((raw): BrainEvidence | null => {
      if (typeof raw === 'string' && raw.trim()) {
        const ref = raw.trim();
        const table = ref.includes(':')
          ? ref.slice(0, ref.indexOf(':'))
          : 'brain';
        return {
          label: table,
          value: ref,
          source: 'cited',
          freshness: null,
          provenance: 'unknown',
        };
      }
      const row = obj(raw);
      const table = str(row.table);
      const id = num(row.id) ?? str(row.id);
      if (!table || id === null) return null;
      return {
        label: table,
        value: `${table}:${String(id)}`,
        source: 'cited',
        freshness: null,
        provenance: 'unknown',
      };
    })
    .filter((e): e is BrainEvidence => e !== null);
}

// ── decisions ──────────────────────────────────────────────────────────────

function decisionKind(
  chosen: Record<string, unknown>,
  mode: string | null,
): BrainDecisionKind {
  const action = (str(chosen.action) ?? '').toLowerCase();
  if (action.includes('pause') || action.includes('stop')) return 'pause';
  if (action.includes('scale')) return 'scale';
  if (action.includes('creative')) return 'creative';
  if (action.includes('launch')) return 'launch';
  if (action.includes('budget') || action.includes('allocat')) return 'budget';
  if (action.includes('hold') || action.includes('wait')) return 'hold';
  if ((mode ?? '') === 'allocate') return 'budget';
  return 'hold';
}

export function mapDecision(
  row: Record<string, unknown>,
): BrainDecision | null {
  const id = num(row.id) ?? str(row.id);
  if (id === null) return null;
  const chosen = obj(row.chosen);
  const mode = str(row.mode);
  const outcome =
    row.outcome === null || row.outcome === undefined ? null : obj(row.outcome);
  const confidence = num(row.confidence);
  return {
    id: String(id),
    at: str(row.decided_at) ?? str(row.created_at) ?? new Date(0).toISOString(),
    kind: decisionKind(chosen, mode),
    headline:
      str(chosen.headline) ??
      str(chosen.next_action) ??
      str(row.question) ??
      str(row.scope) ??
      'Decision',
    rationale: str(row.rationale) ?? str(chosen.reason) ?? '',
    product: str(row.offering_slug),
    // `confidence` is NOT NULL in the schema, so a missing one means the row did not parse the way
    // this mapper expects — 0 says "no confidence stated", which is the readable form of that.
    confidence: confidence ?? 0,
    evidence: mapEvidenceIds(row.evidence_ids),
    // Null until an outcome was actually recorded. The console styles a decision with an outcome
    // as a proven result; inventing one here would turn every proposal into a claimed success.
    outcome:
      outcome && Object.keys(outcome).length
        ? {
            state: 'measured',
            label:
              str(outcome.summary) ??
              str(outcome.label) ??
              str(outcome.result) ??
              'Outcome recorded',
            delta: str(outcome.delta),
            direction:
              str(outcome.direction) === 'up'
                ? 'up'
                : str(outcome.direction) === 'down'
                  ? 'down'
                  : 'flat',
          }
        : null,
    runId: str(row.run_id),
  };
}

// ── run output ─────────────────────────────────────────────────────────────

function mapAllocations(
  rows: unknown[],
  budget: number | null,
): BrainAllocation[] {
  return rows
    .map(obj)
    .map((row): BrainAllocation | null => {
      const product = str(row.offering_slug);
      const amount = num(row.amount_inr);
      if (!product || amount === null) return null;
      return {
        product,
        dailyBudget: amount,
        // The brain's allocation block does not carry what the product had yesterday, and the
        // bridge is not going to guess it from today's number.
        previousDailyBudget: null,
        share: budget && budget > 0 ? amount / budget : 0,
        reason: str(row.reason) ?? '',
        health: 'unknown',
      };
    })
    .filter((a): a is BrainAllocation => a !== null);
}

/**
 * The run's node outputs → the console's 5-way output union.
 *
 * Foundry keys a run's `output` by NODE, so both the answer (`final_response`) and the validated
 * review (`validate_review`) are in reach. An allocation is reported as an allocation ONLY when
 * `allocation_validated` is true: the validator is what checked the arithmetic, and a proposal that
 * did not pass it is still an answer, not a spend plan. That includes the zero-spend case, which is
 * a valid, complete plan — a day where nothing is allocated and the reason is stated renders as an
 * allocation with no rows, not as a failure.
 */
export function mapRunOutput(output: unknown): BrainRunOutput | null {
  const nodes = obj(output);
  const final = obj(nodes.final_response);
  const validated = obj(nodes.validate_review);

  if (validated.allocation_validated === true) {
    const review = obj(validated.review);
    const allocation = obj(review.allocation);
    const budget = num(allocation.budget_inr);
    const rows = mapAllocations(arr(allocation.allocations), budget);
    const notes = arr(validated.allocation_notes)
      .map((n) => str(n))
      .filter((n): n is string => n !== null);
    return {
      kind: 'allocation',
      dailyTotal: budget ?? rows.reduce((sum, row) => sum + row.dailyBudget, 0),
      rationale: str(allocation.reasoning) ?? notes.join(' ') ?? '',
      allocations: rows,
    };
  }

  const body = str(final.response);
  if (!body && !str(final.goal)) return null;
  const evidence = arr(validated.evidence_manifest)
    .map(obj)
    .map(mapManifestEntry)
    .filter((e): e is BrainEvidence => e !== null);
  return {
    kind: 'answer',
    headline: str(final.goal) ?? 'Review',
    body: body ?? str(final.reason) ?? '',
    evidence,
  };
}

export function mapRunDetail(
  run: Record<string, unknown>,
  summary: BrainRunSummary,
  input: Record<string, string>,
): BrainRunDetail {
  return {
    ...summary,
    input,
    steps: arr(run.steps).map(obj).map(mapRunStep),
    output: mapRunOutput(run.output),
    error: str(run.error),
  };
}
