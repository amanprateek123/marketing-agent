import { CycleProcessor } from '../../../../src/intelligence/scheduler/cycle.processor';
import { IntelligenceOrchestrator } from '../../../../src/intelligence/orchestrator/intelligence-orchestrator.service';
import { SnapshotEngine } from '../../../../src/intelligence/snapshot/snapshot-engine.service';
import {
  SnapshotTarget,
  TenantCampaignsProvider,
} from '../../../../src/intelligence/scheduler/tenant-campaigns.provider.interface';

describe('CycleProcessor.run', () => {
  const target = (id: string): SnapshotTarget => ({
    campaignId: `cam-${id}`,
    metaCampaignId: `meta-${id}`,
    products: [{ name: 'p', conversionValue: 999 }],
  });

  function build(opts: {
    targets: SnapshotTarget[];
    openCycle?: jest.Mock;
    captureForCycle?: jest.Mock;
  }) {
    const openCycle =
      opts.openCycle ??
      jest.fn().mockImplementation(async (input) => ({
        cycleId: `cyc-${input.campaignId}`,
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        startedAt: new Date(),
        timings: {},
        featureFlags: {
          intelligenceV2: true,
          contextsEnabled: 16,
          executeEnabled: false,
          shadowCompareInDashboard: false,
        },
        errors: [],
        skipped: [],
        audit: [],
      }));
    const captureForCycle = opts.captureForCycle ?? jest.fn().mockResolvedValue(undefined);
    const orchestrator = { openCycle } as unknown as IntelligenceOrchestrator;
    const engine = { captureForCycle } as unknown as SnapshotEngine;
    const campaigns: TenantCampaignsProvider = {
      listActiveCampaigns: jest.fn().mockResolvedValue(opts.targets),
    };
    const processor = new CycleProcessor(orchestrator, engine, campaigns);
    return { processor, orchestrator, engine, campaigns, openCycle, captureForCycle };
  }

  it('opens one cycle per active campaign and calls captureForCycle', async () => {
    const { processor, openCycle, captureForCycle } = build({
      targets: [target('a'), target('b')],
    });
    const result = await processor.run({ tenantId: 'astro' });
    expect(openCycle).toHaveBeenCalledTimes(2);
    expect(captureForCycle).toHaveBeenCalledTimes(2);
    expect(captureForCycle.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        cycleId: 'cyc-cam-a',
        tenantId: 'astro',
        campaignId: 'cam-a',
        metaCampaignId: 'meta-a',
      }),
    );
    expect(result.opened).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('records openCycle failure without aborting the sweep', async () => {
    const openCycle = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('cycle_write_failed')))
      .mockImplementationOnce(async (input) => ({
        cycleId: `cyc-${input.campaignId}`,
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        startedAt: new Date(),
        timings: {},
        featureFlags: {
          intelligenceV2: true,
          contextsEnabled: 16,
          executeEnabled: false,
          shadowCompareInDashboard: false,
        },
        errors: [],
        skipped: [],
        audit: [],
      }));
    const { processor, captureForCycle } = build({
      targets: [target('a'), target('b')],
      openCycle,
    });
    const result = await processor.run({ tenantId: 'astro' });
    expect(result.attempted).toBe(2);
    expect(result.opened).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toEqual({
      campaignId: 'cam-a',
      error: 'cycle_write_failed',
    });
    // Second campaign still processed
    expect(captureForCycle).toHaveBeenCalledTimes(1);
  });

  it('records captureForCycle failure', async () => {
    const captureForCycle = jest
      .fn()
      .mockRejectedValueOnce(new Error('meta_5xx'))
      .mockResolvedValueOnce(undefined);
    const { processor } = build({
      targets: [target('a'), target('b')],
      captureForCycle,
    });
    const result = await processor.run({ tenantId: 'astro' });
    expect(result.opened).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe('meta_5xx');
  });

  it('returns zero counts when no campaigns are active', async () => {
    const { processor, openCycle, captureForCycle } = build({ targets: [] });
    const result = await processor.run({ tenantId: 'astro' });
    expect(openCycle).not.toHaveBeenCalled();
    expect(captureForCycle).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
    expect(result.opened).toBe(0);
    expect(result.failed).toBe(0);
  });
});
