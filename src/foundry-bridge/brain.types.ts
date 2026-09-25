/**
 * The response contract for the Brain console.
 *
 * This mirrors `src/types/brain.ts` in the Marketing-Agent-Dashboard repo. The duplication is
 * deliberate: they are separate deployables with separate release cycles, and a shared package
 * would couple them for the sake of ~200 lines of interface. The dashboard's copy is canonical —
 * if the two ever disagree, this file is the one that is wrong, because the frontend is already
 * built against its own.
 *
 * Two shapes carry meaning that is easy to flatten by accident, and must not be:
 *
 *   `BrainEvidence.provenance` — measured | estimate | unknown. The design brief's first principle
 *   is "trust is visible"; defaulting everything to `measured` would render an inference as a fact.
 *
 *   `BrainDecision.outcome` — null until an outcome is actually measured. An unmeasured decision
 *   must never be styled as a verified result, so null is the honest value and not a gap to fill.
 */

export type BrainAgentKey =
  | 'brain'
  | 'competitor-research'
  | 'campaign-report'
  | 'performance-analyst'
  | 'creative-producer'
  | 'creative-curator'
  | 'campaign-builder'
  | 'campaign-launcher';

export type BrainInvocation = 'on_demand' | 'brain_triggered' | 'scheduled';
export type BrainStage =
  | 'understand'
  | 'create'
  | 'control'
  | 'improve'
  | 'prove';
export type BrainAgentStatus = 'live' | 'draft' | 'paused';

export interface BrainAgentInput {
  key: string;
  label: string;
  hint?: string;
  type: 'text' | 'textarea' | 'select' | 'number';
  required: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
}

/** The static half of an agent — everything except its live run state. */
export interface BrainAgentDefinition {
  key: BrainAgentKey;
  foundryAgentId: string;
  name: string;
  whatItDoes: string;
  invocation: BrainInvocation;
  stage: BrainStage;
  status: BrainAgentStatus;
  schedule: string | null;
  inputs: BrainAgentInput[];
}

/**
 * One schedule or webhook that can start an agent.
 *
 * `enabled` is the only field this console may change. Everything else — the cron, the name, the
 * kind — is read-only here and lives in Studio, because changing WHEN something runs is a
 * different act from turning a known schedule back on after someone paused it.
 */
export interface BrainTrigger {
  id: string | null;
  name: string;
  /** 'schedule' | 'webhook' | 'app_event' — what starts the agent. */
  source: string;
  /** The 5-field cron for a schedule, null for anything else. */
  cron: string | null;
  enabled: boolean;
  /** Foundry's own word: active, paused, needs_connection… */
  status: string;
}

export interface BrainAgent extends BrainAgentDefinition {
  nextRunAt: string | null;
  lastRun: BrainRunSummary | null;
  /**
   * Whether the Foundry run token actually grants this agent.
   *
   * Separate from `status`, which is what the agent IS, and from `invocation`, which is who may
   * start it. An agent can be live, on-demand, and still unrunnable here because the token was
   * never widened to include it — and the only way the console could previously discover that was
   * to start a run and read the refusal out of a 502.
   */
  runnable: boolean;
}

export type BrainRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type BrainRunTrigger = 'dashboard' | 'brain' | 'schedule' | 'slack';

export interface BrainRunSummary {
  runId: string;
  agentKey: BrainAgentKey;
  agentName: string;
  status: BrainRunStatus;
  trigger: BrainRunTrigger;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  summary: string | null;
}

export interface BrainRunStep {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail: string | null;
}

export interface BrainRunDetail extends BrainRunSummary {
  input: Record<string, string>;
  steps: BrainRunStep[];
  output: BrainRunOutput | null;
  error: string | null;
}

export type BrainEventLevel = 'info' | 'success' | 'warn' | 'error';

export interface BrainRunEvent {
  /** Monotonic within a run — the cursor, exactly like pipeline-bridge. */
  seq: number;
  at: string;
  level: BrainEventLevel;
  message: string;
}

export interface BrainEventPage {
  events: BrainRunEvent[];
  cursor: number;
  done: boolean;
}

export interface BrainEvidence {
  label: string;
  value: string;
  source: string;
  freshness: string | null;
  provenance: 'measured' | 'estimate' | 'unknown';
}

export interface BrainAllocation {
  product: string;
  dailyBudget: number;
  previousDailyBudget: number | null;
  share: number;
  reason: string;
  health: 'good' | 'watch' | 'bad' | 'unknown';
}

export interface BrainLearning {
  id: string;
  statement: string;
  confidence: number;
  product: string | null;
  evidence: BrainEvidence[];
}

export interface BrainIdea {
  id: string;
  title: string;
  angle: string;
  product: string;
  rationale: string;
  state: 'proposed' | 'briefed' | 'rejected';
}

export interface BrainFinding {
  id: string;
  headline: string;
  detail: string;
  severity: 'good' | 'watch' | 'bad' | 'neutral';
  metric: string | null;
}

export interface BrainReportHighlight {
  label: string;
  value: string;
  delta: string | null;
  direction: 'up' | 'down' | 'flat';
}

export type BrainRunOutput =
  | {
      kind: 'answer';
      headline: string;
      body: string;
      evidence: BrainEvidence[];
    }
  | {
      kind: 'allocation';
      dailyTotal: number;
      rationale: string;
      allocations: BrainAllocation[];
    }
  | {
      kind: 'report';
      title: string;
      period: string;
      href: string | null;
      slackPermalink: string | null;
      highlights: BrainReportHighlight[];
      summary: string;
    }
  | {
      kind: 'research';
      observationsRead: number;
      learnings: BrainLearning[];
      ideas: BrainIdea[];
    }
  | {
      kind: 'analysis';
      findings: BrainFinding[];
      learningsWritten: number;
      nextBrief: string | null;
    };

export type BrainDecisionKind =
  | 'budget'
  | 'pause'
  | 'scale'
  | 'creative'
  | 'launch'
  | 'hold';

export interface BrainDecision {
  id: string;
  at: string;
  kind: BrainDecisionKind;
  headline: string;
  rationale: string;
  product: string | null;
  confidence: number;
  evidence: BrainEvidence[];
  outcome: {
    state: 'executed' | 'measured';
    label: string;
    delta: string | null;
    direction: 'up' | 'down' | 'flat';
  } | null;
  runId: string | null;
}

export type BrainStageKey = 'producer' | 'curator' | 'builder' | 'launcher';

export type BrainStageState =
  | 'idle'
  | 'running'
  | 'waiting_for_human'
  | 'done'
  | 'blocked'
  | 'failed';

export interface BrainArtifact {
  id: string;
  kind: 'creative' | 'campaign' | 'brief' | 'report';
  label: string;
  meta: string | null;
  thumbUrl: string | null;
  href: string | null;
}

export interface BrainPipelineStage {
  key: BrainStageKey;
  agentKey: BrainAgentKey;
  label: string;
  description: string;
  state: BrainStageState;
  runId: string | null;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  artifacts: BrainArtifact[];
  gateId: string | null;
}

export interface BrainPipelineRun {
  pipelineRunId: string;
  product: string;
  triggeredBy: string;
  startedAt: string;
  status: BrainRunStatus;
  headline: string;
  stages: BrainPipelineStage[];
  /** Null when the brain's read carried no `budget_authority` (an older brain). */
  budgetAuthority?: BrainBudgetAuthority | null;
}

/**
 * `plan_approval` is a fourth kind the original console did not have, and it is not an invention:
 * `approvals.gate` allows plan | build | launch | scale, and a `plan` gate is the day's spend plan
 * with no campaign attached. Forcing it into `campaign_launch` would have meant rendering a
 * campaign name, budget and placements for something that has none.
 */
export type BrainGateKind =
  | 'creative_craft'
  | 'idea_selection'
  | 'campaign_launch'
  | 'plan_approval';

export interface BrainGateCreative {
  id: string;
  label: string;
  imageUrl: string | null;
  copy: string;
  format: string;
  language: string;
  verdict: 'fit' | 'near_miss' | 'unfit';
  rubric: Array<{ criterion: string; score: number; note: string | null }>;
}

export interface BrainGatePlan {
  planDate: string | null;
  budgetInr: number | null;
  /** The whole review the Brain wrote for a person to read. Presented verbatim, not parsed. */
  summary: string;
  /** False means the gate has not reached Slack yet — this console is seeing it first. */
  posted: boolean;
}

export interface BrainGateCampaign {
  name: string;
  objective: string;
  dailyBudget: number;
  audience: string;
  placements: string;
  creatives: BrainGateCreative[];
  levels: Array<{ label: string; value: string; note: string | null }>;
  checks: Array<{ label: string; passed: boolean; note: string | null }>;
}

export type BrainGatePayload =
  | { kind: 'creative_craft'; creatives: BrainGateCreative[] }
  | { kind: 'idea_selection'; ideas: BrainIdea[] }
  | { kind: 'campaign_launch'; campaign: BrainGateCampaign }
  | { kind: 'plan_approval'; plan: BrainGatePlan };

export type BrainGateActionKey = 'approve' | 'reject' | 'revise';

export interface BrainGateAction {
  key: BrainGateActionKey;
  label: string;
  tone: 'primary' | 'danger' | 'ghost';
  requiresNote: boolean;
}

export interface BrainGate {
  gateId: string;
  kind: BrainGateKind;
  title: string;
  summary: string;
  askedBy: string;
  askedAt: string;
  product: string | null;
  slackChannel: string | null;
  slackPermalink: string | null;
  expiresAt: string | null;
  runId: string | null;
  payload: BrainGatePayload;
  actions: BrainGateAction[];
  selection: 'none' | 'single' | 'multiple';
  /**
   * The brain's own gate type for a spend gate (`approvals.gate`), null for idea/creative gates.
   *
   * `kind` folds build, launch and scale into `campaign_launch` for layout, but what an
   * "approve at <amount>" DOES differs per gate type, so the console needs the real one to say it.
   */
  spendGate?: BrainSpendGate | null;
  /** The pipeline run this gate names, when it names one. A plan gate usually does not. */
  pipelineRunId?: string | null;
}

export type BrainSpendGate = 'plan' | 'build' | 'launch' | 'scale';

export interface BrainGateDecisionBody {
  action: BrainGateActionKey;
  note?: string;
  selectedIds?: string[];
  /**
   * "Approve, but at this daily amount" — the console's equivalent of Slack's `approve at <n>`.
   *
   * Recorded on the approval row as `amount_override_inr`, and it is NOT only a record. On an
   * approved decision the brain's `approval_record` acts on it, per gate type:
   *
   *   - BUILD gate: the open run's `creative_contract.audience_plan` daily budgets are RESCALED to
   *     sum to this amount (stamped `budget_source = approval:<id>`), in the same transaction as the
   *     decision. That contract is what the Builder builds from.
   *   - PLAN gate: rescaled the same way ONLY when the gate names exactly one `pipeline_run_id`.
   *     A plan gate covering several runs (or none) is ambiguous — day total or one launch? — so
   *     nothing is rescaled and the reason comes back as `budget_rescale_skipped`.
   *   - LAUNCH gate: the Launcher applies the amount to the live Meta ad-set budget when it
   *     activates the campaign.
   *
   * What the brain actually did comes back on the decision (`BrainGateDecisionResult`), and the
   * console shows it rather than predicting it.
   */
  amountOverrideInr?: number;
}

/** One contract the brain rescaled because an approval carried an amount. */
export interface BrainBudgetRescale {
  pipelineRunId: string;
  /** `approval:<id>` — the decision that now governs this run's budget. */
  source: string | null;
  authorisedDailyBudgetInr: number | null;
  contractTotalBeforeInr: number | null;
  contractTotalInr: number | null;
  /** False when the contract had nothing to rescale (no daily audience budgets) — `why` says so. */
  rescaled: boolean;
  why: string | null;
  /** Set when a rescaled audience is above Meta MCP's per-ad-set daily cap; Meta will refuse it. */
  exceedsAdsetCap: {
    capInr: number | null;
    entries: string[];
    note: string | null;
  } | null;
}

/**
 * What a gate decision did, beyond being recorded.
 *
 * `budgetRescale` is null when the brain said nothing about budgets (no amount was given, or an
 * older brain); an empty list means it considered the amount and touched no contract, which is
 * exactly when `budgetRescaleSkipped` carries the reason.
 */
export interface BrainGateDecisionResult {
  ok: true;
  budgetRescale: BrainBudgetRescale[] | null;
  budgetRescaleSkipped: string | null;
}

/**
 * Which budget governs a pipeline run, as the brain states it (`pipeline_run_read` →
 * `budget_authority`). The console reads this rather than summing the audience plan itself: the
 * sum is only one of the numbers, and the brain is the one place that compares them.
 */
export interface BrainBudgetAuthority {
  authorisedDailyBudgetInr: number | null;
  /** Raw source: `approval:<id>` or `daily_plan:<date>`, or null when nothing authorises it. */
  source: string | null;
  /** The same, in words: "Approved amount (gate 48)" or "The day's plan for 2026-09-23". */
  sourceLabel: string | null;
  contractTotalInr: number | null;
  /** False means the contract and the authority disagree — the Builder must not build it. */
  consistent: boolean;
  why: string | null;
}

/**
 * One turn of a thread with the Brain.
 *
 * A turn is an EXCHANGE, not a message: the user turn and the brain turn answering it carry the
 * same `turnIndex`. That is the brain's own shape — `conversation_turns` is unique on
 * (session, turn, role) — and flattening it into a message list would lose which answer belongs to
 * which question the moment two are asked in quick succession.
 */
export interface BrainConversationTurn {
  turnIndex: number;
  role: 'user' | 'brain';
  content: string;
  contentClipped: boolean;
  evidenceRefs: string[];
  runId: string | null;
}

export interface BrainConversation {
  sessionId: string;
  turns: BrainConversationTurn[];
  omittedOlder: number;
  lastTurn: number;
}

export type BrainTabKey =
  | 'pulse'
  | 'decisions'
  | 'pipeline'
  | 'approvals'
  | 'agents';

export interface BrainAttentionItem {
  id: string;
  label: string;
  detail: string;
  severity: 'good' | 'watch' | 'bad' | 'neutral';
  tab: BrainTabKey | null;
}

export interface BrainState {
  generatedAt: string;
  /** False means the bridge could not reach Foundry — a designed state, not a blank page. */
  connected: boolean;
  brain: {
    status: 'thinking' | 'idle' | 'blocked' | 'offline';
    headline: string;
    posture: string;
    lastCycleAt: string | null;
    nextCycleAt: string | null;
    version: string;
  };
  budget: {
    dailyTotal: number;
    changedAt: string | null;
    allocations: BrainAllocation[];
  };
  pipeline: BrainPipelineRun | null;
  openGates: number;
  agentsLive: number;
  agentsTotal: number;
  attention: BrainAttentionItem[];
}

/* ── The campaign run, in plain language ────────────────────────────────────────
 *
 * Everything below exists so the console can show a campaign being built WITHOUT
 * showing how it is built. No Foundry run id, no agent id, no stage-dispatch row,
 * no raw JSON reaches these shapes — the bridge does the translating, because a
 * page that renders `{"ads_wanted":6}` has not explained anything to anyone.
 *
 * The rule from mappers.ts still holds: when a shape does not say something, say
 * so. A missing score is null, not zero; an unjudged creative has no verdict.
 */

/** Colour/urgency for a chip. Kept separate from the raw status so the page never re-derives it. */
export type BrainRunTone = 'progress' | 'waiting' | 'good' | 'bad' | 'idle';

/** One row in the run list. */
export interface BrainCampaignRunSummary {
  runId: string;
  product: string;
  campaignType: string;
  stageLabel: string;
  statusLabel: string;
  tone: BrainRunTone;
  startedOn: string;
  updatedAt: string | null;
  creativesChosen: number | null;
  creativesPlanned: number | null;
  isLive: boolean;
}

/** One labelled fact from the brief. The page prints label/value and nothing else. */
export interface BrainBriefField {
  label: string;
  value: string;
  hint: string | null;
}

/** An audience the campaign will run against, described the way a person would say it. */
export interface BrainCampaignAudience {
  name: string;
  budget: string | null;
  adsPlanned: number | null;
  excludes: string | null;
  why: string | null;
}

/** One finished creative: the picture, and the words that ship with it. */
export interface BrainCampaignCreative {
  id: string;
  imageUrl: string | null;
  headline: string | null;
  caption: string | null;
  description: string | null;
  callToAction: string | null;
  language: string | null;
  statusLabel: string;
  tone: BrainRunTone;
  score: number | null;
  note: string | null;
  style: string | null;
}

/** One of the four steps, named for what it does rather than which agent does it. */
export interface BrainCampaignStep {
  key: BrainStageKey;
  label: string;
  what: string;
  state: BrainStageState;
  gateId: string | null;
}

export interface BrainCampaignRun extends BrainCampaignRunSummary {
  headline: string;
  steps: BrainCampaignStep[];
  brief: BrainBriefField[];
  audiences: BrainCampaignAudience[];
  whatHappened: string | null;
  needsYou: string | null;
  /** Which budget governs this run and whether its contract agrees — from the brain, not summed here. */
  budgetAuthority: BrainBudgetAuthority | null;
}

/* ── Experiments (hypotheses), in plain language ─────────────────────────────
 *
 * Built by experiments.mapper.ts. The page never sees an attribute code, a metric code, a status
 * enum or a hypothesis id: every string here is already the sentence a marketer reads. `ref` is
 * opaque and exists only for a collapsed "Details → Copy reference".
 */

/** Which shelf an experiment sits on. testing = proposed+active, learned = confirmed+refuted,
 *  dropped = retired+inconclusive. */
export type BrainExperimentView = 'testing' | 'learned' | 'dropped';

/** Colour for a chip; the page maps it to a chip class and never re-derives it from a status. */
export type BrainExperimentTone =
  | 'progress'
  | 'waiting'
  | 'good'
  | 'bad'
  | 'idle';

/** How far a live test has got towards having enough data to be judged. */
export interface BrainExperimentProgress {
  spentInr: number;
  neededInr: number | null;
  impressions: number;
  neededImpressions: number | null;
  /** Days until the test's time is up; 0 once it has passed; null before it has started. */
  daysLeft: number | null;
  /** One plain sentence on where it stands ("Still collecting results."), or null. */
  note: string | null;
}

/** What a finished test showed. */
export interface BrainExperimentResult {
  /** e.g. "It worked: 2.1% vs 1.4% click rate." */
  sentence: string;
  /** "Early signal" | "Fairly sure" | "Confident", or null when no confidence was recorded. */
  confidenceLabel: string | null;
}

export interface BrainExperiment {
  /** Opaque support reference. Details only — never printed as content. */
  ref: string;
  /** Opaque filter key for `?product=`; not for display. */
  productKey: string | null;
  /** Display name ("Saathi Report"), or null when the experiment is not tied to one product. */
  product: string | null;
  /** "Ad" | "Audience" | "Placement" | "Campaign" | "Product". */
  levelLabel: string;
  /** The claim as a sentence: "Ads that open with a question will get more clicks than …". */
  claim: string;
  /** "Proven idea" | "New twist on a proven idea" | "Exploring". */
  kindLabel: string;
  kind: 'proven' | 'variant' | 'seed' | 'other';
  statusLabel: string;
  statusMeaning: string;
  tone: BrainExperimentTone;
  /** Testing view only; null elsewhere. */
  progress: BrainExperimentProgress | null;
  /** Learned / dropped views only; null elsewhere. */
  result: BrainExperimentResult | null;
  /** Human date: "24 Sep" / "Today" — when it started (testing) or was judged (learned/dropped). */
  since: string | null;
  /** The same moment as an ISO timestamp, for sorting and relative time; not for display. */
  sinceAt: string | null;
}

export interface BrainExperimentProductCount {
  productKey: string;
  product: string;
  testing: number;
  learned: number;
  dropped: number;
}

export interface BrainExperimentSummary {
  views: Record<BrainExperimentView, number>;
  products: BrainExperimentProductCount[];
  /** True when the brain cut a read short, so a count is a floor rather than the total. */
  partial: boolean;
}
