import { CampaignCopilotService } from './campaign-copilot.service';
import {
  COPILOT_OBJECTIVE_TO_META,
  COPILOT_OPTIMIZATION_GOAL,
  buildCopilotRecommendations,
  clampDailyBudget,
  computeMaxAllowedDailyBudget,
  evaluateCopilotReadiness,
  explicitlyAcceptsRecommendation,
} from './campaign-copilot.rules';
import {
  CampaignCopilotPlan,
  CampaignCopilotRecommendations,
  emptyCampaignCopilotPlan,
} from './campaign-copilot.contracts';
import { resolveOptimizationGoalForLaunch } from '../campaigns/meta-ads/optimization-goals';

const company = (overrides: Record<string, unknown> = {}) =>
  ({
    tenantId: 'tenant-1',
    name: 'Example',
    industry: 'ecommerce',
    targetAudience: 'Adults',
    customerLanguage: ['english'],
    tone: 'clear',
    uniqueValue: 'Useful',
    geography: 'India',
    language: 'english',
    primaryObjective: 'conversions',
    preferredFormats: ['image'],
    weeklyBudgetCap: 14_000,
    maxBudgetPerCampaign: 3_000,
    meta: {
      accountId: 'act_123',
      accountIds: ['act_123'],
      accessToken: 'not-returned-to-model-as-a-value',
      pageId: 'page-1',
      pixelId: 'pixel-1',
    },
    products: [
      {
        name: 'Product One',
        active: true,
        price: 999,
        currency: 'INR',
        description: 'A configured product',
        landingUrl: 'https://example.com/product',
        conversionEvent: 'Purchase',
        conversionValue: 999,
        performance: {
          totalConversions: 20,
          avgCPA: 300,
          avgROAS: 2,
          bestHookStyle: 'pain_point',
          bestPlatform: 'Meta',
          confidenceLevel: 'medium',
        },
      },
    ],
    ...overrides,
  }) as any;

function readyPlan(): CampaignCopilotPlan {
  return {
    ...emptyCampaignCopilotPlan(),
    campaignName: 'Product One Purchase',
    productMode: 'existing',
    productName: 'Product One',
    landingUrl: 'https://example.com/product',
    objective: 'sales_purchase',
    dailyBudget: 500,
    requestedDailyBudget: 500,
    accountId: 'act_123',
    funnelStage: 'cold',
    audienceType: 'advantage_plus',
    geoLocations: ['IN'],
    language: 'english',
    creativeFormat: 'image',
  };
}

describe('Campaign Copilot deterministic rules', () => {
  it('requires a clear, non-negated recommendation acceptance', () => {
    expect(
      explicitlyAcceptsRecommendation('Go with the recommended budget.'),
    ).toBe(true);
    expect(explicitlyAcceptsRecommendation('You decide for me.')).toBe(true);
    expect(
      explicitlyAcceptsRecommendation(
        "Don't go with the recommended budget, give me ₹1000/day instead.",
      ),
    ).toBe(false);
    expect(explicitlyAcceptsRecommendation('Go with ₹1000/day.')).toBe(false);
    expect(
      explicitlyAcceptsRecommendation(
        "Don't use the recommended budget. Use the recommended audience.",
        'budget',
      ),
    ).toBe(false);
    expect(
      explicitlyAcceptsRecommendation(
        "Don't use the recommended budget. Use the recommended audience.",
        'audience',
      ),
    ).toBe(true);
    expect(explicitlyAcceptsRecommendation('Use that.', 'budget', false)).toBe(
      false,
    );
    expect(
      explicitlyAcceptsRecommendation(
        'Use the recommended creative format.',
        'format',
        false,
      ),
    ).toBe(true);
  });

  it('clamps budget to both weekly remaining capacity and campaign cap', () => {
    const max = computeMaxAllowedDailyBudget({
      company: company(),
      currentWeeklySpend: 10_500,
    });
    expect(max).toBe(500);
    expect(clampDailyBudget(2_000, max)).toBe(500);
  });

  it('keeps awareness and reach distinct through optimization', () => {
    expect(COPILOT_OBJECTIVE_TO_META.awareness).toBe('OUTCOME_AWARENESS');
    expect(COPILOT_OBJECTIVE_TO_META.reach).toBe('OUTCOME_AWARENESS');
    expect(COPILOT_OPTIMIZATION_GOAL.awareness).toBe('AD_RECALL_LIFT');
    expect(COPILOT_OPTIMIZATION_GOAL.reach).toBe('REACH');
  });

  it('does not let product VALUE override a non-sales goal', () => {
    expect(
      resolveOptimizationGoalForLaunch({
        objective: 'OUTCOME_AWARENESS',
        requested: 'REACH',
        productGoal: 'VALUE',
      }),
    ).toBe('REACH');
    expect(
      resolveOptimizationGoalForLaunch({
        objective: 'OUTCOME_TRAFFIC',
        requested: 'LANDING_PAGE_VIEWS',
        productGoal: 'VALUE',
      }),
    ).toBe('LANDING_PAGE_VIEWS');
  });

  it('marks a complete safe Advantage+ purchase plan ready', () => {
    const readiness = evaluateCopilotReadiness({
      company: company(),
      plan: readyPlan(),
      currentWeeklySpend: 0,
    });
    expect(readiness).toEqual({
      ready: true,
      missingFields: [],
      blockers: [],
      warnings: [],
    });
  });

  it('rejects a cross-account audience and invalid country code', () => {
    const plan = {
      ...readyPlan(),
      funnelStage: 'warm' as const,
      audienceType: 'retarget' as const,
      metaAudienceId: 'aud-other-account',
      geoLocations: ['ZZ'],
    };
    const readiness = evaluateCopilotReadiness({
      company: company(),
      plan,
      currentWeeklySpend: 0,
      accountAudiences: [{ id: 'aud-live', name: 'Visitors', type: 'custom' }],
      accountAudiencesVerified: true,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('selected ad account');
    expect(readiness.blockers.join(' ')).toContain('ISO 3166');
  });

  it('does not require conversion tracking for a new awareness product', () => {
    const plan: CampaignCopilotPlan = {
      ...readyPlan(),
      productMode: 'new',
      productName: 'Brand New',
      landingUrl: 'https://example.com/new',
      newProduct: {
        description: 'New product',
        price: 1,
        currency: 'INR',
        conversionEvent: null,
        conversionValue: null,
        pixelId: null,
        customConversionId: null,
        pageId: null,
        metaAppId: null,
        metaAppStoreUrl: null,
      },
      objective: 'awareness',
    };
    const readiness = evaluateCopilotReadiness({
      company: company({ products: [] }),
      plan,
      currentWeeklySpend: 0,
    });
    expect(readiness.missingFields).not.toContain('newProduct.conversionEvent');
    expect(readiness.missingFields).not.toContain('newProduct.conversionValue');
  });

  it('requires tracking and value for a new purchase product', () => {
    const plan: CampaignCopilotPlan = {
      ...readyPlan(),
      productMode: 'new',
      productName: 'Brand New',
      landingUrl: 'https://example.com/new',
      newProduct: {
        description: 'New product',
        price: 999,
        currency: 'INR',
        conversionEvent: null,
        conversionValue: null,
        pixelId: null,
        customConversionId: null,
        pageId: null,
        metaAppId: null,
        metaAppStoreUrl: null,
      },
    };
    const readiness = evaluateCopilotReadiness({
      company: company({
        products: [],
        meta: {
          accountId: 'act_123',
          accessToken: 'configured',
          pageId: 'page-1',
        },
      }),
      plan,
      currentWeeklySpend: 0,
    });
    expect(readiness.missingFields).toEqual(
      expect.arrayContaining([
        'newProduct.conversionEvent',
        'newProduct.conversionValue',
        'newProduct.pixelOrCustomConversion',
      ]),
    );
  });

  it('rejects a Lead conversion event after switching to sales', () => {
    const plan = readyPlan();
    plan.newProduct = {
      description: null,
      price: null,
      currency: null,
      conversionEvent: 'Lead',
      conversionValue: 999,
      pixelId: 'pixel-1',
      customConversionId: null,
      pageId: null,
      metaAppId: null,
      metaAppStoreUrl: null,
    };
    const readiness = evaluateCopilotReadiness({
      company: company({
        products: [
          {
            name: 'Product One',
            active: true,
            price: 999,
            currency: 'INR',
            description: 'Incomplete product',
            landingUrl: 'https://example.com/product',
            conversionValue: 999,
          },
        ],
      }),
      plan,
      currentWeeklySpend: 0,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('purchase-compatible');
  });

  it('bases a budget recommendation on configured CPA without exceeding caps', () => {
    const recommendation = buildCopilotRecommendations({
      company: company(),
      plan: readyPlan(),
      currentWeeklySpend: 12_600,
    });
    expect(recommendation.budget?.dailyBudget).toBe(200);
    expect(recommendation.budget?.maxAllowed).toBe(200);
    expect(recommendation.budget?.rationale).toContain('not a claim');
  });

  it('requires an app-store URL matching the selected platform', () => {
    const plan = {
      ...readyPlan(),
      objective: 'app_promotion' as const,
      appPlatform: 'Android' as const,
    };
    const readiness = evaluateCopilotReadiness({
      company: company({
        products: [
          {
            name: 'Product One',
            active: true,
            price: 999,
            currency: 'INR',
            description: 'iOS-only app',
            landingUrl: 'https://example.com/product',
            metaAppId: 'app-1',
            metaAppStoreUrlIos: 'https://apps.apple.com/app/id1',
          },
        ],
      }),
      plan,
      currentWeeklySpend: 0,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.missingFields).toContain('product.metaAppStoreUrlAndroid');
  });
});

describe('Campaign Copilot plan grounding', () => {
  const recommendations: CampaignCopilotRecommendations = {
    budget: { dailyBudget: 500, maxAllowed: 2_000, rationale: 'test' },
    audience: null,
    accountId: 'act_123',
    objective: 'sales_purchase',
    creativeFormat: 'image',
  };
  const service = new CampaignCopilotService(
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );

  it('ignores every model patch on an empty initial greeting', () => {
    const original = emptyCampaignCopilotPlan();
    const result = (service as any).applyPlanPatch({
      plan: original,
      patch: {
        productName: 'Product One',
        productMode: 'existing',
        dailyBudget: 500,
        objective: 'sales_purchase',
      },
      latestUserMessage: '',
      company: company(),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan).toEqual(original);
  });

  it('does not let generic recommendation acceptance authorize unrelated fields', () => {
    const result = (service as any).applyPlanPatch({
      plan: emptyCampaignCopilotPlan(),
      patch: {
        useRecommendedBudget: true,
        dailyBudget: 500,
        funnelStage: 'cold',
        geoLocations: ['IN'],
        language: 'english',
        creativeFormat: 'video',
        campaignName: 'Invented campaign name',
      },
      latestUserMessage: 'Use the recommended budget.',
      company: company(),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.dailyBudget).toBe(500);
    expect(result.plan.funnelStage).toBeNull();
    expect(result.plan.geoLocations).toEqual([]);
    expect(result.plan.language).toBeNull();
    expect(result.plan.creativeFormat).toBeNull();
    expect(result.plan.campaignName).toBeNull();
  });

  it('uses the explicit budget when the recommended budget is declined', () => {
    const result = (service as any).applyPlanPatch({
      plan: emptyCampaignCopilotPlan(),
      patch: {
        useRecommendedBudget: true,
        dailyBudget: 1_000,
      },
      latestUserMessage:
        "Don't go with the recommended budget, give me ₹1000/day instead.",
      company: company(),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.requestedDailyBudget).toBe(1_000);
    expect(result.plan.dailyBudget).toBe(1_000);
  });

  it('uses the explicitly named account when the recommendation is declined', () => {
    const result = (service as any).applyPlanPatch({
      plan: emptyCampaignCopilotPlan(),
      patch: {
        useRecommendedAccount: true,
        accountId: 'act_456',
      },
      latestUserMessage:
        "Don't use the recommended account; use account act_456 instead.",
      company: company({
        meta: {
          accountId: 'act_123',
          accountIds: ['act_123', 'act_456'],
          accessToken: 'configured',
          pageId: 'page-1',
        },
      }),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.accountId).toBe('act_456');
  });

  it('does not let an unscoped acceptance authorize multiple model flags', () => {
    const result = (service as any).applyPlanPatch({
      plan: emptyCampaignCopilotPlan(),
      patch: {
        useRecommendedBudget: true,
        useRecommendedObjective: true,
      },
      latestUserMessage: 'Use that.',
      company: company(),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.dailyBudget).toBeNull();
    expect(result.plan.objective).toBeNull();
  });

  it('allows an unscoped acceptance when the model requests one field only', () => {
    const result = (service as any).applyPlanPatch({
      plan: emptyCampaignCopilotPlan(),
      patch: { useRecommendedBudget: true },
      latestUserMessage: 'Use that.',
      company: company(),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.dailyBudget).toBe(500);
  });

  it('does not create a model-invented product name', () => {
    const result = (service as any).applyPlanPatch({
      plan: emptyCampaignCopilotPlan(),
      patch: {
        productMode: 'new',
        productName: 'Model Product',
      },
      latestUserMessage: 'Create a new product for me.',
      company: company(),
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.productName).toBeNull();
    expect(result.plan.productMode).toBeNull();
  });

  it('clears and defers audience selection when the account changes', () => {
    const plan = {
      ...emptyCampaignCopilotPlan(),
      accountId: 'act_123',
      funnelStage: 'warm' as const,
      audienceType: 'custom' as const,
      audienceName: 'Old visitors',
      metaAudienceId: 'aud-old',
    };
    const result = (service as any).applyPlanPatch({
      plan,
      patch: {
        accountId: 'act_456',
        audienceName: 'Old visitors',
        metaAudienceId: 'aud-old',
      },
      latestUserMessage: 'Use account 456 and audience aud-old.',
      company: company({
        meta: {
          accountId: 'act_123',
          accountIds: ['act_123', 'act_456'],
          accessToken: 'configured',
          pageId: 'page-1',
        },
      }),
      recommendations,
      accountAudiences: [
        { id: 'aud-old', name: 'Old visitors', type: 'custom' },
      ],
      currentWeeklySpend: 0,
    });
    expect(result.plan.accountId).toBe('act_456');
    expect(result.plan.metaAudienceId).toBeNull();
    expect(result.notes.join(' ')).toContain('account changed');
  });

  it('collects grounded missing setup for an existing product', () => {
    const baseCompany = company({
      products: [
        {
          name: 'Product One',
          active: true,
          price: 999,
          currency: 'INR',
          description: 'Configured but incomplete',
          landingUrl: 'https://example.com/product',
        },
      ],
    });
    const plan = {
      ...emptyCampaignCopilotPlan(),
      productMode: 'existing' as const,
      productName: 'Product One',
      landingUrl: 'https://example.com/product',
    };
    const result = (service as any).applyPlanPatch({
      plan,
      patch: {
        newProduct: {
          conversionEvent: 'Purchase',
          conversionValue: 999,
          pixelId: 'pixel-99',
          pageId: 'page-99',
        },
      },
      latestUserMessage:
        'Use Purchase with conversion value 999, pixel-99 and page-99.',
      company: baseCompany,
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.newProduct).toMatchObject({
      conversionEvent: 'Purchase',
      conversionValue: 999,
      pixelId: 'pixel-99',
      pageId: 'page-99',
    });
  });

  it('does not retain an attempted override of configured product tracking', () => {
    const baseCompany = company({
      products: [
        {
          ...company().products[0],
          pixelId: 'configured-pixel',
        },
      ],
    });
    const result = (service as any).applyPlanPatch({
      plan: {
        ...emptyCampaignCopilotPlan(),
        productMode: 'existing',
        productName: 'Product One',
      },
      patch: { newProduct: { pixelId: 'replacement-pixel' } },
      latestUserMessage: 'Use replacement-pixel.',
      company: baseCompany,
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.newProduct?.pixelId).toBeNull();
  });

  it('preserves previously collected setup when the same product is repeated', () => {
    const baseCompany = company({
      products: [
        {
          name: 'Product One',
          active: true,
          price: 999,
          currency: 'INR',
          description: 'Configured but incomplete',
        },
      ],
    });
    const plan: CampaignCopilotPlan = {
      ...emptyCampaignCopilotPlan(),
      productMode: 'existing',
      productName: 'Product One',
      landingUrl: 'https://example.com/product',
      newProduct: {
        description: null,
        price: null,
        currency: null,
        conversionEvent: 'Purchase',
        conversionValue: 999,
        pixelId: 'pixel-99',
        customConversionId: null,
        pageId: 'page-99',
        metaAppId: null,
        metaAppStoreUrl: null,
      },
    };
    const result = (service as any).applyPlanPatch({
      plan,
      patch: {
        productMode: 'existing',
        productName: 'Product One',
      },
      latestUserMessage: 'Continue with Product One.',
      company: baseCompany,
      recommendations,
      accountAudiences: null,
      currentWeeklySpend: 0,
    });
    expect(result.plan.landingUrl).toBe('https://example.com/product');
    expect(result.plan.newProduct).toMatchObject({
      conversionEvent: 'Purchase',
      conversionValue: 999,
      pixelId: 'pixel-99',
      pageId: 'page-99',
    });
  });
});
