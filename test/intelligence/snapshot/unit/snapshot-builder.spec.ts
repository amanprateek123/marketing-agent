import { SnapshotBuilder } from '../../../../src/intelligence/snapshot/snapshot-builder.service';
import {
  ProductForRevenue,
  RawMetaBundle,
} from '../../../../src/intelligence/snapshot/snapshot.types';

describe('SnapshotBuilder', () => {
  let builder: SnapshotBuilder;
  const now = new Date('2026-07-01T12:00:00Z');
  const windowEnd = new Date('2026-07-01T11:55:00Z');
  const windowStart = new Date('2026-06-24T11:55:00Z');

  beforeEach(() => {
    builder = new SnapshotBuilder();
  });

  function bundle(overrides: Partial<RawMetaBundle> = {}): RawMetaBundle {
    return {
      campaign: {
        id: 'meta-cmp-1',
        name: 'Test',
        productName: 'Kundli Reading',
        objective: 'OUTCOME_SALES',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        learning_stage: 'ACTIVE',
        account_id: 'act_123',
        insights: {
          spend: '1500',
          impressions: '30000',
          reach: '20000',
          clicks: '600',
          ctr: '2',
          cpc: '2.5',
          cpm: '50',
          frequency: '1.5',
          actions: [
            { action_type: 'purchase', value: '20' },
            { action_type: 'add_to_cart', value: '55' },
            { action_type: 'initiate_checkout', value: '32' },
          ],
          action_values: [{ action_type: 'purchase', value: '3000' }],
        },
      },
      adSets: {},
      ads: {},
      metaWindowStart: windowStart,
      metaWindowEnd: windowEnd,
      ...overrides,
    };
  }

  const product: ProductForRevenue = {
    name: 'Kundli Reading',
    conversionValue: 999,
    contributionMargin: 40,
    refundRatePercent: 5,
  };

  it('normalizes campaign-level Meta payload into MetricSet', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    const m = data.metrics.campaignLevel;
    expect(m.spend).toBe(1500);
    expect(m.impressions).toBe(30000);
    expect(m.reach).toBe(20000);
    expect(m.clicks).toBe(600);
    expect(m.frequency).toBe(1.5);
    expect(m.purchases).toBe(20);
    expect(m.addToCart).toBe(55);
    expect(m.initiateCheckout).toBe(32);
  });

  it('applies refund haircut to raw action_values revenue', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    // 3000 * (1 - 0.05) = 2850
    expect(data.metrics.campaignLevel.revenue).toBeCloseTo(2850);
  });

  it('falls back to product.conversionValue when action_values absent', () => {
    const b = bundle();
    delete b.campaign.insights!.action_values;
    const data = builder.build({ bundle: b, products: [product], now });
    // 20 purchases * 999 * 0.95 = 18981
    expect(data.metrics.campaignLevel.revenue).toBeCloseTo(18981);
  });

  it('sets revenue = 0 when no product config and no action_values', () => {
    const b = bundle();
    delete b.campaign.insights!.action_values;
    const data = builder.build({ bundle: b, products: [], now });
    expect(data.metrics.campaignLevel.revenue).toBe(0);
  });

  it('computes CVR = purchases / clicks with safe divide', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    // 20 / 600 = 0.0333
    expect(data.metrics.campaignLevel.cvr).toBeCloseTo(0.0333, 4);
  });

  it('computes AOV = revenue / purchases', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    // 2850 / 20 = 142.5
    expect(data.metrics.campaignLevel.aov).toBeCloseTo(142.5, 2);
  });

  it('computes ROAS = revenue / spend', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    // 2850 / 1500 = 1.9
    expect(data.metrics.campaignLevel.roas).toBeCloseTo(1.9, 2);
  });

  it('safe-divides by zero without producing NaN/Infinity', () => {
    const b = bundle({
      campaign: {
        insights: {
          spend: '0',
          clicks: '0',
          impressions: '0',
          actions: [],
        },
      },
    });
    const data = builder.build({ bundle: b, products: [product], now });
    expect(data.metrics.campaignLevel.cvr).toBe(0);
    expect(data.metrics.campaignLevel.aov).toBe(0);
    expect(data.metrics.campaignLevel.roas).toBe(0);
  });

  it('populates freshnessSec from now - metaWindowEnd', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    // now=12:00, windowEnd=11:55 → 300s
    expect(data.freshnessSec).toBe(300);
  });

  it('marks source freshness unknown when a persisted adapter explicitly lacks sync time', () => {
    const data = builder.build({
      bundle: bundle({ sourceMetricsSyncedAt: null }),
      products: [product],
      now,
    });

    expect(data.freshnessSec).toBe(-1);
  });

  it('marks an invalid source synchronization timestamp as unknown', () => {
    const data = builder.build({
      bundle: bundle({ sourceMetricsSyncedAt: new Date('invalid') }),
      products: [product],
      now,
    });

    expect(data.freshnessSec).toBe(-1);
  });

  it('carries the source metric scope into the analysis snapshot', () => {
    const data = builder.build({
      bundle: bundle({ metricScope: 'lifetime' }),
      products: [product],
      now,
    });

    expect(data.meta.metricScope).toBe('lifetime');
  });

  it('maps learning_stage to canonical enum', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    expect(data.meta.learningStage).toBe('ACTIVE');
  });

  it('drops unknown learning_stage values as undefined', () => {
    const b = bundle();
    b.campaign.learning_stage = 'MYSTERY';
    const data = builder.build({ bundle: b, products: [product], now });
    expect(data.meta.learningStage).toBeUndefined();
  });

  it('normalizes adset payloads', () => {
    const b = bundle({
      adSets: {
        as1: {
          id: 'as1',
          name: 'India cold',
          status: 'active',
          effectiveStatus: 'ACTIVE',
          audienceType: 'lookalike',
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          landingPageViews: 165,
          insights: {
            spend: '500',
            impressions: '10000',
            clicks: '200',
            actions: [{ action_type: 'purchase', value: '8' }],
            action_values: [{ action_type: 'purchase', value: '1200' }],
          },
        },
      },
    });
    const data = builder.build({ bundle: b, products: [product], now });
    expect(data.metrics.adSetLevel.as1.spend).toBe(500);
    expect(data.metrics.adSetLevel.as1.revenue).toBeCloseTo(1140); // haircut 5%
    expect(data.metrics.adSetLevel.as1.roas).toBeCloseTo(2.28, 2);
    expect(data.metrics.adSetLevel.as1.cvr).toBeCloseTo(0.04, 4);
    expect(data.metrics.adSetLevel.as1.aov).toBeCloseTo(142.5, 2);
    expect(data.metrics.adSetLevel.as1.landingPageViews).toBe(165);
    expect(data.entities?.adSets.as1).toEqual({
      id: 'as1',
      name: 'India cold',
      status: 'active',
      effectiveStatus: 'ACTIVE',
      audienceType: 'lookalike',
      optimizationGoal: 'OFFSITE_CONVERSIONS',
    });
  });

  it('normalizes ad payloads including video quartiles', () => {
    const b = bundle({
      ads: {
        ad1: {
          id: 'ad1',
          adSetId: 'as1',
          name: 'Pain hook video',
          status: 'active',
          effectiveStatus: 'ACTIVE',
          hookStyle: 'pain_point',
          format: 'video',
          copyVariantIndex: 2,
          creativeId: 'creative-1',
          creativeName: 'Pain hook',
          creativeBody: 'Know why the same problems repeat',
          creativeTitle: 'Read your Kundli',
          creativeCta: 'LEARN_MORE',
          creativeLinkUrl: 'https://example.test/kundli',
          creativeVideoId: 'video-1',
          creativeImageHash: 'hash-1',
          thumbnailUrl: 'https://example.test/thumb.jpg',
          isDynamicCreative: false,
          landingPageViews: 64,
          inlineLinkClicks: 71,
          outboundClicks: 59,
          video3s: 1750,
          thruplay: 610,
          last7d: {
            spend: '60',
            impressions: '1800',
            clicks: '36',
            ctr: '2',
            actions: [{ action_type: 'purchase', value: '2' }],
            action_values: [{ action_type: 'purchase', value: '240' }],
          },
          quality_ranking: 'ABOVE_AVERAGE',
          engagement_ranking: 'AVERAGE',
          conversion_ranking: 'BELOW_AVERAGE',
          insights: {
            spend: '100',
            impressions: '5000',
            clicks: '80',
            actions: [{ action_type: 'purchase', value: '3' }],
            action_values: [{ action_type: 'purchase', value: '450' }],
            video_p25_watched_actions: [{ value: '3200' }],
            video_p50_watched_actions: [{ value: '1800' }],
            video_p75_watched_actions: [{ value: '900' }],
            video_p100_watched_actions: [{ value: '420' }],
          },
        },
      },
    });
    const data = builder.build({ bundle: b, products: [product], now });
    const ad = data.metrics.adLevel.ad1;
    expect(ad.hookStyle).toBe('pain_point');
    expect(ad.format).toBe('video');
    expect(ad.copyVariantIndex).toBe(2);
    expect(ad.qualityRanking).toBe('ABOVE_AVERAGE');
    expect(ad.engagementRanking).toBe('AVERAGE');
    expect(ad.conversionRanking).toBe('BELOW_AVERAGE');
    expect(ad.videoP25).toBe(3200);
    expect(ad.videoP100).toBe(420);
    expect(ad.cvr).toBeCloseTo(0.0375, 4);
    expect(ad.aov).toBeCloseTo(142.5, 2);
    expect(ad.landingPageViews).toBe(64);
    expect(ad.inlineLinkClicks).toBe(71);
    expect(ad.outboundClicks).toBe(59);
    expect(ad.video3s).toBe(1750);
    expect(ad.thruplay).toBe(610);
    expect(ad.last7d).toEqual({
      spend: 60,
      impressions: 1800,
      clicks: 36,
      ctr: 2,
      purchases: 2,
      revenue: 228,
      cvr: expect.closeTo(2 / 36, 4),
      aov: 114,
      roas: 3.8,
    });
    expect(data.entities?.ads.ad1).toEqual({
      id: 'ad1',
      adSetId: 'as1',
      name: 'Pain hook video',
      status: 'active',
      effectiveStatus: 'ACTIVE',
      creative: {
        id: 'creative-1',
        name: 'Pain hook',
        body: 'Know why the same problems repeat',
        title: 'Read your Kundli',
        cta: 'LEARN_MORE',
        linkUrl: 'https://example.test/kundli',
        videoId: 'video-1',
        imageHash: 'hash-1',
        thumbnailUrl: 'https://example.test/thumb.jpg',
        isDynamic: false,
      },
    });
  });

  it('keeps missing optional hierarchy and creative metrics unresolved', () => {
    const data = builder.build({
      bundle: bundle({
        ads: {
          ad1: {
            id: 'ad1',
            name: 'No enrichment',
            last7d: {},
            insights: { spend: '10', impressions: '100' },
          },
        },
      }),
      products: [product],
      now,
    });

    expect(data.entities?.campaign).toEqual({
      id: 'meta-cmp-1',
      name: 'Test',
      productName: 'Kundli Reading',
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
    });
    expect(data.entities?.ads.ad1.adSetId).toBeUndefined();
    expect(data.entities?.ads.ad1.creative).toBeUndefined();
    expect(data.metrics.adLevel.ad1.landingPageViews).toBeUndefined();
    expect(data.metrics.adLevel.ad1.inlineLinkClicks).toBeUndefined();
    expect(data.metrics.adLevel.ad1.video3s).toBeUndefined();
    expect(data.metrics.adLevel.ad1.last7d).toBeUndefined();
  });

  it('does not estimate missing 7-day return from configured product value', () => {
    const data = builder.build({
      bundle: bundle({
        ads: {
          ad1: {
            id: 'ad1',
            last7d: {
              spend: '50',
              clicks: '20',
              actions: [{ action_type: 'purchase', value: '2' }],
            },
          },
        },
      }),
      products: [product],
      now,
    });

    expect(data.metrics.adLevel.ad1.last7d).toMatchObject({
      spend: 50,
      clicks: 20,
      purchases: 2,
      cvr: 0.1,
    });
    expect(data.metrics.adLevel.ad1.last7d?.revenue).toBeUndefined();
    expect(data.metrics.adLevel.ad1.last7d?.aov).toBeUndefined();
    expect(data.metrics.adLevel.ad1.last7d?.roas).toBeUndefined();
  });

  it('carries ad-set goal metrics and keeps an omitted Meta row explicitly unresolved', () => {
    const metricsSyncedAt = new Date('2026-07-01T11:50:00Z');
    const data = builder.build({
      bundle: bundle({
        adSets: {
          as1: {
            id: 'as1',
            name: 'LPV set',
            optimizationGoal: 'LANDING_PAGE_VIEWS',
            inlineLinkClicks: 42,
            thruplay: 18,
            metricProvenance: {
              rowObserved: false,
              fetchComplete: false,
              state: 'preserved',
              source: 'meta_insights',
              sourceFingerprint: 'sha256:source',
              currency: 'INR',
              metricsSyncedAt,
              dateStart: '2026-06-01',
              dateStop: '2026-06-30',
              attributionSpec: [
                { event_type: 'CLICK_THROUGH', window_days: 7 },
              ],
              revenueBasis: 'configured_conversion_value',
              configuredRevenueEstimateNet: 500,
              canonicalRevenueNet: 500,
              canonicalConversions: 2,
              goalResultInputs: {
                actionCounts: { landing_page_view: 12 },
                actionValuesGross: {},
              },
            },
            insights: {
              spend: '100',
              impressions: '1000',
              clicks: '50',
            },
          },
        },
      }),
      products: [product],
      now,
    });

    expect(data.metrics.adSetLevel.as1).toMatchObject({
      inlineLinkClicks: 42,
      thruplay: 18,
      purchases: 2,
      revenue: 500,
      provenance: {
        rowObserved: false,
        fetchComplete: false,
        state: 'preserved',
        sourceFingerprint: 'sha256:source',
        dateStart: '2026-06-01',
        dateStop: '2026-06-30',
        configuredRevenueEstimateNet: 500,
      },
    });
    expect(
      data.metrics.adSetLevel.as1.provenance?.rawMetaActionValueGross,
    ).toBeUndefined();
    expect(data.missingFields).toContain('ad_set_metrics_row:as1');
  });

  it('detects missing spend when impressions and spend both zero', () => {
    const b = bundle({
      campaign: {
        insights: {
          spend: '0',
          impressions: '0',
          clicks: '0',
          actions: [],
        },
      },
    });
    const data = builder.build({ bundle: b, products: [product], now });
    expect(data.missingFields).toContain('spend');
    expect(data.missingFields).toContain('impressions');
  });

  it('flags missing ad_set_breakdown when adSets object empty', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    expect(data.missingFields).toContain('ad_set_breakdown');
  });

  it('does not flag missing frequency when impressions are 0', () => {
    const b = bundle({
      campaign: {
        insights: {
          spend: '10',
          impressions: '0',
          clicks: '0',
          frequency: '0',
          actions: [],
        },
      },
    });
    const data = builder.build({ bundle: b, products: [product], now });
    expect(data.missingFields).not.toContain('frequency');
  });

  it('flags missing frequency when impressions > 0 but frequency == 0', () => {
    const b = bundle({
      campaign: {
        insights: {
          spend: '100',
          impressions: '5000',
          clicks: '80',
          frequency: '0',
          actions: [],
        },
      },
    });
    const data = builder.build({ bundle: b, products: [product], now });
    expect(data.missingFields).toContain('frequency');
  });

  it('produces stable snapshotIds prefixed snap-', () => {
    const data = builder.build({ bundle: bundle(), products: [product], now });
    expect(data.snapshotId).toMatch(/^snap-/);
  });
});
