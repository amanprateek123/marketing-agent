import { CampaignCopilotProcessor } from './campaign-copilot.processor';
import {
  CampaignCopilotPlan,
  CampaignCopilotSessionStatus,
  emptyCampaignCopilotPlan,
} from './campaign-copilot.contracts';

const tenantId = 'tenant-1';
const sessionId = 'session-1';
const confirmationHash = 'abcdef1234567890';
const runId = `copilot-${sessionId}-${confirmationHash.slice(0, 12)}`;

function configuredProduct() {
  return {
    name: 'Product One',
    active: true,
    price: 999,
    currency: 'INR',
    description: 'A configured product',
    landingUrl: 'https://example.com/product',
    conversionEvent: 'Purchase',
    conversionValue: 999,
    audienceSegments: [],
    metaAudiences: [],
  };
}

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

function harness(options: { creativeFailure?: Error } = {}) {
  const plan = readyPlan();
  const session = {
    tenantId,
    sessionId,
    status: CampaignCopilotSessionStatus.BUILD_QUEUED,
    confirmedPlan: plan,
    confirmedPlanHash: confirmationHash,
    build: {},
    createdAt: new Date('2026-08-22T00:00:00.000Z'),
  } as any;
  const sessionModel = {
    findOne: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(session),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        ...session,
        status: CampaignCopilotSessionStatus.BUILDING,
      }),
    }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  const creativeBrief = {
    topic: plan.campaignName,
    angle: 'Purchase angle',
    platform: 'Meta',
    format: 'image',
    audience: 'cold advantage_plus',
    hook: 'Purchase angle',
    keyMessage: 'A configured product',
    conversionBridge: 'Purchase Product One',
    targetSegment: '',
  };
  const creativeBriefModel = {
    findOneAndUpdate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(creativeBrief),
    }),
  };
  const pipelineRunModel = {
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  const company = {
    tenantId,
    promptsVersion: 3,
    products: [configuredProduct()],
  } as any;
  const companiesService = {
    findByTenantId: jest.fn().mockResolvedValue(company),
    appendCopilotProductIfAbsent: jest.fn(),
    fillMissingCopilotProductFields: jest.fn(),
  };
  const creativeProducer = {
    produce: options.creativeFailure
      ? jest.fn().mockRejectedValue(options.creativeFailure)
      : jest.fn().mockResolvedValue({
          _id: 'creative-package-1',
          status: 'completed',
        }),
  };
  const manualCampaignService = {
    create: jest.fn().mockResolvedValue({ _id: 'campaign-1' }),
  };
  const campaignsService = {
    findByRunId: jest.fn().mockResolvedValue(null),
  };
  const processor = new CampaignCopilotProcessor(
    sessionModel as any,
    creativeBriefModel as any,
    pipelineRunModel as any,
    companiesService as any,
    creativeProducer as any,
    manualCampaignService as any,
    campaignsService as any,
  );
  return {
    processor,
    sessionModel,
    pipelineRunModel,
    companiesService,
    company,
  };
}

describe('CampaignCopilotProcessor isolation and product writes', () => {
  it('includes tenantId in every PipelineRun query on a successful build', async () => {
    const { processor, pipelineRunModel } = harness();

    await processor.process({
      data: { tenantId, sessionId, confirmationHash },
      opts: { attempts: 2 },
      attemptsMade: 0,
    } as any);

    const filters = [
      ...pipelineRunModel.findOneAndUpdate.mock.calls.map((call) => call[0]),
      ...pipelineRunModel.updateOne.mock.calls.map((call) => call[0]),
    ];
    expect(filters).toHaveLength(3);
    expect(filters).toEqual(
      expect.arrayContaining([
        { tenantId, runId },
        { tenantId, runId },
        { tenantId, runId },
      ]),
    );
  });

  it('includes tenantId in the PipelineRun failure update', async () => {
    const { processor, pipelineRunModel } = harness({
      creativeFailure: new Error('creative failed'),
    });

    await expect(
      processor.process({
        data: { tenantId, sessionId, confirmationHash },
        opts: { attempts: 1 },
        attemptsMade: 0,
      } as any),
    ).rejects.toThrow('creative failed');

    expect(pipelineRunModel.updateOne).toHaveBeenCalledWith(
      { tenantId, runId },
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('atomically appends a new product without saving a stale company', async () => {
    const { processor, companiesService } = harness();
    const staleCompany = {
      tenantId,
      products: [],
      save: jest.fn(),
      markModified: jest.fn(),
    } as any;
    const plan: CampaignCopilotPlan = {
      ...readyPlan(),
      productMode: 'new',
      productName: 'New Product',
      landingUrl: 'https://example.com/new',
      newProduct: {
        description: 'A newly configured product',
        price: 1_499,
        currency: 'INR',
        conversionEvent: 'Purchase',
        conversionValue: 1_499,
        pixelId: null,
        customConversionId: null,
        pageId: 'page-1',
        metaAppId: null,
        metaAppStoreUrl: null,
      },
    };
    companiesService.appendCopilotProductIfAbsent.mockImplementation(
      async (
        _tenant: string,
        key: string,
        product: Record<string, unknown>,
      ) => ({
        tenantId,
        products: [{ ...product, copilotProductKey: key }],
      }),
    );

    const result = await (processor as any).ensureProduct(
      staleCompany,
      plan,
      sessionId,
    );

    expect(companiesService.appendCopilotProductIfAbsent).toHaveBeenCalledWith(
      tenantId,
      'newproduct',
      expect.objectContaining({
        name: 'New Product',
        copilotSessionId: sessionId,
      }),
    );
    expect(staleCompany.save).not.toHaveBeenCalled();
    expect(result.product).toMatchObject({
      name: 'New Product',
      copilotSessionId: sessionId,
      copilotProductKey: 'newproduct',
    });
    expect(result.company.products).toHaveLength(1);
  });

  it('fills an existing product without saving its stale products array', async () => {
    const { processor, companiesService } = harness();
    const staleCompany = {
      tenantId,
      products: [
        {
          ...configuredProduct(),
          landingUrl: undefined,
          pixelId: undefined,
        },
      ],
      save: jest.fn(),
      markModified: jest.fn(),
    } as any;
    const plan: CampaignCopilotPlan = {
      ...readyPlan(),
      newProduct: {
        description: null,
        price: null,
        currency: null,
        conversionEvent: null,
        conversionValue: null,
        pixelId: 'pixel-1',
        customConversionId: null,
        pageId: null,
        metaAppId: null,
        metaAppStoreUrl: null,
      },
    };
    const refreshedCompany = {
      tenantId,
      products: [
        {
          ...configuredProduct(),
          landingUrl: plan.landingUrl,
          pixelId: 'pixel-1',
        },
      ],
    };
    companiesService.fillMissingCopilotProductFields.mockResolvedValue(
      refreshedCompany,
    );

    const result = await (processor as any).ensureProduct(
      staleCompany,
      plan,
      sessionId,
    );

    expect(
      companiesService.fillMissingCopilotProductFields,
    ).toHaveBeenCalledWith(tenantId, 'Product One', {
      landingUrl: plan.landingUrl,
      pixelId: 'pixel-1',
    });
    expect(staleCompany.save).not.toHaveBeenCalled();
    expect(result.company).toBe(refreshedCompany);
    expect(result.product).toMatchObject({
      name: 'Product One',
      landingUrl: plan.landingUrl,
      pixelId: 'pixel-1',
    });
  });

  it('stops when another writer wins a missing product field race', async () => {
    const { processor, companiesService } = harness();
    const staleCompany = {
      tenantId,
      products: [{ ...configuredProduct(), pixelId: undefined }],
      save: jest.fn(),
      markModified: jest.fn(),
    } as any;
    const plan: CampaignCopilotPlan = {
      ...readyPlan(),
      newProduct: {
        description: null,
        price: null,
        currency: null,
        conversionEvent: null,
        conversionValue: null,
        pixelId: 'confirmed-pixel',
        customConversionId: null,
        pageId: null,
        metaAppId: null,
        metaAppStoreUrl: null,
      },
    };
    companiesService.fillMissingCopilotProductFields.mockResolvedValue({
      tenantId,
      products: [{ ...configuredProduct(), pixelId: 'other-pixel' }],
    });

    await expect(
      (processor as any).ensureProduct(staleCompany, plan, sessionId),
    ).rejects.toThrow('field "pixelId" changed after confirmation');
    expect(staleCompany.save).not.toHaveBeenCalled();
  });

  it('does not reuse a same-session new product changed between retries', async () => {
    const { processor, companiesService } = harness();
    const plan: CampaignCopilotPlan = {
      ...readyPlan(),
      productMode: 'new',
      productName: 'New Product',
      landingUrl: 'https://example.com/new',
      newProduct: {
        description: 'A newly configured product',
        price: 1_499,
        currency: 'INR',
        conversionEvent: 'Purchase',
        conversionValue: 1_499,
        pixelId: 'confirmed-pixel',
        customConversionId: null,
        pageId: 'page-1',
        metaAppId: null,
        metaAppStoreUrl: null,
      },
    };
    const companyWithChangedProduct = {
      tenantId,
      products: [
        {
          name: 'New Product',
          price: 1_499,
          currency: 'INR',
          description: 'A newly configured product',
          active: true,
          copilotSessionId: sessionId,
          landingUrl: 'https://example.com/new',
          languages: ['english'],
          conversionEvent: 'Purchase',
          conversionValue: 1_499,
          pixelId: 'changed-pixel',
          pageId: 'page-1',
          audienceSegments: [],
          metaAudiences: [],
        },
      ],
    } as any;

    await expect(
      (processor as any).ensureProduct(
        companyWithChangedProduct,
        plan,
        sessionId,
      ),
    ).rejects.toThrow('field "pixelId" changed after confirmation');
    expect(
      companiesService.appendCopilotProductIfAbsent,
    ).not.toHaveBeenCalled();
  });
});
