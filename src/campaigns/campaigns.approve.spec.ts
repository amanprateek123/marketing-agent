import { CampaignsController } from './campaigns.controller';

// Exercise the approval boundary without external services or a database.
describe('campaign approval preview option', () => {
  const company = { tenantId: 'tenant', meta: { accountIds: ['123'] } };
  let controller: CampaignsController;
  let launch: jest.Mock;
  beforeEach(() => {
    controller = Object.create(CampaignsController.prototype);
    launch = jest
      .fn()
      .mockResolvedValue({ metaCampaignId: 'meta', status: 'paused' });
    Object.assign(controller, {
      logger: { error: jest.fn() },
      companiesService: {
        findByTenantId: jest.fn().mockResolvedValue(company),
      },
      campaignCreator: { launch },
    });
  });
  it('passes a paused launch request through and reports the stored status', async () => {
    expect(
      await controller.approve('tenant', 'campaign', 'act_123', true),
    ).toEqual({ success: true, metaCampaignId: 'meta', status: 'paused' });
    expect(launch).toHaveBeenCalledWith('campaign', company, 'act_123', {
      launchPaused: true,
    });
  });
  it('preserves normal approval behavior when omitted', async () => {
    await controller.approve('tenant', 'campaign', 'act_123');
    expect(launch).toHaveBeenCalledWith('campaign', company, 'act_123', {
      launchPaused: false,
    });
  });
  it.each(['true', 'false', 1, null])(
    'rejects malformed launchPaused: %j',
    async (value) => {
      await expect(
        controller.approve('tenant', 'campaign', 'act_123', value as any),
      ).rejects.toThrow('launchPaused must be a boolean');
      expect(launch).not.toHaveBeenCalled();
    },
  );
  it('still rejects accounts outside the tenant account list', async () => {
    await expect(
      controller.approve('tenant', 'campaign', 'act_other', true),
    ).rejects.toThrow('not in your Meta account list');
    expect(launch).not.toHaveBeenCalled();
  });
  it('logs and returns the launch rejection reason', async () => {
    launch.mockRejectedValue(new Error('Variant 1: missing uploaded video'));
    await expect(
      controller.approve('tenant', 'campaign', 'act_123'),
    ).rejects.toThrow('missing uploaded video');
    expect((controller as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('missing uploaded video'),
    );
  });
});
