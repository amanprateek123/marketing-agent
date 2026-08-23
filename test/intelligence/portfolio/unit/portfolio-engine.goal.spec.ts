import { Model } from 'mongoose';
import { Campaign } from '../../../../src/campaigns/schemas/campaign.schema';
import { ObjectiveKey } from '../../../../src/intelligence/orchestrator/decision-context';
import { PortfolioEngine } from '../../../../src/intelligence/portfolio/portfolio-engine.service';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';

class PortfolioHarness extends PortfolioEngine {
  run(deps: ComputeDeps<'portfolio'>) {
    return this.compute(deps, 'cycle-1');
  }

  setIdentity(tenantId: string, campaignId: string): void {
    (
      this as unknown as {
        identity: Map<string, { tenantId: string; campaignId: string }>;
      }
    ).identity.set('cycle-1', { tenantId, campaignId });
  }
}

const slice = (data: unknown) => ({
  data,
  confidence: 0.9,
  evidence: [],
  version: 'test@1',
  computedAt: new Date('2026-08-23T00:00:00.000Z'),
  ms: 1,
  deterministic: true,
});

function modelWith(rows: Array<Record<string, unknown>>): Model<Campaign> {
  const query = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(rows),
  };
  return {
    find: jest.fn().mockReturnValue(query),
  } as unknown as Model<Campaign>;
}

function deps(
  objective: ObjectiveKey,
  metrics: Record<string, number>,
): ComputeDeps<'portfolio'> {
  return {
    snapshot: slice({ metrics: { campaignLevel: metrics } }),
    objective: slice({ objective }),
    revenue: slice({
      financialDataAvailable: true,
      contributionMargin: 100,
      breakeven: { roas: 1, isProfitable: true, daysSinceBreakeven: 1 },
      targetROAS: 2,
    }),
    business: slice({}),
  } as unknown as ComputeDeps<'portfolio'>;
}

describe('PortfolioEngine objective comparison', () => {
  it('excludes other goals and ranks awareness campaigns by lower CPM', async () => {
    const engine = new PortfolioHarness(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      modelWith([
        {
          _id: 'campaign-current',
          objective: 'OUTCOME_AWARENESS',
          spend: 90,
          impressions: 900,
        },
        {
          _id: 'awareness-peer',
          objective: 'OUTCOME_AWARENESS',
          spend: 1000,
          impressions: 1000,
          revenue: 50_000,
          roas: 50,
        },
        {
          _id: 'sales-peer',
          objective: 'OUTCOME_SALES',
          spend: 9000,
          impressions: 10_000,
          revenue: 90_000,
          roas: 10,
        },
      ]),
    );
    engine.setIdentity('tenant-1', 'campaign-current');

    const result = await engine.run(
      deps('awareness', {
        spend: 100,
        revenue: 5000,
        roas: 50,
        impressions: 1000,
        clicks: 10,
      }),
    );

    expect(result.totalPortfolioROAS).toBe(0);
    expect(result.ranking.map((row) => row.campaignId)).toEqual([
      'campaign-current',
      'awareness-peer',
    ]);
    expect(result.ranking.some((row) => row.campaignId === 'sales-peer')).toBe(
      false,
    );
    expect(result.ranking[0]).toMatchObject({ score: 100, tier: 'A' });
    expect(result.budgetProposals[0].reason).toContain(
      'active awareness campaigns by Cost per 1,000 views (lower is better)',
    );
    expect(result.concentration).toBeCloseTo(0.835, 3);
  });

  it('keeps sales portfolio ROAS and ranking scoped to sales peers', async () => {
    const engine = new PortfolioHarness(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      modelWith([
        {
          _id: 'sales-peer',
          objective: 'OUTCOME_SALES',
          spend: 300,
          revenue: 300,
          roas: 1,
        },
        {
          _id: 'awareness-peer',
          objective: 'OUTCOME_AWARENESS',
          spend: 9000,
          revenue: 90_000,
          roas: 10,
          impressions: 100_000,
        },
      ]),
    );
    engine.setIdentity('tenant-1', 'sales-current');

    const result = await engine.run(
      deps('sales', {
        spend: 200,
        revenue: 400,
        roas: 2,
        impressions: 5000,
        clicks: 100,
        purchases: 10,
      }),
    );

    expect(result.totalPortfolioROAS).toBe(1.4);
    expect(result.ranking.map((row) => row.campaignId)).toEqual([
      'sales-current',
      'sales-peer',
    ]);
    expect(
      result.ranking.some((row) => row.campaignId === 'awareness-peer'),
    ).toBe(false);
    expect(result.budgetProposals[0].reason).toContain(
      'active sales campaigns by Return on ad spend (higher is better)',
    );
  });

  it('ranks traffic peers by lower CPC rather than their ROAS', async () => {
    const engine = new PortfolioHarness(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      modelWith([
        {
          _id: 'cheap-clicks',
          objective: 'OUTCOME_TRAFFIC',
          spend: 100,
          clicks: 25,
          roas: 0,
        },
        {
          _id: 'sales-winner',
          objective: 'OUTCOME_SALES',
          spend: 100,
          clicks: 1,
          roas: 20,
          revenue: 2000,
        },
      ]),
    );
    engine.setIdentity('tenant-1', 'traffic-current');

    const result = await engine.run(
      deps('traffic', {
        spend: 100,
        revenue: 1000,
        roas: 10,
        impressions: 5000,
        clicks: 10,
      }),
    );

    expect(result.totalPortfolioROAS).toBe(0);
    expect(result.ranking.map((row) => row.campaignId)).toEqual([
      'cheap-clicks',
      'traffic-current',
    ]);
    expect(
      result.ranking.some((row) => row.campaignId === 'sales-winner'),
    ).toBe(false);
    expect(result.budgetProposals[0].reason).toContain(
      'Cost per click (lower is better)',
    );
  });
});
