import { Model } from 'mongoose';
import {
  TrendEngine,
  elapsedHistoryDays,
} from '../../../../src/intelligence/trend/trend-engine.service';
import { IntelligenceSnapshotDocument } from '../../../../src/intelligence/snapshot/snapshot.schema';
import { TrendData } from '../../../../src/intelligence/orchestrator/decision-context';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';

class TrendHarness extends TrendEngine {
  run(deps: ComputeDeps<'trend'>): Promise<TrendData> {
    return this.compute(deps, 'cycle-1');
  }
}

describe('elapsedHistoryDays', () => {
  it('returns real elapsed calendar days for Date and serialized values', () => {
    expect(
      elapsedHistoryDays(
        new Date('2026-08-23T12:00:00.000Z'),
        new Date('2026-08-20T12:00:00.000Z'),
      ),
    ).toBe(3);
    expect(
      elapsedHistoryDays(
        '2026-08-23T12:00:00.000Z',
        '2026-08-23T09:00:00.000Z',
      ),
    ).toBe(0.125);
  });

  it('fails closed for missing, invalid, or future history dates', () => {
    expect(elapsedHistoryDays(undefined, undefined)).toBe(0);
    expect(elapsedHistoryDays(new Date(), null)).toBe(0);
    expect(elapsedHistoryDays('invalid', 'also-invalid')).toBe(0);
    expect(
      elapsedHistoryDays(
        '2026-08-20T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      ),
    ).toBe(0);
  });
});

describe('TrendEngine history depth', () => {
  function makeEngine(history: unknown[], oldestCollectedAt: Date) {
    const recentQuery = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(history),
    };
    const oldestQuery = {
      sort: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ collectedAt: oldestCollectedAt }),
    };
    const snapshotModel = {
      find: jest.fn().mockReturnValue(recentQuery),
      findOne: jest.fn().mockReturnValue(oldestQuery),
    } as unknown as Model<IntelligenceSnapshotDocument>;

    const engine = new TrendHarness(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      snapshotModel,
    );
    (
      engine as unknown as {
        identity: Map<string, { tenantId: string; campaignId: string }>;
      }
    ).identity.set('cycle-1', {
      tenantId: '91astrology',
      campaignId: 'campaign-1',
    });
    return { engine, snapshotModel, recentQuery, oldestQuery };
  }

  function depsAt(collectedAt: string, spend = 200) {
    return {
      snapshot: {
        data: {
          snapshotId: 'snapshot-current',
          collectedAt: new Date(collectedAt),
          metrics: {
            campaignLevel: {
              spend,
              impressions: 4000,
              reach: 3000,
            },
          },
        },
        confidence: 0.9,
        evidence: [],
        version: 'snapshot@test',
        computedAt: new Date(collectedAt),
        ms: 1,
        deterministic: false,
      },
    } as unknown as ComputeDeps<'trend'>;
  }

  it('does not treat repeated intraday snapshots as days of trend history', async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      snapshotId: index === 0 ? 'snapshot-current' : `snapshot-${index}`,
      collectedAt: new Date(
        `2026-08-23T${String(11 - Math.floor(index / 12)).padStart(2, '0')}:${String((index % 12) * 5).padStart(2, '0')}:00.000Z`,
      ),
      metrics: {
        campaignLevel: {
          spend: 100 + index,
          impressions: 3000 + index,
          reach: 2000 + index,
        },
      },
    }));
    const { engine, snapshotModel, recentQuery, oldestQuery } = makeEngine(
      history,
      new Date('2026-08-18T12:00:00.000Z'),
    );

    const data = await engine.run(depsAt('2026-08-23T12:00:00.000Z'));

    expect(data.historyDepthDays).toBe(5);
    expect(data.observationCount).toBe(1);
    expect(data.windowElapsedDays).toBe(0);
    expect(data.recentCoverageDays).toBe(1);
    expect(data.recentCoverageRatio).toBe(1);
    expect(data.maxGapDays).toBe(0);
    expect(data.trendReady).toBe(false);
    expect(data.perMetric.spend.windowSize).toBe(1);
    expect(recentQuery.limit).toHaveBeenCalledWith(2880);
    expect(recentQuery.select).toHaveBeenCalledWith({
      snapshotId: 1,
      collectedAt: 1,
      'metrics.campaignLevel': 1,
    });
    expect(
      (snapshotModel.find as unknown as jest.Mock).mock.calls[0][0],
    ).toEqual({
      tenantId: '91astrology',
      campaignId: 'campaign-1',
      snapshotId: { $ne: 'snapshot-current' },
    });
    expect(oldestQuery.sort).toHaveBeenCalledWith({ collectedAt: 1 });
  });

  it('uses one latest observation per day and unlocks only after real elapsed history', async () => {
    const history = [
      {
        snapshotId: 'same-day-earlier',
        collectedAt: new Date('2026-08-23T09:00:00.000Z'),
        metrics: { campaignLevel: { spend: 190 } },
      },
      {
        snapshotId: 'day-1-latest',
        collectedAt: new Date('2026-08-22T12:00:00.000Z'),
        metrics: { campaignLevel: { spend: 150 } },
      },
      {
        snapshotId: 'day-1-earlier',
        collectedAt: new Date('2026-08-22T06:00:00.000Z'),
        metrics: { campaignLevel: { spend: 140 } },
      },
      {
        snapshotId: 'day-2',
        collectedAt: new Date('2026-08-21T12:00:00.000Z'),
        metrics: { campaignLevel: { spend: 100 } },
      },
    ];
    const { engine } = makeEngine(
      history,
      new Date('2026-08-21T12:00:00.000Z'),
    );

    const data = await engine.run(depsAt('2026-08-23T12:00:00.000Z'));

    expect(data.observationCount).toBe(3);
    expect(data.windowElapsedDays).toBe(2);
    expect(data.recentCoverageDays).toBe(3);
    expect(data.recentCoverageRatio).toBe(1);
    expect(data.maxGapDays).toBe(1);
    expect(data.trendReady).toBe(true);
    expect(data.perMetric.spend.windowSize).toBe(3);
    expect(data.perMetric.spend.slope3d).toBe(50);
  });

  it('withholds a trend when three observations are separated by a long gap', async () => {
    const history = [
      {
        snapshotId: 'yesterday',
        collectedAt: new Date('2026-08-22T12:00:00.000Z'),
        metrics: { campaignLevel: { spend: 150 } },
      },
      {
        snapshotId: 'forty-days-ago',
        collectedAt: new Date('2026-07-14T12:00:00.000Z'),
        metrics: { campaignLevel: { spend: 100 } },
      },
    ];
    const { engine } = makeEngine(
      history,
      new Date('2026-07-14T12:00:00.000Z'),
    );

    const data = await engine.run(depsAt('2026-08-23T12:00:00.000Z'));

    expect(data.observationCount).toBe(3);
    expect(data.windowElapsedDays).toBe(40);
    expect(data.recentCoverageDays).toBe(2);
    expect(data.recentCoverageRatio).toBe(1);
    expect(data.maxGapDays).toBe(39);
    expect(data.trendReady).toBe(false);
  });
});
