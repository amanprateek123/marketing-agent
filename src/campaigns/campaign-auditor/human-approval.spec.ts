import { CampaignAuditorService } from './campaign-auditor.service';
import { CampaignsService } from '../campaigns.service';
import { hasHumanActionApproval } from '../human-action-approval';

jest.mock('uuid', () => ({ v4: () => 'new-action' }));

describe('mandatory campaign action approval', () => {
  let auditor: any;
  let campaign: any;
  let company: any;
  beforeEach(() => {
    campaign = {
      _id: 'campaign',
      tenantId: 'tenant',
      metaCampaignId: 'meta',
      name: 'Test',
      pendingActions: [],
      adSets: [],
    };
    company = {
      tenantId: 'tenant',
      meta: { accessToken: 'token' },
      pipelineConfig: { scaleRequiresApproval: false },
    };
    auditor = Object.create(CampaignAuditorService.prototype);
    Object.assign(auditor, {
      campaignModel: {
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      },
      metaAds: {
        pauseAdSet: jest.fn().mockResolvedValue(undefined),
        pauseCampaign: jest.fn().mockResolvedValue(undefined),
      },
      campaignsService: { pause: jest.fn().mockResolvedValue(undefined) },
      actionLogger: { log: jest.fn().mockResolvedValue(undefined) },
      actionOutcomes: {
        recordExecuted: jest.fn().mockResolvedValue(undefined),
      },
      alerts: { raise: jest.fn().mockResolvedValue(undefined) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
  });

  it.each([
    'narrow_placement',
    'add_creative',
    'dayparting',
    'shift_budget_between_adsets',
    'scale_adset',
    'reduce_total_budget',
    'pause_adset',
  ])(
    'only proposes %s even when automatic scaling is configured',
    async (type) => {
      await auditor.createPendingAction(campaign, company, {
        type,
        targetId: 'adset',
        targetName: 'Test',
        reason: 'Test',
        metrics: { shiftPercent: 10 },
        gracePeriodHours: 0,
      });
      expect(campaign.pendingActions[0]).toMatchObject({
        status: 'pending',
        autoApplied: false,
      });
      expect(campaign.pendingActions[0].humanApprovedAt).toBeUndefined();
      expect(campaign.pendingActions[0].executedAt).toBeUndefined();
    },
  );

  it('never runs overdue or legacy auto-executed actions in a background audit', async () => {
    campaign.pendingActions = [
      {
        actionId: 'expired',
        type: 'pause_adset',
        status: 'pending',
        executeAt: new Date(0),
      },
      {
        actionId: 'legacy',
        type: 'pause_adset',
        status: 'executed',
        autoApplied: true,
        executedAt: new Date(),
      },
      {
        actionId: 'approved',
        type: 'pause_adset',
        status: 'executed',
        humanApprovedAt: new Date(),
      },
    ];
    expect(await auditor.executePendingActions(campaign, company)).toBe(false);
    expect(auditor.metaAds.pauseAdSet).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'pending', executeAt: new Date(0) },
    { status: 'executed', executedAt: new Date() },
    { status: 'executed', autoApplied: true, humanApprovedAt: new Date() },
    { status: 'executed', humanApprovedAt: 'invalid' },
  ])(
    'rejects an explicit execution request without valid human authorization: %j',
    async (state) => {
      campaign.pendingActions = [
        { actionId: 'action', type: 'pause_adset', ...state },
      ];
      await expect(
        auditor.executePendingActions(campaign, company, 'action'),
      ).rejects.toThrow('Human approval');
      expect(auditor.metaAds.pauseAdSet).not.toHaveBeenCalled();
    },
  );

  it('applies only the selected approved action and records real human approval', async () => {
    campaign.pendingActions = [
      {
        actionId: 'unapproved',
        type: 'pause_adset',
        status: 'pending',
        executeAt: new Date(0),
      },
      {
        actionId: 'approved',
        type: 'pause_adset',
        targetId: 'adset',
        status: 'executed',
        humanApprovedAt: new Date(),
      },
    ];
    expect(
      await auditor.executePendingActions(campaign, company, 'approved'),
    ).toBe(true);
    expect(auditor.metaAds.pauseAdSet).toHaveBeenCalledTimes(1);
    expect(auditor.metaAds.pauseAdSet).toHaveBeenCalledWith('adset', 'token');
    expect(auditor.actionOutcomes.recordExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'human_approved' }),
    );
  });

  it('turns a safety limit into an approval proposal without pausing Meta', async () => {
    company.maxBudgetPerCampaign = 100;
    expect(
      await auditor.runSafetyRails(
        campaign,
        { campaign: { spend: 200 } },
        company,
        0,
      ),
    ).toBe(true);
    expect(campaign.pendingActions[0]).toMatchObject({
      type: 'pause_campaign',
      status: 'pending',
    });
    expect(auditor.campaignsService.pause).not.toHaveBeenCalled();
    expect(auditor.metaAds.pauseCampaign).not.toHaveBeenCalled();
  });

  it('can execute a safety pause after human approval', async () => {
    campaign.pendingActions = [
      {
        actionId: 'approved',
        type: 'pause_campaign',
        reason: 'cap',
        status: 'executed',
        humanApprovedAt: new Date(),
      },
    ];
    expect(
      await auditor.executePendingActions(campaign, company, 'approved'),
    ).toBe(true);
    expect(auditor.metaAds.pauseCampaign).toHaveBeenCalledWith('meta', 'token');
    expect(auditor.campaignsService.pause).toHaveBeenCalledWith(
      'tenant',
      'campaign',
      'cap',
    );
  });

  it('records authorization atomically in the approval path', async () => {
    const service: any = Object.create(CampaignsService.prototype);
    const action = {
      actionId: 'action',
      status: 'pending',
      type: 'pause_adset',
      targetName: 'Test',
    };
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    service.campaignModel = {
      findOne: () => ({ exec: async () => ({ pendingActions: [action] }) }),
      updateOne,
    };
    await service.executeAction('tenant', 'campaign', 'action');
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter.pendingActions.$elemMatch).toEqual({
      actionId: 'action',
      status: 'pending',
    });
    expect(
      hasHumanActionApproval({
        status: update.$set['pendingActions.$.status'],
        humanApprovedAt: update.$set['pendingActions.$.humanApprovedAt'],
        autoApplied: update.$set['pendingActions.$.autoApplied'],
      }),
    ).toBe(true);
    updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      service.executeAction('tenant', 'campaign', 'action'),
    ).rejects.toThrow('no longer pending');
  });
});
