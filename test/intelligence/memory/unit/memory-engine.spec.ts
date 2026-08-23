import { MemoryEngine } from '../../../../src/intelligence/memory/memory-engine.service';
import { MemoryData } from '../../../../src/intelligence/orchestrator/decision-context';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';

class MemoryHarness extends MemoryEngine {
  confidence(data: MemoryData): number {
    return this.computeConfidence({} as ComputeDeps<'memory'>, data);
  }

  evidence(data: MemoryData) {
    return this.buildEvidence({} as ComputeDeps<'memory'>, data);
  }
}

const data = (pastActions: MemoryData['pastActions'] = []): MemoryData => ({
  pastActions,
  causalInsights: [
    {
      finding: 'A tenant-wide hook performed well.',
      confidence: 0.9,
      isolatedVariable: 'creative hook',
    },
  ],
  similarPastCycles: [],
  companyLearnings: {
    winningHooks: ['question'],
    losingHooks: [],
    winningExemplars: [{ hookLine: 'Example', ctr: 2 }],
    audienceHookSaturation: {},
  },
});

describe('MemoryEngine evidence scope', () => {
  const engine = new MemoryHarness(
    null as never,
    null as never,
    null as never,
    null,
    null,
  );

  it('does not let account-wide learnings raise campaign memory confidence', () => {
    expect(engine.confidence(data())).toBe(0.2);
    expect(engine.evidence(data())).toEqual([
      expect.objectContaining({
        kind: 'context',
        ref: 'company.learnings',
        weight: 0,
      }),
    ]);
  });

  it('raises confidence only from measured actions scoped to this campaign', () => {
    const withCampaignAction = data([
      {
        actionType: 'replace_creative',
        targetId: 'ad-1',
        executedAt: new Date('2026-08-20T00:00:00.000Z'),
        outcomeLabel: 'improved',
        context: 'Campaign-specific test',
      },
    ]);

    expect(engine.confidence(withCampaignAction)).toBe(0.6);
    expect(engine.evidence(withCampaignAction)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'memory',
          ref: 'action_outcomes:campaign',
          weight: 1,
        }),
      ]),
    );
  });
});
