/**
 * Performance Marketeer — lessons (docs/performance-marketeer/10-lessons.md).
 * Shared contract between records/grading, the lessons core + curator, the
 * pipeline and the dashboard API. No RAG: lessons are picked by exact tag
 * matching of `scope` against a campaign's `PmSituation`.
 */
import type { PmPhase } from '../pm-agent.types';

// ---------------------------------------------------------------- situation

/**
 * What a campaign (or one entity) looks like on a day. Stored on every
 * decision as its context snapshot, and computed fresh before each run to
 * pick lessons — same shape both times, so scopes match either.
 */
export interface PmSituation {
  product: string;
  structure: 'ABO' | 'CBO' | 'ADVANTAGE_PLUS' | 'unknown';
  objective: string;
  audience: 'prospecting' | 'retargeting' | 'mixed' | 'unknown';
  /** Daily spend band over the last 7 days. */
  spendBand: '<5k' | '5k-15k' | '15k-50k' | '>50k';
  learning: 'LEARNING' | 'SUCCESS' | 'FAIL' | 'mixed' | 'unknown';
  daysSinceLaunch: number | null;
  daysSinceLastEdit: number | null;
  roas7d: number | null; // first-party
  cpa7d: number | null;
  ctr7d: number | null; // %
  cpm7d: number | null; // ₹
  freqDay: number | null;
  accountCpmTrend: 'up' | 'flat' | 'down';
  /** calendar.json ids/kinds active or within 14 days, e.g. 'pre-diwali', 'pitru-paksha', 'kharmas'. */
  season: string[];
  festivalInDays: number | null;
  /**
   * Code-computed symptoms, a fixed vocabulary:
   * below_target, above_target, ctr_drop, cpm_up, freq_high, orders_drop,
   * payment_drop, funnel_drop, learning_limited, data_gap, recent_edit.
   */
  symptoms: string[];
  /** For entity-level snapshots. */
  level?: 'campaign' | 'adset' | 'ad';
  entityId?: string;
}

/**
 * A lesson's scope: every key must match the situation (AND). Values:
 *   'ABO'            equal (case-insensitive)
 *   'ABO|CBO'        any of
 *   '>=1.1' '<0.7'   numeric comparison (>, >=, <, <=)
 *   for array fields (season, symptoms): the value (or any of a|b) is contained
 * Extra keys allowed only for phase/category routing: 'phase', 'category'.
 */
export type PmLessonScope = Record<string, string>;

// ---------------------------------------------------------------- lessons

export type PmLessonType =
  | 'action_effect'
  | 'diagnosis_pattern'
  | 'creative_pattern'
  | 'season_effect'
  | 'segment_fact'
  | 'analyst_habit';

export type PmLessonStatus = 'candidate' | 'active' | 'review' | 'retired';

/**
 * Machine-readable claim, so code (not the model) can count support:
 * - action_effect: a graded outcome supports if its decision matches `action`
 *   and its verdict equals `expect`; a different clean verdict contradicts.
 * - diagnosis_pattern: a diagnosis check on `category` supports if
 *   `holds` equals whether the cause held up.
 * - other types: support comes from measured cases the curator cites
 *   (curator evidence ids), recounted by code.
 */
export type PmLessonClaim =
  | {
      kind: 'action_effect';
      action: {
        type: string; // Action['type']
        field?: string;
        direction?: 'up' | 'down';
        maxStep?: number; // e.g. 0.2
      };
      expect: 'worked' | 'no_effect' | 'hurt';
      effect?: { metric: string; median: number; low: number; high: number };
    }
  | { kind: 'diagnosis_pattern'; category: string; holds: boolean }
  | { kind: 'measured'; metric: string; median?: number; low?: number; high?: number };

export interface PmLessonCase {
  /** Decision id (D-…), diagnosis check id (DC-…) or curator evidence id (cev-…). */
  ref: string;
  supports: boolean;
  campaignId: string;
  at: string; // YYYY-MM-DD
}

export interface PmLesson {
  lessonId: string; // L-1, L-2 …
  type: PmLessonType;
  /** when / then (/ because, marked as the curator's reading). */
  statement: string;
  because?: string;
  scope: PmLessonScope;
  claim: PmLessonClaim;
  status: PmLessonStatus;
  cases: PmLessonCase[];
  /** Code-computed from cases: 0.2 / 0.5 / 0.8. */
  confidence: 0.2 | 0.5 | 0.8;
  uses: number;
  hits: number; // uses whose later outcome agreed
  version: number;
  approvedAt?: string;
  reviewBy?: string; // YYYY-MM-DD
  createdAt?: string;
}

export const PM_LESSON_RULES = {
  minCases: 3,
  minCampaigns: 2,
  minShare: 0.75,
  reviewShare: 0.6,
  reviewWindow: 8,
  retireShare: 0.5,
  retireMinUses: 6,
  candidateExpireDays: 60,
  staleDays: { default: 120, creative_pattern: 90 } as Record<string, number>,
  maxActive: 60,
  caps: {
    action_effect: 15,
    diagnosis_pattern: 12,
    creative_pattern: 15,
    season_effect: 10,
    segment_fact: 10,
    analyst_habit: 8,
  } as Record<PmLessonType, number>,
  perPhase: 8,
  perTypePerPhase: 2,
  /** Outcomes with fewer orders than this in either window are inconclusive. */
  minOrdersPerWindow: 8,
} as const;

/** Which lesson types each phase is given (doc 10, "How lessons are used"). */
export const PM_PHASE_LESSON_TYPES: Record<PmPhase, PmLessonType[]> = {
  investigate: ['diagnosis_pattern', 'season_effect', 'segment_fact', 'analyst_habit'],
  verify: ['diagnosis_pattern', 'season_effect', 'segment_fact', 'analyst_habit'],
  plan: ['action_effect', 'creative_pattern', 'season_effect', 'segment_fact', 'analyst_habit'],
  plan_verify: ['action_effect', 'creative_pattern', 'season_effect', 'segment_fact', 'analyst_habit'],
};

// ---------------------------------------------------------------- owner rules

/**
 * Your standing rules. `check` is optional: when set, code enforces it on
 * every plan (05-checks.md); otherwise the rule is text the phases must follow.
 */
export interface PmOwnerRule {
  ruleId: string; // R-1 …
  text: string;
  active: boolean;
  check?:
    | { kind: 'no_pause_before_days'; days: number }
    | { kind: 'max_budget_step'; step: number }
    | { kind: 'no_budget_increase_in_season'; season: string; product?: string }
    | { kind: 'no_action_type'; type: string; product?: string };
}

// ---------------------------------------------------------------- records

export type PmOutcomeVerdict = 'worked' | 'no_effect' | 'hurt' | 'inconclusive' | 'contaminated';

export interface PmDecisionRecord {
  decisionId: string; // D-<runDate>-<campaignId>-<actionId> or D-<date>-out-<changeKey8>
  source: 'recommended' | 'outside';
  date: string; // decision date (change date if taken / outside, else run date)
  runDate?: string;
  actionId?: string;
  campaignId: string;
  entityLevel: 'campaign' | 'adset' | 'ad' | 'site';
  entityId: string;
  entityName: string;
  type: string; // Action['type'] or a mapped change type
  field: string;
  from: string | number | null;
  to: string | number | null;
  direction?: 'up' | 'down';
  step?: number; // relative size, e.g. -0.2
  taken: 'taken' | 'partly' | 'not_taken' | 'outside';
  changedAt?: string; // ISO
  userNote?: string;
  context: PmSituation;
  causes: { id: string; category: string; confidence: number }[];
  lessonIds: string[];
  expected?: { metric: string; low: number; high: number };
}

export interface PmOutcomeRecord {
  decisionId: string;
  read: 'early' | 'settled';
  before: { from: string; to: string; roas: number | null; orders: number; spend: number; cpa: number | null };
  after: { from: string; to: string; roas: number | null; orders: number; spend: number; cpa: number | null };
  baseline: { roasBefore: number | null; roasAfter: number | null };
  diffInDiff: { roas: number | null; low: number | null; high: number | null };
  verdict: PmOutcomeVerdict;
  confounders: string[]; // learning_reset, other_edit, tracking_gap, festival_edge, missing_days
  insidePredictedRange: boolean | null;
  decisionQuality: 'good' | 'poor' | 'unknown';
  /** Not-taken recommendations: a weak "what happened anyway" read, never teaches. */
  weak: boolean;
  gradedAt: string;
}

export interface PmDiagnosisCheck {
  checkId: string; // DC-<runDate>-<campaignId>-<causeId>
  runDate: string;
  campaignId: string;
  causeId: string;
  category: string;
  confidence: number;
  /** held = the follow-up metric moved as the cause predicts after a fix (or the cause's signal persisted). */
  result: 'held' | 'not_held' | 'unclear';
  note: string;
  lessonIds: string[];
  checkedAt: string;
}

// ---------------------------------------------------------------- curator

export type PmLessonDeltaOp = 'ADD' | 'EDIT' | 'ATTACH' | 'MERGE' | 'RETIRE';

export interface PmLessonProposal {
  proposalId: string; // P-<week>-<n>
  week: string; // e.g. 2026-W45
  op: PmLessonDeltaOp | 'PROMOTE';
  /** Lesson as it would be after the change (ADD/EDIT/PROMOTE/MERGE). */
  lesson?: Partial<PmLesson>;
  lessonId?: string;
  mergeIds?: string[];
  cases?: PmLessonCase[];
  why: string;
  /** Code validation result; failed proposals are kept with reasons, never applied. */
  validation: { ok: boolean; problems: string[] };
  /**
   * ADD (→ candidate) and ATTACH apply automatically once valid (candidates are
   * never used). PROMOTE, EDIT/MERGE/RETIRE of an active lesson wait for you.
   */
  status: 'pending' | 'applied' | 'approved' | 'rejected' | 'invalid';
  decidedAt?: string;
  decidedNote?: string;
}
