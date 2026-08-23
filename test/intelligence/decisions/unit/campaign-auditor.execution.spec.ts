import { CampaignAuditorService } from '../../../../src/campaigns/campaign-auditor/campaign-auditor.service';

function query<T>(value: T) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

function bareAuditor() {
  const service = Object.create(
    CampaignAuditorService.prototype,
  ) as CampaignAuditorService;
  (service as any).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  (service as any).campaignModel = { updateOne: jest.fn() };
  (service as any).metaAds = {
    pauseAd: jest.fn(),
    pauseAdSet: jest.fn(),
  };
  (service as any).optimizer = {};
  (service as any).actionOutcomes = { recordExecuted: jest.fn() };
  (service as any).actionLogger = { log: jest.fn() };
  return service;
}

describe('CampaignAuditorService explicit execution acknowledgement', () => {
  it('fails closed on add_adset before loading or mutating a campaign', async () => {
    const service = bareAuditor();

    await expect(
      service.executeExternalAction('tenant-1', 'campaign-1', {
        actionId: 'action-add-adset',
        type: 'add_adset',
        targetId: 'campaign-1',
        targetName: 'Campaign 1',
        reason: 'Try a new audience',
        metrics: { audienceType: 'retarget' },
      }),
    ).rejects.toThrow('required audience, product, landing-page');

    expect((service as any).campaignModel.updateOne).not.toHaveBeenCalled();
  });

  it('propagates a Meta failure instead of acknowledging the action', async () => {
    const service = bareAuditor();
    const action = {
      actionId: 'action-1',
      type: 'pause_ad',
      targetId: 'ad-1',
      targetName: 'Ad 1',
      status: 'executed',
      executedAt: new Date(),
      executeAt: new Date(),
      metrics: {},
    };
    const campaign = {
      _id: 'campaign-1',
      pendingActions: [action],
      adSets: [],
    } as any;
    (service as any).campaignModel.findOne = jest
      .fn()
      .mockReturnValue(query(campaign));
    (service as any).metaAds.pauseAd.mockRejectedValue(
      new Error('Meta pause failed'),
    );

    await expect(
      service.executeApprovedAction(
        campaign,
        { meta: { accessToken: 'test-token' } } as any,
        'action-1',
      ),
    ).rejects.toThrow('Meta pause failed');

    expect((service as any).campaignModel.updateOne).not.toHaveBeenCalled();
  });

  it('treats a missing required parameter as a failure without calling an optimizer', async () => {
    const service = bareAuditor();
    (service as any).optimizer.shiftBudgetBetweenAdSets = jest.fn();
    const campaign = {
      _id: 'campaign-1',
      pendingActions: [
        {
          actionId: 'action-1',
          type: 'shift_budget_between_adsets',
          targetId: 'adset-1',
          targetName: 'Donor',
          status: 'executed',
          executedAt: new Date(),
          executeAt: new Date(),
          metrics: {},
        },
      ],
      adSets: [],
    } as any;
    (service as any).campaignModel.findOne = jest
      .fn()
      .mockReturnValue(query(campaign));

    await expect(
      service.executeApprovedAction(
        campaign,
        { meta: { accessToken: 'test-token' } } as any,
        'action-1',
      ),
    ).rejects.toThrow('missing metrics.toAdSetId');

    expect(
      (service as any).optimizer.shiftBudgetBetweenAdSets,
    ).not.toHaveBeenCalled();
  });

  it('removes the temporary bridge action if explicit execution fails', async () => {
    const service = bareAuditor();
    const campaign = {
      _id: 'campaign-1',
      tenantId: 'tenant-1',
      pendingActions: [],
    } as any;
    (service as any).campaignModel.findOne = jest
      .fn()
      .mockReturnValue(query(campaign));
    (service as any).campaignModel.updateOne = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).companiesService = {
      findByTenantId: jest.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        meta: { accessToken: 'test-token' },
      }),
    };
    (service as any).campaignsService = {
      executeAction: jest.fn().mockResolvedValue(undefined),
    };
    service.executeApprovedAction = jest
      .fn()
      .mockRejectedValue(new Error('Meta rejected action'));

    await expect(
      service.executeExternalAction('tenant-1', 'campaign-1', {
        actionId: 'action-1',
        type: 'pause_ad',
        targetId: 'ad-1',
        targetName: 'Ad 1',
        reason: 'Test',
        metrics: {},
      }),
    ).rejects.toThrow('Meta rejected action');

    expect((service as any).campaignModel.updateOne).toHaveBeenLastCalledWith(
      { tenantId: 'tenant-1', _id: 'campaign-1' },
      { $pull: { pendingActions: { actionId: 'action-1' } } },
    );
  });
});
