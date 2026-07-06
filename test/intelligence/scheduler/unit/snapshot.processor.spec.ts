import { SnapshotProcessor } from '../../../../src/intelligence/scheduler/snapshot.processor';
import { SnapshotEngine } from '../../../../src/intelligence/snapshot/snapshot-engine.service';
import {
  SnapshotTarget,
  TenantCampaignsProvider,
} from '../../../../src/intelligence/scheduler/tenant-campaigns.provider.interface';

/**
 * Unit-tests the processor's run() method with pure stubs. Avoids
 * BullMQ + Redis entirely; the real @Processor decoration is
 * exercised end-to-end only in a live integration test (deferred).
 */
describe('SnapshotProcessor.run', () => {
  const target = (id: string): SnapshotTarget => ({
    campaignId: `cam-${id}`,
    metaCampaignId: `meta-${id}`,
    products: [{ name: 'p', conversionValue: 999 }],
  });

  function build(opts: {
    targets: SnapshotTarget[];
    capture?: jest.Mock;
  }) {
    const captureMock =
      opts.capture ??
      (jest.fn().mockResolvedValue({ snapshotId: 'snap-x', confidence: 0.9 }));
    const engine = { capture: captureMock } as unknown as SnapshotEngine;
    const campaigns: TenantCampaignsProvider = {
      listActiveCampaigns: jest.fn().mockResolvedValue(opts.targets),
    };
    const processor = new SnapshotProcessor(engine, campaigns);
    return { processor, engine, campaigns, captureMock };
  }

  it('captures a snapshot for every active campaign of the tenant', async () => {
    const { processor, captureMock, campaigns } = build({
      targets: [target('a'), target('b'), target('c')],
    });
    const result = await processor.run({ tenantId: 'astro' });
    expect(campaigns.listActiveCampaigns).toHaveBeenCalledWith('astro');
    expect(captureMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      tenantId: 'astro',
      attempted: 3,
      succeeded: 3,
      failed: 0,
      errors: [],
    });
  });

  it('returns immediately with zero counts when no campaigns are active', async () => {
    const { processor, captureMock } = build({ targets: [] });
    const result = await processor.run({ tenantId: 'astro' });
    expect(captureMock).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('continues after a single failure and records the error', async () => {
    const captureMock = jest
      .fn()
      .mockResolvedValueOnce({ snapshotId: 'snap-1', confidence: 0.9 })
      .mockRejectedValueOnce(new Error('meta_5xx'))
      .mockResolvedValueOnce({ snapshotId: 'snap-3', confidence: 0.9 });
    const { processor } = build({
      targets: [target('a'), target('b'), target('c')],
      capture: captureMock,
    });
    const result = await processor.run({ tenantId: 'astro' });
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toEqual({ campaignId: 'cam-b', error: 'meta_5xx' });
  });

  it('handles non-Error throws by stringifying', async () => {
    const captureMock = jest.fn().mockRejectedValueOnce('rate_limited');
    const { processor } = build({ targets: [target('a')], capture: captureMock });
    const result = await processor.run({ tenantId: 'astro' });
    expect(result.errors[0].error).toBe('rate_limited');
  });

  it('propagates campaigns.listActiveCampaigns rejection to the caller', async () => {
    const engine = { capture: jest.fn() } as unknown as SnapshotEngine;
    const campaigns: TenantCampaignsProvider = {
      listActiveCampaigns: jest.fn().mockRejectedValue(new Error('db_down')),
    };
    const processor = new SnapshotProcessor(engine, campaigns);
    await expect(processor.run({ tenantId: 'astro' })).rejects.toThrow('db_down');
  });
});
