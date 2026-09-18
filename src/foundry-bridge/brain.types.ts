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
}

export interface BrainGateDecisionBody {
  action: BrainGateActionKey;
  note?: string;
  selectedIds?: string[];
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
