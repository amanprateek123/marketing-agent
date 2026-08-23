import { BaseEngine } from '../../../src/intelligence/shared/base-engine';
import {
  EngineContext,
  Evidence,
} from '../../../src/intelligence/shared/engine-context';
import { EngineEventBus } from '../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../src/intelligence/shared/engine-registry';
import { IdentityResolutionError } from '../../../src/intelligence/shared/engine.errors';
import {
  SliceIdentity,
  SliceRepository,
} from '../../../src/intelligence/shared/slice-repository.service';
import {
  DecisionContext,
  LearningData,
} from '../../../src/intelligence/orchestrator/decision-context';

class IdentityTestEngine extends BaseEngine<'learning', LearningData> {
  readonly name = 'learning' as const;
  readonly step = 16;
  readonly version = 'test';
  readonly dependsOn = ['execution'] as const;

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    private readonly eventIdentity: SliceIdentity,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  protected async identityFromDeps(): Promise<SliceIdentity> {
    return this.eventIdentity;
  }

  protected async compute(): Promise<LearningData> {
    return { measurements: [], calibrations: [], updates: [] };
  }

  protected computeConfidence(): number {
    return 0.5;
  }

  protected buildEvidence(): Evidence[] {
    return [];
  }
}

const executionSlice: EngineContext<
  NonNullable<DecisionContext['execution']>['data']
> = {
  data: { applied: [], deferred: [], failed: [] },
  confidence: 0.8,
  evidence: [],
  version: 'execution@test',
  computedAt: new Date(),
  ms: 1,
  deterministic: true,
};

function setup(options: {
  eventIdentity?: SliceIdentity;
  dependencyIdentity?: SliceIdentity | null;
  cycleIdentity?: SliceIdentity | null;
}) {
  const repo = {
    loadManyWithIdentity: jest.fn().mockResolvedValue({
      slices: { execution: executionSlice },
      identity: options.dependencyIdentity ?? null,
    }),
    identityForCycle: jest
      .fn()
      .mockResolvedValue(options.cycleIdentity ?? null),
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SliceRepository>;
  const eventBus = {
    emitCompleted: jest.fn(),
    emitFailed: jest.fn(),
    emitSkipped: jest.fn(),
  } as unknown as jest.Mocked<EngineEventBus>;
  const registry = { register: jest.fn() } as unknown as EngineRegistry;
  const engine = new IdentityTestEngine(
    repo,
    eventBus,
    registry,
    options.eventIdentity ?? { tenantId: '', campaignId: '' },
  );

  return { engine, repo, eventBus };
}

describe('BaseEngine persisted identity integrity', () => {
  const persisted = { tenantId: 'tenant-1', campaignId: 'campaign-1' };

  it('uses dependency identity when the event identity map is empty', async () => {
    const { engine, repo, eventBus } = setup({
      dependencyIdentity: persisted,
    });

    await engine.execute('cycle-1');

    expect(repo.write).toHaveBeenCalledWith(
      { cycleId: 'cycle-1', ...persisted },
      'learning',
      expect.any(Object),
    );
    expect(eventBus.emitCompleted).toHaveBeenCalledWith(
      expect.objectContaining(persisted),
    );
    expect(repo.identityForCycle).not.toHaveBeenCalled();
  });

  it('recovers from a dependency with a legacy empty identity', async () => {
    const { engine, repo } = setup({ cycleIdentity: persisted });

    await engine.execute('cycle-1');

    expect(repo.identityForCycle).toHaveBeenCalledWith('cycle-1');
    expect(repo.write).toHaveBeenCalledWith(
      { cycleId: 'cycle-1', ...persisted },
      'learning',
      expect.any(Object),
    );
  });

  it('ignores a mismatched event identity in favor of persisted dependencies', async () => {
    const { engine, repo } = setup({
      eventIdentity: { tenantId: 'wrong-tenant', campaignId: 'wrong-campaign' },
      dependencyIdentity: persisted,
    });

    await engine.execute('cycle-1');

    expect(repo.write).toHaveBeenCalledWith(
      { cycleId: 'cycle-1', ...persisted },
      'learning',
      expect.any(Object),
    );
  });

  it('fails closed when neither dependencies nor the cycle can prove identity', async () => {
    const { engine, repo, eventBus } = setup({});

    await expect(engine.execute('cycle-1')).rejects.toBeInstanceOf(
      IdentityResolutionError,
    );
    expect(repo.write).not.toHaveBeenCalled();
    expect(eventBus.emitCompleted).not.toHaveBeenCalled();
  });
});

describe('SliceRepository identity write guard', () => {
  it('rejects an empty identity before issuing a database write', async () => {
    const model = { updateOne: jest.fn() };
    const repo = new SliceRepository(model as never);

    await expect(
      repo.write(
        { cycleId: 'cycle-1', tenantId: '', campaignId: '' },
        'learning',
        {
          data: { measurements: [], calibrations: [], updates: [] },
          confidence: 0.5,
          evidence: [],
          version: 'learning@test',
          computedAt: new Date(),
          ms: 1,
          deterministic: true,
        },
      ),
    ).rejects.toThrow(/complete cycle identity/);
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('returns the consistent persisted identity with dependency slices', async () => {
    const exec = jest.fn().mockResolvedValue([
      {
        engine: 'execution',
        tenantId: 'tenant-1',
        campaignId: 'campaign-1',
        slice: executionSlice,
      },
    ]);
    const model = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec }),
      }),
    };
    const repo = new SliceRepository(model as never);

    const loaded = await repo.loadManyWithIdentity('cycle-1', ['execution']);

    expect(loaded.identity).toEqual({
      tenantId: 'tenant-1',
      campaignId: 'campaign-1',
    });
    expect(loaded.slices.execution).toBe(executionSlice);
  });

  it('fails closed when dependency slices disagree on cycle identity', async () => {
    const exec = jest.fn().mockResolvedValue([
      {
        engine: 'recommendation',
        tenantId: 'tenant-1',
        campaignId: 'campaign-1',
        slice: {},
      },
      {
        engine: 'confidence',
        tenantId: 'tenant-2',
        campaignId: 'campaign-2',
        slice: {},
      },
    ]);
    const model = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec }),
      }),
    };
    const repo = new SliceRepository(model as never);

    await expect(
      repo.loadManyWithIdentity('cycle-1', ['recommendation', 'confidence']),
    ).rejects.toThrow(/Conflicting persisted identities/);
  });
});
