import { goalProgress } from './loop.logic';
import { PmPipelineService } from './pm-pipeline.service';

const lines = (g: unknown) =>
  (PmPipelineService.prototype as any).goalLines(g, 'ev-3').join('\n');

describe('owner goal in the brief', () => {
  const base = {
    source: 'first-party',
    maxDailyBudget: 5000,
    currentDailyBudget: 3000,
  };
  const open = {
    ...base,
    ...goalProgress(
      {
        targetPurchases: 60,
        targetRoas: 2,
        targetDays: 3,
        start: '2026-11-05',
      },
      '2026-11-06',
      10,
      100,
    ),
    dataTo: '2026-11-05',
    periodRoas: 1.2,
    periodSpend: 1000,
    purchasesPerDay7: 8,
    cost7: 100,
    roas7: 1.1,
  };

  it('tells the AI all four values and what is still needed', () => {
    const t = lines(open);
    expect(t).toContain("## Owner's goal (ev-3)");
    expect(t).toContain('ROAS 2.00 and 60 purchases in 3 days');
    expect(t).toContain('2026-11-05 → 2026-11-07');
    expect(t).toContain('2 days left');
    expect(t).toContain('50 to go');
    expect(t).toContain('Needed: 25.00/day');
    expect(t).toContain('₹5,000');
    expect(t).not.toContain('above the max daily budget');
  });

  it('warns when the goal needs more than the max budget', () => {
    expect(lines({ ...open, maxDailyBudget: 1000 })).toContain(
      'above the max daily budget',
    );
  });

  it('says when a goal has ended, and when there is none', () => {
    expect(lines({ ...open, daysLeft: 0 })).toContain('No goal is open now');
    expect(lines(null)).toContain('None set by the owner');
    expect(
      lines({
        ...base,
        daysLeft: null,
        targetPurchases: null,
        targetRoas: null,
      }),
    ).toContain('₹5,000');
  });
});

describe('goal basis: Meta when first-party cannot see the campaign', () => {
  const proto = PmPipelineService.prototype as any;
  const camp = { entityId: 'c1', product: 'career-report' };
  const ctx = (linkedToMetaAd: number | null) => ({
    analysis: { coverage: async () => ({ linkedToVisit: 1, linkedToMetaAd }) },
  });

  it('is untracked only when the product has orders and none link to an ad', async () => {
    expect(await proto.metaBasis.call(ctx(0), '2026-11-06', camp)).toBe(
      'untracked',
    );
    expect(await proto.metaBasis.call(ctx(0.4), '2026-11-06', camp)).toBeNull();
    expect(
      await proto.metaBasis.call(ctx(null), '2026-11-06', camp),
    ).toBeNull();
    expect(
      await proto.metaBasis.call(ctx(0.4), '2026-11-06', {
        ...camp,
        product: 'app-chat',
      }),
    ).toBe('app');
  });

  it('counts the goal on Meta purchases when untracked, and says why', async () => {
    const doc = {
      targetPurchases: 15,
      targetRoas: 1,
      targetDays: 3,
      targetStart: '2026-11-05',
      maxDailyBudget: 3000,
    };
    const m = {
      spend: 3000,
      metaPurchases: 3,
      metaRoas: 0.74,
      firstPartyOrders: 0,
      firstPartyRoas: 0,
      firstPartyCpa: null,
    };
    const self = {
      env: { tenantId: 't' },
      targets: { findOne: () => ({ lean: async () => doc }) },
      metaBasis: async () => 'untracked',
      currentDailyBudget: async () => 3000,
      analysis: { scopeMetrics: async () => m },
    };
    const g = await proto.goal.call(self, '2026-11-06', camp);
    expect(g.source).toBe('Meta');
    expect(g.purchases).toBe(3);
    expect(g.periodRoas).toBe(0.74);
    expect(lines(g)).toContain('counted on Meta numbers (see "Tracking gap")');
  });
});
