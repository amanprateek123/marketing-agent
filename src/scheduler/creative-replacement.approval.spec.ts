import { CreativeReplacementProcessor } from './creative-replacement.processor';

jest.mock('uuid', () => ({ v4: () => 'id' }));

describe('creative worker approval boundary', () => {
  let worker: any;
  let campaign: any;
  let job: any;
  beforeEach(() => {
    campaign = {
      _id: 'campaign',
      productName: 'Test',
      pendingActions: [],
      adSets: [{ metaAdSetId: 'adset', ads: [] }],
    };
    job = {
      data: {
        tenantId: 'tenant',
        campaignId: 'campaign',
        actionId: 'action',
        briefId: 'brief',
        fatiguedAdId: '',
        fatiguedHook: '',
        replacementHook: 'curiosity',
        adSetId: 'adset',
      },
    };
    worker = Object.create(CreativeReplacementProcessor.prototype);
    Object.assign(worker, {
      campaignModel: {
        findOne: jest.fn(() => ({
          lean: () => ({ exec: async () => campaign }),
          exec: async () => campaign,
        })),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      },
      briefModel: {
        findOne: () => ({
          lean: () => ({ exec: async () => ({ product: 'Test' }) }),
        }),
      },
      companiesService: {
        findByTenantId: jest
          .fn()
          .mockResolvedValue({
            meta: { accessToken: 'token' },
            products: [{ name: 'Test', landingUrl: 'https://example.com' }],
          }),
      },
      creativeProducer: {
        produce: jest
          .fn()
          .mockResolvedValue({
            status: 'complete',
            copyVariants: [{ primaryText: 'Body', headline: 'Hook' }],
            images: [
              { variantIndex: 0, imageUrl: 'https://example.com/image.png' },
            ],
          }),
      },
      metaAds: {
        createAdInAdSet: jest.fn().mockResolvedValue({ adId: 'new-ad' }),
      },
      alerts: { raise: jest.fn().mockResolvedValue(undefined) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
  });

  it.each([
    undefined,
    {
      actionId: 'action',
      type: 'add_creative',
      targetId: 'adset',
      status: 'executed',
      autoApplied: true,
    },
    {
      actionId: 'action',
      type: 'add_creative',
      targetId: 'adset',
      status: 'executed',
    },
    {
      actionId: 'action',
      type: 'add_creative',
      targetId: 'other',
      status: 'executed',
      humanApprovedAt: new Date(),
    },
  ])('blocks old or unauthorized queued jobs: %j', async (action) => {
    campaign.pendingActions = action ? [action] : [];
    await worker.process(job);
    expect(worker.creativeProducer.produce).not.toHaveBeenCalled();
    expect(worker.metaAds.createAdInAdSet).not.toHaveBeenCalled();
  });

  it('blocks legacy jobs with no action ID even if another action was approved', async () => {
    campaign.pendingActions = [
      {
        actionId: 'action',
        type: 'add_creative',
        targetId: 'adset',
        status: 'executed',
        humanApprovedAt: new Date(),
      },
    ];
    delete job.data.actionId;
    await worker.process(job);
    expect(worker.creativeProducer.produce).not.toHaveBeenCalled();
  });

  it('publishes a creative for its exact approved action', async () => {
    campaign.pendingActions = [
      {
        actionId: 'action',
        type: 'add_creative',
        targetId: 'adset',
        status: 'executed',
        humanApprovedAt: new Date(),
      },
    ];
    await worker.process(job);
    expect(worker.metaAds.createAdInAdSet).toHaveBeenCalledTimes(1);
    expect(worker.campaignModel.updateOne).toHaveBeenCalledWith(
      {
        _id: 'campaign',
        tenantId: 'tenant',
        'pendingActions.actionId': 'action',
      },
      { $set: { 'pendingActions.$.replacementStatus': 'complete' } },
    );
  });

  it('rechecks approval after production before publishing', async () => {
    campaign.pendingActions = [
      {
        actionId: 'action',
        type: 'add_creative',
        targetId: 'adset',
        status: 'executed',
        humanApprovedAt: new Date(),
      },
    ];
    worker.creativeProducer.produce.mockImplementation(async () => {
      campaign.pendingActions[0].humanApprovedAt = undefined;
      return { status: 'complete' };
    });
    await worker.process(job);
    expect(worker.metaAds.createAdInAdSet).not.toHaveBeenCalled();
  });
});
