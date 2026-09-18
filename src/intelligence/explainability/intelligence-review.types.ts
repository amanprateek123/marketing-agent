import type {
  ObjectiveKey,
  RecommendedAction,
} from '../orchestrator/decision-context';

export const INTELLIGENCE_REVIEW_SCHEMA_VERSION =
  'intelligence_review_v1' as const;

/** Optional per-call override; when omitted, OpenAIChatService owns the model. */
export type IntelligenceReviewModel = string;

export const INTELLIGENCE_EVIDENCE_SOURCES = {
  snapshot: 1,
  objective: 2,
  lifecycle: 3,
  trend: 4,
  revenue: 5,
  signal: 6,
  diagnosis: 7,
  business: 8,
  portfolio: 9,
  forecast: 10,
  confidence: 11,
  memory: 12,
  recommendation: 13,
} as const;

export type IntelligenceEvidenceSource =
  keyof typeof INTELLIGENCE_EVIDENCE_SOURCES;

export type IntelligenceEvidenceStep =
  (typeof INTELLIGENCE_EVIDENCE_SOURCES)[IntelligenceEvidenceSource];

export type IntelligenceEvidenceValue = string | number | boolean | null;
export type IntelligenceEvidenceKind =
  | 'observed'
  | 'derived'
  | 'policy'
  | 'model_output';

/**
 * A deliberately narrow fact contract. Arbitrary engine slices are never sent
 * to the model; the caller must select and label each scalar observation.
 */
export interface IntelligenceReviewEvidenceFact {
  ref: string;
  step: IntelligenceEvidenceStep;
  source: IntelligenceEvidenceSource;
  kind: IntelligenceEvidenceKind;
  statement: string;
  value: IntelligenceEvidenceValue;
  unit?: string;
  targetType?: 'campaign' | 'adset' | 'ad';
  targetId?: string;
}

export interface IntelligenceEvidenceUnknown {
  code: string;
  statement: string;
  effect:
    | 'reduces_confidence'
    | 'blocks_diagnosis'
    | 'blocks_recommendation'
    | 'blocks_execution'
    | 'blocks_validation';
}

export interface IntelligenceReviewEvidencePacket {
  schemaVersion: typeof INTELLIGENCE_REVIEW_SCHEMA_VERSION;
  cycleId: string;
  tenantId: string;
  campaignId: string;
  goal: {
    objective: ObjectiveKey;
    primaryKPI: string;
    supportingKPIs: string[];
    optimizationGoal: string | null;
    optimizationMetric: string | null;
  };
  facts: IntelligenceReviewEvidenceFact[];
  /** Deterministic missing-data findings the reviewer must not ignore. */
  unknowns: IntelligenceEvidenceUnknown[];
}

export interface IntelligenceReviewRequest {
  packet: IntelligenceReviewEvidencePacket;
  action: RecommendedAction;
  model?: IntelligenceReviewModel;
}

export type IntelligenceReviewVerdict = 'support' | 'hold' | 'reject';

/**
 * Immutable action fields echoed by the reviewer. Narrative fields from the
 * deterministic recommendation are intentionally excluded from the model
 * input; the evidence packet is the sole factual source.
 */
export type IntelligenceReviewActionSnapshot = Pick<
  RecommendedAction,
  | 'actionId'
  | 'type'
  | 'targetType'
  | 'targetId'
  | 'parameters'
  | 'expectedImpact'
  | 'expectedProfitDeltaINR7d'
  | 'risk'
  | 'implementationCost'
  | 'score'
  | 'gatedBy'
  | 'requiresHumanApproval'
>;

export interface IntelligenceReviewDraft {
  verdict: IntelligenceReviewVerdict;
  goal: {
    objective: ObjectiveKey;
    primaryKPI: string;
    optimizationGoal: string | null;
    optimizationMetric: string | null;
  };
  headline: string;
  summary: string;
  observedFacts: Array<{
    evidenceRef: string;
    /** Must exactly copy the referenced allow-listed fact statement. */
    statement: string;
  }>;
  hypotheses: Array<{
    statement: string;
    confidence: number;
    evidenceRefs: string[];
    counterevidenceRefs: string[];
  }>;
  unknowns: Array<{
    question: string;
    whyItMatters: string;
  }>;
  recommendation: {
    action: IntelligenceReviewActionSnapshot;
    interpretation: string;
  };
  validationPlan: {
    after24h: IntelligenceReviewValidationCheck[];
    after72h: IntelligenceReviewValidationCheck[];
  };
}

export interface IntelligenceReviewValidationCheck {
  metric: string;
  check: string;
  evidenceRefs: string[];
}

export interface IntelligenceReviewResult extends IntelligenceReviewDraft {
  model: IntelligenceReviewModel;
  generatedAt: string;
  inputHash: string;
  source: 'openai' | 'fallback';
  validation: {
    valid: boolean;
    issues: string[];
  };
}

export interface PreparedIntelligenceReviewInput {
  schemaVersion: typeof INTELLIGENCE_REVIEW_SCHEMA_VERSION;
  packet: IntelligenceReviewEvidencePacket;
  action: IntelligenceReviewActionSnapshot;
}
