import { Model } from 'mongoose';
import {
  Campaign,
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from '../../../../src/campaigns/schemas/campaign.schema';
import { Company } from '../../../../src/companies/schemas/company.schema';
import { RevenueData } from '../../../../src/intelligence/orchestrator/decision-context';
import {
  RevenueDerivation,
  RevenueEngine,
} from '../../../../src/intelligence/revenue/revenue-engine.service';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';

type RevenueOutput = RevenueData & { derivation: RevenueDerivation };

interface CampaignFixture {
  name: string;
  productName: string;
  revenueBasis: CampaignRevenueBasis;
  revenueAttributionSource: CampaignRevenueAttributionSource;
}

interface Harness {
  identity: Map<string, { tenantId: string; campaignId: string }>;
  compute(
    deps: ComputeDeps<'revenue'>,
    cycleId: string,
  ): Promise<RevenueOutput>;
  computeConfidence(
    deps: ComputeDeps<'revenue'>,
    output: RevenueOutput,
  ): number;
}

const PRODUCTS = [
  {
    name: 'Nadi Report',
    active: true,
    contributionMargin: 0.97,
    refundRatePercent: 0,
  },
  {
    name: 'Nadi Leaf',
    active: true,
    contributionMargin: 0.45,
    refundRatePercent: 0,
  },
];

function resolvedQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function makeHarness(input?: {
  products?: Array<Record<string, unknown>>;
  campaign?: CampaignFixture | null;
}): Harness {
  const company = {
    tenantId: 'astro',
    products: input?.products ?? PRODUCTS,
  };
  const campaign =
    input?.campaign === undefined
      ? {
          name: 'Nadi Leaf - Purchase - August',
          productName: 'Nadi Leaf',
          revenueBasis: 'meta_action_value' as const,
          revenueAttributionSource: 'standard_event' as const,
        }
      : input.campaign;
  const companyModel = {
    findOne: jest.fn(() => resolvedQuery(company)),
  } as unknown as Model<Company>;
  const campaignModel = {
    findOne: jest.fn(() => resolvedQuery(campaign)),
  } as unknown as Model<Campaign>;
  const engine = new RevenueEngine(
    {} as SliceRepository,
    {} as EngineEventBus,
    {} as EngineRegistry,
    companyModel,
    campaignModel,
  );
  const harness = engine as unknown as Harness;
  harness.identity.set('cycle-1', {
    tenantId: 'astro',
    campaignId: 'campaign-1',
  });
  return harness;
}

function makeDeps(overrides?: {
  spend?: number;
  revenue?: number;
  purchases?: number;
  roas?: number;
  objective?: string;
}): ComputeDeps<'revenue'> {
  const spend = overrides?.spend ?? 600;
  const revenue = overrides?.revenue ?? 900;
  const purchases = overrides?.purchases ?? 4;
  return {
    snapshot: {
      data: {
        metrics: {
          campaignLevel: {
            spend,
            revenue,
            purchases,
            roas: overrides?.roas ?? (spend > 0 ? revenue / spend : 0),
          },
          adSetLevel: {
            'adset-1': { revenue: revenue / 2 },
          },
        },
      },
      confidence: 1,
      evidence: [],
      version: 'snapshot@test',
      computedAt: new Date(),
      ms: 0,
      deterministic: true,
    },
    objective: {
      data: { objective: overrides?.objective ?? 'sales' },
      confidence: 1,
      evidence: [],
      version: 'objective@test',
      computedAt: new Date(),
      ms: 0,
      deterministic: true,
    },
    trend: {
      data: { perMetric: {} },
      confidence: 1,
      evidence: [],
      version: 'trend@test',
      computedAt: new Date(),
      ms: 0,
      deterministic: true,
    },
  } as unknown as ComputeDeps<'revenue'>;
}

describe('RevenueEngine product and return provenance', () => {
  it('refuses to use the first active product when a multi-product campaign is unresolved', async () => {
    const engine = makeHarness({
      campaign: {
        name: 'Generic evergreen campaign',
        productName: '',
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'standard_event',
      },
    });

    const output = await engine.compute(makeDeps(), 'cycle-1');

    expect(output.economicsAvailable).toBe(false);
    expect(output.financialDataAvailable).toBe(false);
    expect(output.derivation.method).toBe('unavailable');
    expect(output.derivation.product).toBeNull();
    expect(output.derivation.productResolution).toBe('unresolved');
    expect(output.derivation.marginPct).toBe(0);
    expect(output.breakeven.roas).toBe(0);
    expect(output.targetROAS).toBe(0);
    expect(output.attributedByProduct).toEqual({});
    expect(output.derivation.notes.join(' ')).toContain('refusing to guess');
  });

  it('uses the campaign productName instead of another tenant product', async () => {
    const engine = makeHarness();

    const output = await engine.compute(makeDeps(), 'cycle-1');

    expect(output.economicsAvailable).toBe(true);
    expect(output.revenueEvidenceAvailable).toBe(true);
    expect(output.financialDataAvailable).toBe(true);
    expect(output.derivation.product).toBe('Nadi Leaf');
    expect(output.derivation.productResolution).toBe('campaign_field');
    expect(output.derivation.marginPct).toBe(0.45);
    expect(output.breakeven.roas).toBe(2.222);
    expect(output.targetROAS).toBe(4.444);
    expect(output.contributionMargin).toBe(-195);
    expect(output.breakeven.isProfitable).toBe(false);
  });

  it('does not invent a one-day profitable duration from one cumulative snapshot', async () => {
    const engine = makeHarness();

    const output = await engine.compute(
      makeDeps({ spend: 600, revenue: 3000, purchases: 10, roas: 5 }),
      'cycle-1',
    );

    expect(output.breakeven.isProfitable).toBe(true);
    expect(output.breakeven.daysSinceBreakeven).toBe(0);
    expect(output.derivation.notes.join(' ')).toContain(
      "system's 4.44× scale heuristic",
    );
    expect(output.derivation.notes.join(' ')).toContain(
      'not an observed business target',
    );
  });

  it('does not apply the refund haircut twice when deriving breakeven', async () => {
    const engine = makeHarness({
      products: [
        {
          name: 'Nadi Leaf Reading',
          // Deactivation prevents new launch selection; it must not change
          // economics for this safely name-mapped historical campaign.
          active: false,
          contributionMargin: 0.45,
          refundRatePercent: 12,
        },
      ],
      campaign: {
        name: 'Nadi Leaf - New Batch_2026-07-20 - TAT',
        productName: '',
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'standard_event',
      },
    });

    const output = await engine.compute(
      makeDeps({ spend: 600, revenue: 792, purchases: 4 }),
      'cycle-1',
    );

    // SnapshotBuilder has already changed ₹900 gross booking value to ₹792
    // net of the 12% refund rate. Net-return ROAS therefore breaks even at
    // 1 / 45% = 2.222x, not 1 / (45% × 88%) = 2.525x.
    expect(output.derivation.product).toBe('Nadi Leaf Reading');
    expect(output.derivation.productResolution).toBe('name_match');
    expect(output.derivation.refundPct).toBe(0.12);
    expect(output.breakeven.roas).toBe(2.222);
    expect(output.targetROAS).toBe(4.444);
    expect(output.contributionMargin).toBe(-243.6);
    expect(output.derivation.notes.join(' ')).toContain(
      'does not apply that haircut a second time',
    );
  });

  it('does not override an invalid recorded product with a campaign-name guess', async () => {
    const engine = makeHarness({
      campaign: {
        name: 'Nadi Leaf - Purchase - August',
        productName: 'Missing Product',
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'standard_event',
      },
    });

    const output = await engine.compute(makeDeps(), 'cycle-1');

    expect(output.economicsAvailable).toBe(false);
    expect(output.derivation.product).toBeNull();
    expect(output.derivation.productResolutionError).toContain(
      'Missing Product',
    );
  });

  it('supports a conservative configured-product match for legacy campaign names', async () => {
    const engine = makeHarness({
      campaign: {
        name: 'Nadi Leaf - Purchase - August',
        productName: '',
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'standard_event',
      },
    });

    const output = await engine.compute(makeDeps(), 'cycle-1');

    expect(output.economicsAvailable).toBe(true);
    expect(output.derivation.product).toBe('Nadi Leaf');
    expect(output.derivation.productResolution).toBe('name_match');
    expect(output.derivation.notes.join(' ')).toContain('legacy campaign name');
  });

  it('uses a product without a recorded mapping only when it is the sole active choice', async () => {
    const engine = makeHarness({
      products: [
        { ...PRODUCTS[0], active: false },
        { ...PRODUCTS[1], active: true },
      ],
      campaign: {
        name: 'Generic evergreen campaign',
        productName: '',
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'standard_event',
      },
    });

    const output = await engine.compute(makeDeps(), 'cycle-1');

    expect(output.economicsAvailable).toBe(true);
    expect(output.derivation.product).toBe('Nadi Leaf');
    expect(output.derivation.productResolution).toBe('sole_active');
  });

  it('withholds economics when the resolved product has no configured margin', async () => {
    const engine = makeHarness({
      products: [
        {
          name: 'Nadi Leaf',
          active: true,
          refundRatePercent: 0,
        },
      ],
    });

    const output = await engine.compute(makeDeps(), 'cycle-1');

    expect(output.economicsAvailable).toBe(false);
    expect(output.derivation.method).toBe('unavailable');
    expect(output.derivation.product).toBe('Nadi Leaf');
    expect(output.derivation.marginPct).toBe(0);
    expect(output.derivation.notes.join(' ')).toContain(
      'has no contributionMargin configured',
    );
  });

  it('withholds profitability when stored return provenance is unknown', async () => {
    const engine = makeHarness({
      campaign: {
        name: 'Nadi Leaf - Purchase - August',
        productName: 'Nadi Leaf',
        revenueBasis: 'unknown',
        revenueAttributionSource: 'unresolved',
      },
    });

    const output = await engine.compute(makeDeps({ roas: 3 }), 'cycle-1');

    expect(output.economicsAvailable).toBe(true);
    expect(output.revenueEvidenceAvailable).toBe(false);
    expect(output.financialDataAvailable).toBe(false);
    expect(output.contributionMargin).toBe(0);
    expect(output.breakeven.isProfitable).toBe(false);
    expect(output.derivation.revenueQuality).toBe('unavailable');
    expect(output.derivation.notes.join(' ')).toContain(
      'financial actions are withheld',
    );
  });

  it('labels configured conversion value as an estimate and caps confidence', async () => {
    const engine = makeHarness({
      campaign: {
        name: 'Nadi Leaf - Purchase - August',
        productName: 'Nadi Leaf',
        revenueBasis: 'configured_conversion_value',
        revenueAttributionSource: 'custom_conversion',
      },
    });
    const deps = makeDeps({ spend: 6000, revenue: 9000, purchases: 30 });

    const output = await engine.compute(deps, 'cycle-1');

    expect(output.revenueEvidenceAvailable).toBe(true);
    expect(output.financialDataAvailable).toBe(true);
    expect(output.derivation.revenueQuality).toBe('configured_estimate');
    expect(engine.computeConfidence(deps, output)).toBe(0.6);
  });
});
