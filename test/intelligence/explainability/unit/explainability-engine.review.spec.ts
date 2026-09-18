import { Logger } from '@nestjs/common';
import type { RecommendedAction } from '../../../../src/intelligence/orchestrator/decision-context';
import type { IntelligenceReviewResult } from '../../../../src/intelligence/explainability/intelligence-review.types';
import { ExplainabilityEngine } from '../../../../src/intelligence/explainability/explainability-engine.service';
import { buildIntelligenceReviewEvidence } from '../../../../src/intelligence/explainability/intelligence-review-evidence.builder';

jest.mock(
  '../../../../src/intelligence/explainability/intelligence-review-evidence.builder',
  () => ({ buildIntelligenceReviewEvidence: jest.fn() }),
);

const action: RecommendedAction = {
  actionId: 'action-1',
  type: 'pause_ad',
  targetType: 'ad',
  targetId: 'ad-1',
  parameters: {},
  expectedImpact: { metric: 'roas', deltaPct: 0, confidence: 0.7 },
  expectedProfitDeltaINR7d: 100,
  reasoning: 'Deterministic recommendation.',
  evidenceChain: [],
  risk: 'medium',
  implementationCost: 3,
  score: 100,
  gatedBy: [],
  requiresHumanApproval: true,
};

const review: IntelligenceReviewResult = {
  verdict: 'hold',
  goal: {
    objective: 'sales',
    primaryKPI: 'roas',
    optimizationGoal: 'VALUE',
    optimizationMetric: 'rawRoas',
  },
  headline: 'Recommendation held for deterministic review',
  summary: 'The deterministic recommendation remains unchanged.',
  observedFacts: [],
  hypotheses: [],
  unknowns: [],
  recommendation: {
    action: {
      actionId: action.actionId,
      type: action.type,
      targetType: action.targetType,
      targetId: action.targetId,
      parameters: action.parameters,
      expectedImpact: action.expectedImpact,
      expectedProfitDeltaINR7d: action.expectedProfitDeltaINR7d,
      risk: action.risk,
      implementationCost: action.implementationCost,
      score: action.score,
      gatedBy: action.gatedBy,
      requiresHumanApproval: action.requiresHumanApproval,
    },
    interpretation: 'The selected action has not been endorsed.',
  },
  validationPlan: { after24h: [], after72h: [] },
  model: 'deterministic-fallback',
  generatedAt: '2026-08-23T06:30:00.000Z',
  inputHash: 'a'.repeat(64),
  source: 'fallback',
  validation: { valid: false, issues: ['openai:unavailable'] },
};

const evidence = {
  packet: {
    schemaVersion: 'intelligence_review_v1',
    cycleId: 'cycle-1',
    tenantId: 'tenant-1',
    campaignId: 'campaign-1',
    goal: {
      objective: 'sales',
      primaryKPI: 'roas',
      supportingKPIs: ['cvr', 'aov', 'ctr'],
      optimizationGoal: 'VALUE',
      optimizationMetric: 'rawRoas',
    },
    facts: [],
    unknowns: [],
  },
  hierarchy: {
    nodes: [],
    coverage: {
      adSetsIncluded: 0,
      adSetsTotal: 0,
      adsIncluded: 0,
      adsTotal: 0,
      truncated: false,
    },
  },
  unknowns: [],
  baseline: {
    metric: 'roas',
    value: null,
    unit: 'x',
    capturedAt: '2026-08-23T06:00:00.000Z',
  },
};

function setup(updateOne: jest.Mock = jest.fn().mockResolvedValue({})) {
  const reviewer = { review: jest.fn().mockResolvedValue(review) };
  const engine = new ExplainabilityEngine(
    {} as any,
    {} as any,
    {} as any,
    reviewer as any,
    { updateOne } as any,
  );
  const deps = {
    recommendation: { data: { actions: [action] }, confidence: 0.8 },
    signal: { data: { signals: [] } },
    trend: { data: { trendReady: false } },
    diagnosis: { data: { rootCauses: [], leakDiagnosis: 'data_gap' } },
    lifecycle: { data: { stage: 'stable' } },
  } as any;
  return { engine, reviewer, updateOne, deps };
}

describe('ExplainabilityEngine OpenAI review persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (buildIntelligenceReviewEvidence as jest.Mock).mockReturnValue(evidence);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps a fallback review in Step 14 and tenant-scopes its decision copy', async () => {
    const state = setup();

    const data = await (state.engine as any).compute(state.deps, 'cycle-1', {
      tenantId: 'tenant-1',
      campaignId: 'campaign-1',
    });

    expect(data.perAction['action-1']).toMatchObject({
      llmRendered: review.summary,
      review,
      evidence,
    });
    expect(state.updateOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        campaignId: 'campaign-1',
        cycleId: 'cycle-1',
        actionId: 'action-1',
      },
      {
        $set: expect.objectContaining({
          intelligenceReviewVersion: 'intelligence_review_v1',
          intelligenceReview: review,
          intelligenceEvidence: evidence,
          intelligenceReviewedAt: new Date(review.generatedAt),
        }),
      },
    );
  });

  it('does not lose the canonical Step-14 review when denormalization fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const state = setup(
      jest.fn().mockRejectedValue(new Error('decision store unavailable')),
    );

    await expect(
      (state.engine as any).compute(state.deps, 'cycle-1', {
        tenantId: 'tenant-1',
        campaignId: 'campaign-1',
      }),
    ).resolves.toMatchObject({
      perAction: { 'action-1': { review, evidence } },
    });
  });
});
