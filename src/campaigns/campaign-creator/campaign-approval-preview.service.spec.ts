import { CampaignApprovalPreviewService } from './campaign-approval-preview.service';

/**
 * Tests the exact payload the approve screen renders.
 *
 * The point of this endpoint is that it reports RESOLVED values — the
 * destination URL, pixel and conversion event the launch will really send —
 * rather than fields read off the campaign document, where they don't exist.
 * These cases are the 2026-07-27 campaign in both states: as it actually was
 * (no product recorded → must block), and as it should have been.
 *
 * Instantiated directly with hand-rolled doubles; no Nest DI, no Mongo. The
 * class only ever calls `.findOne().lean().exec()` on the model.
 */

const PRODUCTS = [
  {
    name: 'Nadi Report',
    active: true,
    conversionEvent: 'Purchase',
    landingUrl: 'https://91astrology.com/nadi-report-premium',
    price: 2100,
    conversionValue: 2100,
  },
  {
    name: 'wish letter',
    active: true,
    customConversionId: '28675378708729288',
    pixelId: '459303576818354',
    landingUrl: 'https://91astrology.com/golu-devta-arzi',
    price: 1100,
    conversionValue: 1100,
    contributionMargin: 1,
    languages: ['hindi', 'english', 'hinglish'],
  },
];

const COMPANY = {
  tenantId: '91astrology',
  products: PRODUCTS,
  weeklyBudgetCap: 140000,
  maxBudgetPerCampaign: 8000,
  meta: {
    accessToken: 'tok',
    pageId: '123',
    pixelId: '999',
    accountIds: ['act_549390260260950'],
    accountId: 'act_549390260260950',
  },
};

const PACKAGE = {
  _id: 'pkg1',
  status: 'completed',
  copyVariants: [
    { primaryText: 'Aapki arzi, Golu Devta tak', headline: 'Wish letter', cta: 'Order Now', hookStyle: 'story' },
  ],
  images: [{ variantIndex: 0, aspectRatio: '4:5', imageUrl: 'https://s3/v0.jpg' }],
  videos: [],
  carouselCards: [],
};

function baseCampaign(overrides: Record<string, any> = {}) {
  return {
    _id: 'c1',
    tenantId: '91astrology',
    name: 'Agent_wishletter_advantageplus',
    status: 'pending_approval',
    source: 'human',
    budget: 5000,
    objective: 'OUTCOME_SALES',
    metaCampaignId: '',
    metaAccountId: 'act_549390260260950',
    briefId: '',
    creativePackageId: 'pkg1',
    campaignConfig: {
      budget: 5000,
      objective: 'OUTCOME_SALES',
      conversionEvent: 'Purchase',
      conversionValue: 0,
      adSets: [
        {
          name: 'Agent_wishletter_advantageplus — Advantage+',
          budgetPercent: 100,
          audienceType: 'advantage_plus',
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          creativeFormat: 'image',
          ads: [0],
        },
      ],
    },
    ...overrides,
  };
}

function build(campaign: Record<string, any>, company: Record<string, any> = COMPANY) {
  const campaignModel = {
    findOne: () => ({ lean: () => ({ exec: async () => campaign }) }),
  };
  const campaignsService = {
    findCreativeBrief: async () => null,
    findCreativePackage: async () => PACKAGE,
    getWeeklySpend: async () => 41200,
  };
  const companiesService = { findByTenantId: async () => company };
  const svc = new CampaignApprovalPreviewService(
    campaignModel as any,
    campaignsService as any,
    companiesService as any,
  );
  return svc.build('91astrology', 'c1');
}

describe('CampaignApprovalPreviewService', () => {
  it('REGRESSION: blocks a campaign with no product recorded, rather than resolving one', async () => {
    // The campaign exactly as it was created on 2026-07-27: conversionEvent
    // 'Purchase' and nothing else identifying the product.
    const r = await build(baseCampaign());

    expect(r.ready).toBe(false);
    expect(r.product).toBeNull();
    const codes = r.blockers.map((b: any) => b.code);
    expect(codes).toContain('product_unresolved');

    // Critically: it must NOT have silently resolved to the first product.
    expect(JSON.stringify(r)).not.toContain('nadi-report-premium');

    // The blocker has to tell the operator what to do, and name the options.
    const blocker = r.blockers.find((b: any) => b.code === 'product_unresolved');
    expect(blocker.fix).toContain('productName');
    expect(blocker.fix).toContain('wish letter');

    // Ad sets with no destination are called out individually too.
    expect(codes).toContain('ad_set_no_destination');
    expect(r.adSets[0].destinationUrl).toBe('');
  });

  it('reports the real destination, pixel and conversion once the product is recorded', async () => {
    const r = await build(baseCampaign({ productName: 'wish letter' }));

    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.product.name).toBe('wish letter');
    expect(r.product.resolvedVia).toBe('campaign');
    expect(r.product.landingUrl).toBe('https://91astrology.com/golu-devta-arzi');

    // Tracking comes from the product, not from campaignConfig.conversionEvent
    // (which still says 'Purchase' — the value that caused the original bug).
    expect(r.product.conversionTracking).toEqual({
      type: 'custom_conversion',
      id: '28675378708729288',
    });
    expect(r.product.pixelId).toBe('459303576818354');
    expect(r.product.pixelSource).toBe('product');
    expect(r.product.breakevenROAS).toBe(1);

    // Per-ad-set destination and ₹/day are resolved, not stored.
    expect(r.adSets[0].destinationUrl).toBe('https://91astrology.com/golu-devta-arzi');
    expect(r.adSets[0].dailyBudget).toBe(5000);

    // A custom conversion is account-scoped — the operator should be told.
    expect(r.warnings.map((w: any) => w.code)).toContain('custom_conversion_account_scoped');

    // The name Meta receives, not the stored one.
    expect(r.campaign.metaCampaignName).toMatch(/^Agent_wishletter_advantageplus_\d{4}-\d{2}-\d{2}$/);
  });

  it('flags an inferred product as a warning, not a silent pass', async () => {
    const solo = {
      ...COMPANY,
      products: [PRODUCTS[1]],
    };
    const r = await build(baseCampaign(), solo);

    expect(r.ready).toBe(true);
    expect(r.product.resolvedVia).toBe('sole_active');
    expect(r.warnings.map((w: any) => w.code)).toContain('product_inferred');
  });

  it('blocks on budget caps and unready creative', async () => {
    const r = await build(
      baseCampaign({ productName: 'wish letter', budget: 9000 }),
      { ...COMPANY, weeklyBudgetCap: 45000 },
    );

    const codes = r.blockers.map((b: any) => b.code);
    expect(codes).toContain('over_campaign_cap');
    expect(codes).toContain('over_weekly_cap');
    expect(r.ready).toBe(false);
  });

  it('blocks a campaign that already launched', async () => {
    const r = await build(
      baseCampaign({ productName: 'wish letter', metaCampaignId: '120212000', status: 'active' }),
    );
    const codes = r.blockers.map((b: any) => b.code);
    expect(codes).toContain('already_launched');
    expect(codes).toContain('not_pending_approval');
  });

  it('does not require a product landing URL for a landing-page test', async () => {
    // LP tests carry their two URLs on the ad sets themselves.
    const campaign: any = baseCampaign({ productName: 'Nadi Report' });
    campaign.campaignConfig.isLandingPageTest = true;
    campaign.campaignConfig.adSets = [
      { name: 'LP_A', budgetPercent: 50, audienceType: 'advantage_plus', optimizationGoal: 'OFFSITE_CONVERSIONS', ads: [0], landingUrlOverride: 'https://a.test/x' },
      { name: 'LP_B', budgetPercent: 50, audienceType: 'advantage_plus', optimizationGoal: 'OFFSITE_CONVERSIONS', ads: [0], landingUrlOverride: 'https://b.test/y' },
    ];
    const noUrlCompany = {
      ...COMPANY,
      products: [{ ...PRODUCTS[0], landingUrl: '' }, PRODUCTS[1]],
    };
    const r = await build(campaign, noUrlCompany);

    expect(r.blockers.map((b: any) => b.code)).not.toContain('product_no_landing_url');
    expect(r.adSets[0].destinationUrl).toBe('https://a.test/x');
    expect(r.adSets[1].destinationUrl).toBe('https://b.test/y');
    expect(r.adSets[0].dailyBudget).toBe(2500);
  });
});
