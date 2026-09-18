import { DecisionsService } from '../../../../src/intelligence/decisions/decisions.service';

type AnyRecord = Record<string, any>;

function query<T>(read: T | (() => T | Promise<T>)) {
  const q = {
    select: jest.fn(),
    sort: jest.fn(),
    lean: jest.fn(),
    exec: jest
      .fn()
      .mockImplementation(async () =>
        typeof read === 'function' ? (read as () => T | Promise<T>)() : read,
      ),
  };
  q.select.mockReturnValue(q);
  q.sort.mockReturnValue(q);
  q.lean.mockReturnValue(q);
  return q;
}

function decision(overrides: AnyRecord = {}) {
  const doc: AnyRecord = {
    _id: 'decision-1',
    tenantId: 'tenant-1',
    campaignId: 'campaign-1',
    metaCampaignId: 'meta-campaign-1',
    cycleId: 'cycle-1',
    actionId: 'action-1',
    actionType: 'pause_ad',
    targetType: 'ad',
    targetId: 'ad-1',
    parameters: {},
    status: 'approved',
    executionStatus: 'pending',
    executionAttempts: 0,
    shadowModeOnly: true,
    reviewWindowExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
  doc.toObject = jest.fn(() => ({ ...doc }));
  return doc;
}

function campaign(overrides: AnyRecord = {}) {
  return {
    _id: 'campaign-1',
    tenantId: 'tenant-1',
    name: 'Nadi Leaf Sales',
    source: 'agent',
    status: 'active',
    metaCampaignId: 'meta-campaign-1',
    adSets: [
      {
        metaAdSetId: 'adset-1',
        ads: [{ metaAdId: 'ad-1' }],
      },
      {
        metaAdSetId: 'adset-2',
        ads: [{ metaAdId: 'ad-2' }],
      },
    ],
    metaAdSets: [],
    ...overrides,
  } as any;
}

function goalAwareDecision(): AnyRecord {
  const doc = decision({
    decisionContractVersion: 'goal_aware_v1',
    objective: 'sales',
    primaryKPI: 'roas',
    expectedImpact: { metric: 'roas', deltaPct: 0, confidence: 0.7 },
    expectedProfitDeltaINR7d: 100,
    risk: 'medium',
    score: 100,
    gatedBy: [],
    requiresHumanApproval: true,
    intelligenceReviewVersion: 'intelligence_review_v1',
  });
  doc.intelligenceReview = {
    source: 'openai',
    verdict: 'support',
    validation: { valid: true, issues: [] },
    recommendation: {
      action: {
        actionId: doc.actionId,
        type: doc.actionType,
        targetType: doc.targetType,
        targetId: doc.targetId,
        parameters: doc.parameters,
        expectedImpact: doc.expectedImpact,
        expectedProfitDeltaINR7d: doc.expectedProfitDeltaINR7d,
        risk: doc.risk,
        implementationCost: 3,
        score: doc.score,
        gatedBy: doc.gatedBy,
        requiresHumanApproval: doc.requiresHumanApproval,
      },
    },
  };
  return doc;
}

function hasValue(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const condition = expected as AnyRecord;
    if ('$exists' in condition) {
      return condition.$exists ? actual !== undefined : actual === undefined;
    }
    if ('$gt' in condition) {
      return (
        new Date(actual as any).getTime() > new Date(condition.$gt).getTime()
      );
    }
    if ('$lte' in condition) {
      return (
        new Date(actual as any).getTime() <= new Date(condition.$lte).getTime()
      );
    }
  }
  return actual === expected;
}

function matches(doc: AnyRecord | null, filter: AnyRecord): boolean {
  if (!doc) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(expected as AnyRecord[]).some((part) => matches(doc, part))) {
        return false;
      }
      continue;
    }
    if (!hasValue(doc[key], expected)) return false;
  }
  return true;
}

function applyUpdate(doc: AnyRecord, update: AnyRecord): void {
  Object.assign(doc, update.$set ?? {});
  for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
  for (const [key, value] of Object.entries(update.$inc ?? {})) {
    doc[key] = Number(doc[key] ?? 0) + Number(value);
  }
}

function setup(input?: {
  doc?: AnyRecord;
  campaign?: any;
  execute?: jest.Mock;
}) {
  const state = {
    doc: input?.doc ?? decision(),
    campaign: input?.campaign ?? campaign(),
  };
  const model = {
    findOne: jest.fn((filter: AnyRecord) =>
      query(() => (matches(state.doc, filter) ? state.doc : null)),
    ),
    findOneAndUpdate: jest.fn((filter: AnyRecord, update: AnyRecord) =>
      query(() => {
        if (!matches(state.doc, filter)) return null;
        applyUpdate(state.doc, update);
        return state.doc;
      }),
    ),
    updateOne: jest.fn((filter: AnyRecord, update: AnyRecord) =>
      query(() => {
        if (!matches(state.doc, filter)) return { modifiedCount: 0 };
        applyUpdate(state.doc, update);
        return { modifiedCount: 1 };
      }),
    ),
    find: jest.fn().mockReturnValue(query([])),
  };
  const campaignModel = {
    findOne: jest.fn((filter: AnyRecord) =>
      query(() =>
        matches(state.campaign as AnyRecord, filter) ? state.campaign : null,
      ),
    ),
  };
  const campaignAuditor = {
    executeExternalAction:
      input?.execute ?? jest.fn().mockResolvedValue(undefined),
  };
  const slices = {
    loadFull: jest.fn(),
    identityForCycle: jest.fn(),
  };
  const service = new DecisionsService(
    model as any,
    campaignAuditor as any,
    campaignModel as any,
    slices as any,
  );
  return {
    service,
    model,
    campaignModel,
    campaignAuditor,
    slices,
    get doc() {
      return state.doc;
    },
  };
}

describe('DecisionsService execution boundary', () => {
  it('blocks an action whose stored scope cannot be executed', async () => {
    const state = setup({
      doc: decision({
        actionType: 'scale_adset',
        targetType: 'campaign',
        targetId: 'campaign-1',
      }),
    });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result).toEqual({
      executed: false,
      error: 'scale_adset requires an ad-set target, not campaign',
    });
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
    expect(state.doc.executionStatus).toBe('blocked');
    expect(state.doc.shadowModeOnly).toBe(true);
  });

  it('blocks an ad or ad-set id not owned by the decision campaign', async () => {
    const state = setup({
      doc: decision({ targetId: 'ad-from-other-campaign' }),
    });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result.executed).toBe(false);
    expect(result.error).toContain('does not belong to decision campaign');
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
  });

  it('blocks missing action-specific parameters before any executor call', async () => {
    const state = setup({
      doc: decision({
        actionType: 'shift_budget_between_adsets',
        targetType: 'adset',
        targetId: 'adset-1',
        parameters: { toAdSetId: 'adset-2', shiftFraction: 0.3 },
      }),
    });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result.executed).toBe(false);
    expect(result.error).toBe(
      'shift_budget_between_adsets needs shiftPercent in (0, 50]',
    );
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
  });

  it('keeps add_adset review-only until its complete launch contract exists', async () => {
    const state = setup({
      doc: decision({
        actionType: 'add_adset',
        targetType: 'campaign',
        targetId: 'campaign-1',
        parameters: { audienceType: 'retarget' },
      }),
    });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result.executed).toBe(false);
    expect(result.error).toContain('required audience, product, landing-page');
    expect(state.doc.executionStatus).toBe('blocked');
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'pending',
      (doc: AnyRecord) => {
        delete doc.intelligenceReviewVersion;
        delete doc.intelligenceReview;
      },
      'Intelligence review is pending',
    ],
    [
      'fallback',
      (doc: AnyRecord) => {
        doc.intelligenceReview.source = 'fallback';
        doc.intelligenceReview.verdict = 'hold';
        doc.intelligenceReview.validation.valid = false;
      },
      'fallback reviews cannot authorize execution',
    ],
    [
      'hold',
      (doc: AnyRecord) => {
        doc.intelligenceReview.verdict = 'hold';
      },
      'verdict is hold',
    ],
    [
      'reject',
      (doc: AnyRecord) => {
        doc.intelligenceReview.verdict = 'reject';
      },
      'verdict is reject',
    ],
    [
      'invalid',
      (doc: AnyRecord) => {
        doc.intelligenceReview.validation.valid = false;
      },
      'failed deterministic validation',
    ],
  ])(
    'blocks a goal-aware decision with a %s intelligence review',
    async (_label, mutate, message) => {
      const doc = goalAwareDecision();
      mutate(doc);
      const state = setup({ doc });

      const result = await state.service.executeApprovedDecision(
        'tenant-1',
        'decision-1',
      );

      expect(result).toEqual({
        executed: false,
        error: expect.stringContaining(message),
      });
      expect(state.doc.executionStatus).toBe('blocked');
      expect(state.campaignModel.findOne).not.toHaveBeenCalled();
      expect(
        state.campaignAuditor.executeExternalAction,
      ).not.toHaveBeenCalled();
    },
  );

  it('executes a goal-aware decision only after a supported validated OpenAI review', async () => {
    const state = setup({ doc: goalAwareDecision() });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result).toEqual({ executed: true });
    expect(state.campaignAuditor.executeExternalAction).toHaveBeenCalledTimes(
      1,
    );
  });

  it('blocks execution if the decision changed after OpenAI reviewed it', async () => {
    const doc = goalAwareDecision();
    doc.parameters = { dailyBudgetINR: 9_999 };
    const state = setup({ doc });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result).toEqual({
      executed: false,
      error:
        'Intelligence review does not match the stored decision; execution is blocked',
    });
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
  });

  it('records execution only after the external executor resolves', async () => {
    const state = setup();

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result).toEqual({ executed: true });
    expect(state.campaignAuditor.executeExternalAction).toHaveBeenCalledTimes(
      1,
    );
    expect(state.doc.executedAt).toBeInstanceOf(Date);
    expect(state.doc.executionStatus).toBe('succeeded');
    expect(state.doc.executionError).toBeUndefined();
    expect(state.doc.shadowModeOnly).toBe(false);
  });

  it('allows only one concurrent request to call the external executor', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = jest.fn().mockImplementation(() => hold);
    const state = setup({ execute });

    const first = state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );
    const second = state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    const secondResult = await second;
    expect(secondResult).toEqual({
      executed: false,
      error: 'Decision execution is already in progress',
    });

    release();
    await expect(first).resolves.toEqual({ executed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('requires explicit retry after failure', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('Meta rejected target'))
      .mockResolvedValueOnce(undefined);
    const state = setup({ execute });

    await expect(
      state.service.executeApprovedDecision('tenant-1', 'decision-1'),
    ).resolves.toEqual({
      executed: false,
      error: 'Meta rejected target',
    });
    expect(state.doc.executionStatus).toBe('failed');

    await expect(
      state.service.executeApprovedDecision('tenant-1', 'decision-1'),
    ).resolves.toEqual({
      executed: false,
      error:
        'Previous execution failed; use the explicit retry-execution endpoint after checking Meta',
    });
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(
      state.service.retryFailedExecution('tenant-1', 'decision-1'),
    ).resolves.toEqual({ executed: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(state.doc.executionStatus).toBe('succeeded');
  });

  it('will not execute a decision that is not approved', async () => {
    const state = setup({ doc: decision({ status: 'shadow_review' }) });

    const result = await state.service.executeApprovedDecision(
      'tenant-1',
      'decision-1',
    );

    expect(result.executed).toBe(false);
    expect(result.error).toContain('only approved decisions can execute');
    expect(state.campaignModel.findOne).not.toHaveBeenCalled();
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
  });

  it('does not reveal or execute another tenant decision', async () => {
    const state = setup();

    await expect(
      state.service.executeApprovedDecision('tenant-2', 'decision-1'),
    ).rejects.toThrow('decision decision-1 not found');
    expect(state.campaignAuditor.executeExternalAction).not.toHaveBeenCalled();
  });
});

describe('DecisionsService atomic review transitions', () => {
  it('allows only one concurrent approval transition', async () => {
    const state = setup({ doc: decision({ status: 'shadow_review' }) });

    const results = await Promise.allSettled([
      state.service.approve('tenant-1', 'decision-1', 'reviewer-a'),
      state.service.approve('tenant-1', 'decision-1', 'reviewer-b'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(state.doc.status).toBe('approved');
  });

  it('reject cannot overwrite an approved or executed decision', async () => {
    const state = setup({
      doc: decision({
        status: 'approved',
        executionStatus: 'succeeded',
        executedAt: new Date(),
      }),
    });

    await expect(
      state.service.reject('tenant-1', 'decision-1', 'changed my mind'),
    ).rejects.toThrow('only shadow_review decisions can be rejected');
    expect(state.doc.status).toBe('approved');
    expect(state.doc.executionStatus).toBe('succeeded');
  });
});

describe('DecisionsService cycle trace identity', () => {
  it('tenant-scopes identity before loading slices and resolves campaign name', async () => {
    const state = setup();
    state.model.find.mockReturnValue(query([]));
    state.slices.identityForCycle.mockResolvedValue({
      tenantId: 'tenant-1',
      campaignId: 'campaign-1',
    });
    state.slices.loadFull.mockResolvedValue({
      execution: {
        data: { applied: [], deferred: [], failed: [] },
        confidence: 0.8,
        evidence: [],
        version: 'test@1',
        computedAt: new Date(),
        ms: 1,
        deterministic: true,
      },
    });

    const result = await state.service.cycleTrace('tenant-1', 'cycle-1');

    expect(result.campaignName).toBe('Nadi Leaf Sales');
    expect(result.decisionsInCycle).toBe(0);
    expect(state.slices.identityForCycle).toHaveBeenCalledWith(
      'cycle-1',
      'tenant-1',
    );
    expect(state.slices.loadFull).toHaveBeenCalledWith('cycle-1', 'tenant-1');
  });

  it('returns not found without loading another tenant cycle slices', async () => {
    const state = setup();
    state.slices.identityForCycle.mockResolvedValue(null);

    await expect(
      state.service.cycleTrace('tenant-2', 'cycle-1'),
    ).rejects.toThrow('No engine output found for cycle cycle-1');
    expect(state.slices.identityForCycle).toHaveBeenCalledWith(
      'cycle-1',
      'tenant-2',
    );
    expect(state.slices.loadFull).not.toHaveBeenCalled();
    expect(state.model.find).not.toHaveBeenCalled();
  });
});

describe('DecisionsService intelligence review trace exposure', () => {
  const intelligenceReview = {
    verdict: 'hold',
    headline: 'More evidence is needed',
    source: 'openai',
  };
  const intelligenceEvidence = {
    packet: { schemaVersion: 'intelligence_review_v1', facts: [] },
    hierarchy: { nodes: [] },
  };
  const intelligenceReviewedAt = new Date('2026-08-23T06:30:00.000Z');

  it('exposes the denormalized review on a decision trace', async () => {
    const state = setup({
      doc: decision({
        intelligenceReviewVersion: 'intelligence_review_v1',
        intelligenceReview,
        intelligenceEvidence,
        intelligenceReviewedAt,
      }),
    });
    state.slices.loadFull.mockResolvedValue({
      execution: {
        data: { applied: [], deferred: [], failed: [] },
        confidence: 0.8,
        evidence: [],
        version: 'test@1',
        computedAt: new Date(),
        ms: 1,
        deterministic: true,
      },
    });

    const result = await state.service.trace('tenant-1', 'decision-1');

    expect(result).toMatchObject({
      intelligenceReviewVersion: 'intelligence_review_v1',
      intelligenceReview,
      intelligenceEvidence,
      intelligenceReviewedAt,
    });
  });

  it('exposes the top decision review on a cycle trace', async () => {
    const state = setup({
      doc: decision({
        intelligenceReviewVersion: 'intelligence_review_v1',
        intelligenceReview,
        intelligenceEvidence,
        intelligenceReviewedAt,
      }),
    });
    state.model.find.mockReturnValue(query([state.doc]));
    state.slices.identityForCycle.mockResolvedValue({
      tenantId: 'tenant-1',
      campaignId: 'campaign-1',
    });
    state.slices.loadFull.mockResolvedValue({
      execution: {
        data: { applied: [], deferred: [], failed: [] },
        confidence: 0.8,
        evidence: [],
        version: 'test@1',
        computedAt: new Date(),
        ms: 1,
        deterministic: true,
      },
    });

    const result = await state.service.cycleTrace('tenant-1', 'cycle-1');

    expect(result).toMatchObject({
      topDecisionId: 'decision-1',
      intelligenceReviewVersion: 'intelligence_review_v1',
      intelligenceReview,
      intelligenceEvidence,
      intelligenceReviewedAt,
    });
  });

  it('omits review fields for historical decisions without Step-14 review data', async () => {
    const state = setup();
    state.slices.loadFull.mockResolvedValue({});

    const result = await state.service.trace('tenant-1', 'decision-1');

    expect(result).not.toHaveProperty('intelligenceReviewVersion');
    expect(result).not.toHaveProperty('intelligenceReview');
    expect(result).not.toHaveProperty('intelligenceEvidence');
    expect(result).not.toHaveProperty('intelligenceReviewedAt');
  });
});
