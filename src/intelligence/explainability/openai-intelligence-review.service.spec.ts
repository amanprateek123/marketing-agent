import { Logger } from '@nestjs/common';
import type { OpenAIChatService } from '../../openai/openai-chat.service';
import type { RecommendedAction } from '../orchestrator/decision-context';
import {
  INTELLIGENCE_REVIEW_SCHEMA_VERSION,
  type IntelligenceReviewDraft,
  type IntelligenceReviewRequest,
} from './intelligence-review.types';
import {
  hashIntelligenceReviewInput,
  IntelligenceReviewValidator,
  prepareIntelligenceReviewInput,
} from './intelligence-review.validator';
import { OpenAIIntelligenceReviewService } from './openai-intelligence-review.service';

function makeAction(
  overrides: Partial<RecommendedAction> = {},
): RecommendedAction {
  return {
    actionId: 'action-scale-alpha',
    type: 'scale_adset',
    targetType: 'adset',
    targetId: 'adset-alpha',
    parameters: {
      dailyBudgetINR: 1_200,
      guardrails: { maximumIncreasePct: 15, minimumRoas: 1.2 },
    },
    expectedImpact: { metric: 'roas', deltaPct: 8, confidence: 0.82 },
    expectedProfitDeltaINR7d: 2_400,
    reasoning: 'The deterministic engines selected a guarded scale action.',
    evidenceChain: [{ step: 'Winner signal fired', source: 'dc.signal' }],
    risk: 'medium',
    implementationCost: 3,
    score: 800,
    gatedBy: [],
    requiresHumanApproval: true,
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<IntelligenceReviewRequest> = {},
): IntelligenceReviewRequest {
  return {
    packet: {
      schemaVersion: INTELLIGENCE_REVIEW_SCHEMA_VERSION,
      cycleId: 'cycle-alpha',
      tenantId: 'tenant-alpha',
      campaignId: 'campaign-alpha',
      goal: {
        objective: 'sales',
        primaryKPI: 'roas',
        supportingKPIs: ['cvr', 'aov', 'ctr'],
        optimizationGoal: 'VALUE',
        optimizationMetric: 'rawRoas',
      },
      facts: [
        {
          ref: 's1.spend',
          step: 1,
          source: 'snapshot',
          kind: 'observed',
          statement: 'Meta reports campaign spend of ₹500.',
          value: 500,
          unit: 'INR',
          targetType: 'campaign',
          targetId: 'campaign-alpha',
        },
        {
          ref: 's5.raw_roas',
          step: 5,
          source: 'revenue',
          kind: 'derived',
          statement: 'Observed raw ROAS is 1.4.',
          value: 1.4,
          unit: 'ratio',
          targetType: 'campaign',
          targetId: 'campaign-alpha',
        },
        {
          ref: 's6.winner_signal',
          step: 6,
          source: 'signal',
          kind: 'derived',
          statement: 'A winner signal is present for the selected ad set.',
          value: true,
          targetType: 'adset',
          targetId: 'adset-alpha',
        },
      ],
      unknowns: [],
    },
    action: makeAction(),
    model: 'gpt-5.1-mini',
    ...overrides,
  };
}

function makeDraft(
  request: IntelligenceReviewRequest,
): IntelligenceReviewDraft {
  const prepared = prepareIntelligenceReviewInput(request);
  return {
    verdict: prepared.action.gatedBy.length === 0 ? 'support' : 'hold',
    goal: {
      objective: prepared.packet.goal.objective,
      primaryKPI: prepared.packet.goal.primaryKPI,
      optimizationGoal: prepared.packet.goal.optimizationGoal,
      optimizationMetric: prepared.packet.goal.optimizationMetric,
    },
    headline: 'Evidence supports cautious scaling',
    summary:
      'Observed delivery and return signals align with the selected action, while uncertainty remains.',
    observedFacts: prepared.packet.facts
      .filter((fact) => fact.kind === 'observed')
      .map((fact) => ({
        evidenceRef: fact.ref,
        statement: fact.statement,
      })),
    hypotheses: [
      {
        statement: 'Creative response may be driving the favorable change.',
        confidence: 0.74,
        evidenceRefs: ['s6.winner_signal'],
        counterevidenceRefs: ['s5.raw_roas'],
      },
    ],
    unknowns: [
      {
        question: 'Is recent conversion reporting complete?',
        whyItMatters:
          'Incomplete reporting could change how the return signal is interpreted.',
      },
    ],
    recommendation: {
      action: prepared.action,
      interpretation:
        'Apply the deterministic action only through its existing approval and guardrail controls.',
    },
    validationPlan: {
      after24h: [
        {
          metric: 'roas',
          check: 'Watch return efficiency for early deterioration.',
          evidenceRefs: ['s5.raw_roas'],
        },
      ],
      after72h: [
        {
          metric: 'cvr',
          check:
            'Confirm conversion quality remains aligned with the sales goal.',
          evidenceRefs: ['s6.winner_signal'],
        },
      ],
    },
  };
}

function cloneDraft(draft: IntelligenceReviewDraft): IntelligenceReviewDraft {
  return JSON.parse(JSON.stringify(draft)) as IntelligenceReviewDraft;
}

describe('OpenAIIntelligenceReviewService', () => {
  let runStructured: jest.Mock;
  let service: OpenAIIntelligenceReviewService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-23T06:30:00.000Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    runStructured = jest.fn();
    service = new OpenAIIntelligenceReviewService({
      runStructured,
    } as unknown as OpenAIChatService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns a validated review while keeping deterministic inputs authoritative', async () => {
    const request = makeRequest();
    const draft = makeDraft(request);
    runStructured.mockResolvedValue({
      data: draft,
      content: JSON.stringify(draft),
      model: 'gpt-5.1-mini-2026-08-01',
      inputTokens: 500,
      outputTokens: 300,
      costUSD: 0.001,
    });

    const result = await service.review(request);

    expect(result).toMatchObject({
      verdict: 'support',
      source: 'openai',
      model: 'gpt-5.1-mini-2026-08-01',
      generatedAt: '2026-08-23T06:30:00.000Z',
      validation: { valid: true, issues: [] },
    });
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.recommendation.action).toEqual(
      prepareIntelligenceReviewInput(request).action,
    );

    expect(runStructured).toHaveBeenCalledTimes(1);
    const call = runStructured.mock.calls[0][0];
    expect(call).toMatchObject({
      tenantId: 'tenant-alpha',
      agentType: 'intelligence_reviewer',
      schemaName: 'intelligence_review',
      model: 'gpt-5.1-mini',
      runId: 'cycle-alpha',
    });
    const sent = JSON.parse(call.userMessage);
    expect(sent.packet.facts).toHaveLength(3);
    expect(sent.action.reasoning).toBeUndefined();
    expect(sent.action.evidenceChain).toBeUndefined();
    expect(call.schema.additionalProperties).toBe(false);
    expect(
      call.schema.properties.recommendation.properties.action
        .additionalProperties,
    ).toBe(false);
  });

  it('lets the shared OpenAI service resolve the configured model', async () => {
    const request = makeRequest();
    delete request.model;
    const draft = makeDraft(request);
    runStructured.mockResolvedValue({
      data: draft,
      content: JSON.stringify(draft),
      model: 'gpt-configured-model',
      inputTokens: 1,
      outputTokens: 1,
      costUSD: 0,
    });

    const result = await service.review(request);

    expect(result.model).toBe('gpt-configured-model');
    expect(runStructured.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('falls back without throwing when OpenAI is unavailable', async () => {
    const request = makeRequest();
    runStructured.mockRejectedValue(
      new Error('network secret must not escape'),
    );

    await expect(service.review(request)).resolves.toMatchObject({
      verdict: 'hold',
      source: 'fallback',
      model: 'deterministic-fallback',
      recommendation: {
        action: prepareIntelligenceReviewInput(request).action,
      },
      validation: { valid: false, issues: ['openai:unavailable'] },
    });
  });

  it('falls back when structured output still violates the domain contract', async () => {
    runStructured.mockResolvedValue({
      data: 'not an object',
      content: '"not an object"',
      model: 'gpt-5.1-mini',
      inputTokens: 1,
      outputTokens: 1,
      costUSD: 0,
    });

    const result = await service.review(makeRequest());

    expect(result).toMatchObject({
      verdict: 'hold',
      source: 'fallback',
      validation: { valid: false, issues: ['draft:invalid_object'] },
    });
  });

  it('rejects an invalid evidence contract before calling OpenAI', async () => {
    const request = makeRequest();
    request.packet.facts[0] = {
      ...request.packet.facts[0],
      step: 4,
    };

    const result = await service.review(request);

    expect(runStructured).not.toHaveBeenCalled();
    expect(result.verdict).toBe('reject');
    expect(result.source).toBe('fallback');
    expect(result.validation.issues).toEqual(
      expect.arrayContaining([
        'request.packet.facts[]:step_source_mismatch',
        'request.packet.facts[].ref:step_mismatch',
      ]),
    );
  });
});

describe('IntelligenceReviewValidator', () => {
  const validator = new IntelligenceReviewValidator();

  it.each([
    [
      'action type',
      (draft: IntelligenceReviewDraft) => {
        draft.recommendation.action.type = 'pause_ad';
      },
    ],
    [
      'target',
      (draft: IntelligenceReviewDraft) => {
        draft.recommendation.action.targetId = 'adset-elsewhere';
      },
    ],
    [
      'parameters',
      (draft: IntelligenceReviewDraft) => {
        draft.recommendation.action.parameters = { dailyBudgetINR: 9_999 };
      },
    ],
    [
      'expected numeric result',
      (draft: IntelligenceReviewDraft) => {
        draft.recommendation.action.expectedImpact.deltaPct = 99;
      },
    ],
    [
      'profit number',
      (draft: IntelligenceReviewDraft) => {
        draft.recommendation.action.expectedProfitDeltaINR7d = 99_999;
      },
    ],
  ])('rejects a model-changed %s', (_label, mutate) => {
    const request = makeRequest();
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = cloneDraft(makeDraft(request));
    mutate(draft);

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['draft.recommendation.action:changed']),
    });
  });

  it('rejects unknown evidence references', () => {
    const request = makeRequest();
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = cloneDraft(makeDraft(request));
    draft.hypotheses[0].evidenceRefs = ['s6.not_in_packet'];

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        'draft.hypotheses[].evidenceRefs:unknown_evidence_ref',
      ]),
    });
  });

  it('rejects an observed claim that is not an exact allow-listed statement', () => {
    const request = makeRequest();
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = cloneDraft(makeDraft(request));
    draft.observedFacts[0].statement = 'ROAS is definitely excellent.';

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['draft.observedFacts:unsupported_claim']),
    });
  });

  it('does not allow derived engine output to be presented as observed', () => {
    const request = makeRequest();
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = cloneDraft(makeDraft(request));
    draft.observedFacts.push({
      evidenceRef: 's5.raw_roas',
      statement: 'Observed raw ROAS is 1.4.',
    });

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['draft.observedFacts:not_observed']),
    });
  });

  it('rejects a goal mismatch', () => {
    const request = makeRequest();
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = cloneDraft(makeDraft(request));
    draft.goal = {
      objective: 'awareness',
      primaryKPI: 'reach',
      optimizationGoal: 'REACH',
      optimizationMetric: 'reach',
    };

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['draft.goal:mismatch']),
    });
  });

  it('rejects invented quantitative claims in generated prose', () => {
    const request = makeRequest();
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = cloneDraft(makeDraft(request));
    draft.summary = 'The action should improve return by 42 percent.';

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['draft.summary:unverified_number']),
    });
  });

  it('rejects support when the deterministic action has an active gate', () => {
    const request = makeRequest({
      action: makeAction({ gatedBy: ['insufficient_history'] }),
    });
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = makeDraft(request);
    draft.verdict = 'support';

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        'draft.verdict:gated_action_cannot_be_supported',
      ]),
    });
  });

  it('rejects support when deterministic evidence has a blocking unknown', () => {
    const base = makeRequest();
    const request = makeRequest({
      packet: {
        ...base.packet,
        unknowns: [
          {
            code: 'optimization_goal_missing:adset-alpha',
            statement:
              'The optimization goal for the action target is unavailable.',
            effect: 'blocks_validation',
          },
        ],
      },
    });
    const prepared = prepareIntelligenceReviewInput(request);
    const draft = makeDraft(request);
    draft.verdict = 'support';

    expect(validator.validateDraft(draft, prepared)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        'draft.verdict:blocking_unknown_cannot_be_supported',
      ]),
    });
  });

  it('rejects evidence outside the allow-listed Steps and source mapping', () => {
    const request = makeRequest();
    request.packet.facts[0] = {
      ...request.packet.facts[0],
      step: 6,
    };

    expect(validator.validateRequest(request)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        'request.packet.facts[]:step_source_mismatch',
      ]),
    });
  });

  it('rejects a derived engine source mislabeled as an observation', () => {
    const request = makeRequest();
    request.packet.facts[1] = {
      ...request.packet.facts[1],
      kind: 'observed',
    };

    expect(validator.validateRequest(request)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        'request.packet.facts[]:source_kind_mismatch',
      ]),
    });
  });

  it('produces the same input hash for semantically unordered packet fields', () => {
    const first = makeRequest();
    const second = makeRequest({
      packet: {
        ...first.packet,
        goal: {
          ...first.packet.goal,
          supportingKPIs: ['ctr', 'aov', 'cvr'],
        },
        facts: [...first.packet.facts].reverse(),
      },
      action: makeAction({
        parameters: {
          guardrails: { minimumRoas: 1.2, maximumIncreasePct: 15 },
          dailyBudgetINR: 1_200,
        },
      }),
    });

    const firstHash = hashIntelligenceReviewInput(
      prepareIntelligenceReviewInput(first),
    );
    const secondHash = hashIntelligenceReviewInput(
      prepareIntelligenceReviewInput(second),
    );

    expect(secondHash).toBe(firstHash);
  });
});
