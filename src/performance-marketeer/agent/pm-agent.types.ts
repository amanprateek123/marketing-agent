/**
 * Performance Marketeer — Step 3 campaign pipeline (docs/performance-marketeer/09-campaign-pipeline.md).
 *
 * The shared contract between the orchestrator, the tool groups, the journal
 * and the dashboard API. Phase outputs are zod schemas: the orchestrator turns
 * them into JSON Schema for the SDK's structured output, validates the reply,
 * and writes the phase .md file itself (front-matter from the JSON, body from
 * `markdown`). Code — never a model — decides send-backs from these fields.
 */
import { z } from 'zod';

export type PmPhase = 'investigate' | 'verify' | 'plan' | 'plan_verify';

/** File names inside campaigns/<campaignId>/<date>/ (vN = round, 1-based). */
export const PM_FILES = {
  brief: '00-brief.md',
  journal: '00-journal.md',
  investigate: (n: number) => `01-investigate.v${n}.md`,
  verify: (n: number) => `02-verify.v${n}.md`,
  plan: (n: number) => `03-plan.v${n}.md`,
  plan_verify: (n: number) => `04-plan-verify.v${n}.md`,
  checks: '05-checks.md',
  actions: '05-actions.md',
  evidence: 'evidence.jsonl',
  helpers: 'helpers',
  /** Code-rendered campaign history card (PmRecordsService.historyMarkdown). */
  history: 'history.md',
  /** Lessons + owner rules picked by code for one phase. */
  lessons: (phase: PmPhase) => `lessons.${phase}.md`,
} as const;

/** Day files inside day/<date>/ — built once per day by code, shared by all campaigns. */
export const PM_DAY_FILES = {
  account: 'account.md',
  festivals: 'festivals.md',
  competitors: 'competitors.md',
} as const;

// ---------------------------------------------------------------- scores

/** Coarse bins: LLM probabilities are poorly calibrated, three bins are more honest. */
export const Confidence = z.union([
  z.literal(0.2),
  z.literal(0.5),
  z.literal(0.8),
]);
export type Confidence = z.infer<typeof Confidence>;
export const EvidenceStrength = z.enum(['data', 'inferred', 'speculative']);
export const Severity = z.enum(['blocker', 'major', 'minor']);
export type Severity = z.infer<typeof Severity>;

/** Evidence ids are the `id` of evidence.jsonl lines, e.g. "ev-12". */
const EvIds = z.array(z.string().regex(/^ev-\d+$/));
/** Lesson ids (lessons.<phase>.md) an item relies on; may be empty. */
const LessonIds = z.array(z.string().regex(/^L-\d+$/));
/** Lessons today's evidence contradicts — today's evidence wins; feeds the lesson's score. */
export const LessonContradictionSchema = z.object({
  id: z.string().regex(/^L-\d+$/),
  evidence: EvIds,
  note: z.string(),
});
export type LessonContradiction = z.infer<typeof LessonContradictionSchema>;
const LessonsContradicted = z.array(LessonContradictionSchema);

// ---------------------------------------------------------------- phase 1

export const CauseSchema = z.object({
  id: z.string().regex(/^C\d+$/), // stable across rounds
  title: z.string(),
  category: z.enum([
    'tracking',
    'auction_cost',
    'creative',
    'audience',
    'landing_funnel',
    'payment',
    'price_offer',
    'geo_age_placement',
    'learning_edits',
    'season_festival',
    'competition',
    'budget_structure',
    'other',
  ]),
  confidence: Confidence,
  /** ₹ per day at stake — must come from the impact_rupees tool (its ev id in impactEvidence). */
  impactRupeesPerDay: z.number(),
  impactEvidence: z.string().regex(/^ev-\d+$/),
  evidence: EvIds,
  evidenceStrength: EvidenceStrength,
  /** What was tried to disprove it, and what came back. */
  disproofTried: z.string(),
  lessonIds: LessonIds,
});
export type Cause = z.infer<typeof CauseSchema>;

/** On a revision round: one reply per verifier issue (counters sycophancy). */
export const IssueReplySchema = z.object({
  issueId: z.string(),
  reply: z.enum(['accept', 'reject_with_evidence', 'revise']),
  note: z.string(),
  evidence: EvIds,
});

export const InvestigateOutput = z.object({
  summary: z.string(),
  causes: z.array(CauseSchema).min(1),
  ruledOut: z.array(z.object({ title: z.string(), evidence: EvIds })),
  issueReplies: z.array(IssueReplySchema), // empty on round 1
  dataGaps: z.array(z.string()),
  lessonsContradicted: LessonsContradicted,
  markdown: z.string(), // narrative body for the .md file
});
export type InvestigateOutput = z.infer<typeof InvestigateOutput>;

// ---------------------------------------------------------------- phase 2

export const IssueSchema = z.object({
  id: z.string().regex(/^I\d+$/),
  severity: Severity,
  /** Cause id (C…) or action id (A…) the issue is about; '' = general. */
  target: z.string(),
  claim: z.string(),
  checked: z.string(),
  evidence: EvIds,
  requiredChange: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const VerifyOutput = z.object({
  /** Written BEFORE reading the investigation (from the brief only) — limits anchoring. */
  blindList: z.array(z.string()),
  causeVerdicts: z.array(
    z.object({
      causeId: z.string(),
      verdict: z.enum(['confirmed', 'weakened', 'rejected']),
      confidence: Confidence,
      evidence: EvIds,
      note: z.string(),
    }),
  ),
  /** Causes the investigator missed; get ids continuing the C sequence. */
  addedCauses: z.array(CauseSchema),
  issues: z.array(IssueSchema),
  confirmedRight: z.array(z.string()),
  lessonsContradicted: LessonsContradicted,
  markdown: z.string(),
});
export type VerifyOutput = z.infer<typeof VerifyOutput>;

// ---------------------------------------------------------------- phase 3

export const ActionSchema = z.object({
  id: z.string().regex(/^A\d+$/), // stable across rounds
  type: z.enum([
    'creative',
    'budget',
    'geo',
    'audience',
    'placement',
    'landing_funnel',
    'tracking',
    'festival_prep',
    'pause',
    'hold',
  ]),
  title: z.string(),
  causeIds: z.array(z.string()),
  entityLevel: z.enum(['campaign', 'adset', 'ad', 'site']),
  entityId: z.string(),
  entityName: z.string(),
  /** Exact change, e.g. { field: 'daily_budget', from: 10000, to: 8000 }. */
  change: z.object({
    field: z.string(),
    from: z.union([z.string(), z.number(), z.null()]),
    to: z.union([z.string(), z.number(), z.null()]),
  }),
  expectedEffect: z.object({
    metric: z.string(),
    low: z.number(),
    high: z.number(),
    evidence: EvIds,
  }),
  impactRupeesPerDay: z.number(),
  confidence: Confidence,
  resetsLearning: z.boolean(),
  /** What could go wrong, e.g. "cuts the only ad set still converting". */
  risk: z.string(),
  judgeOn: z.string(), // YYYY-MM-DD
  stopCondition: z.string(),
  /** For creative actions: the brief for the new creative. */
  creativeBrief: z.string().optional(),
  lessonIds: LessonIds,
});
export type Action = z.infer<typeof ActionSchema>;

export const PlanOutput = z.object({
  summary: z.string(),
  /** Honest view: can this campaign reach ROAS > 1? */
  pathToTarget: z.enum(['likely', 'possible', 'unlikely']),
  actions: z.array(ActionSchema).min(1),
  issueReplies: z.array(IssueReplySchema),
  lessonsContradicted: LessonsContradicted,
  markdown: z.string(),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

// ---------------------------------------------------------------- phase 4

export const PlanVerifyOutput = z.object({
  actionVerdicts: z.array(
    z.object({
      actionId: z.string(),
      verdict: z.enum(['approve', 'change', 'reject']),
      note: z.string(),
      evidence: EvIds,
    }),
  ),
  issues: z.array(IssueSchema),
  confirmedRight: z.array(z.string()),
  lessonsContradicted: LessonsContradicted,
  markdown: z.string(),
});
export type PlanVerifyOutput = z.infer<typeof PlanVerifyOutput>;

export const PHASE_SCHEMAS = {
  investigate: InvestigateOutput,
  verify: VerifyOutput,
  plan: PlanOutput,
  plan_verify: PlanVerifyOutput,
} as const;

// ---------------------------------------------------------------- tools

/** One line of evidence.jsonl. Every number in a phase file must cite one. */
export interface PmEvidence {
  id: string; // "ev-12"
  at: string; // ISO time
  phase: PmPhase | 'prep' | 'curator';
  round: number;
  tool: string;
  args: unknown;
  result: unknown;
}

/**
 * What every tool handler gets. Built per phase call by the orchestrator.
 * `record` appends to evidence.jsonl and returns the new id; tool groups wrap
 * results with it (see pmTool in agent/tools/pm-tool.ts).
 */
export interface PmToolCtx {
  tenantId: string;
  campaignId: string;
  date: string; // run date YYYY-MM-DD (IST); data runs to the day before
  /** Absolute path of campaigns/<campaignId>/<date>/ */
  dir: string;
  /** 'curator' = the weekly lessons curator (agent/lessons/curator.ts). */
  phase: PmPhase | 'curator';
  round: number;
  record(tool: string, args: unknown, result: unknown): Promise<string>;
}

// ---------------------------------------------------------------- loop rules

export const PM_LOOP = {
  maxSendBacks: 2,
  investigate: { majors: 3 }, // or any blocker, or the top cause rejected
  plan: { majors: 2, rejectedShare: 1 / 3 }, // or any blocker
  maxBudgetStep: 0.2, // ±20% per change
  targetRoas: 1.0,
} as const;

export const PM_MODELS: Record<PmPhase | 'plan_revision', string> = {
  investigate: process.env.PM_MODEL_INVESTIGATE ?? 'claude-opus-5-5',
  verify: process.env.PM_MODEL_VERIFY ?? 'claude-opus-5-5',
  plan: process.env.PM_MODEL_PLAN ?? 'claude-opus-5-5',
  plan_revision: process.env.PM_MODEL_PLAN_REVISION ?? 'claude-opus-5-5',
  plan_verify: process.env.PM_MODEL_PLAN_VERIFY ?? 'claude-opus-5-5',
};

// ---------------------------------------------------------------- journal

export type PmJournalStatus =
  | 'taken'
  | 'partly'
  | 'not_taken'
  | 'outside_change';

export interface PmJournalEntry {
  date: string; // recommendation date (or change date for outside changes)
  actionId?: string;
  /** Meta object the entry is about (action entity, or the changed object). */
  entityId?: string;
  title: string;
  status: PmJournalStatus;
  /** Matched Meta change(s), human-readable, e.g. "Meta log 25 Oct 14:02, 10,000 → 8,000". */
  matched: string[];
  resetsLearning: boolean;
  /** 'early' = day 2–3 read, 'settled' = day 7+, 'too_soon' = before day 2. */
  read: 'too_soon' | 'early' | 'settled';
  resultSoFar: string;
  judgeAgainOn?: string;
  userNote?: string;
}
