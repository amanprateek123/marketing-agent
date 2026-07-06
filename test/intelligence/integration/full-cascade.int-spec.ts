import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigModule } from '@nestjs/config';
import { IntelligenceSharedModule } from '../../../src/intelligence/shared/intelligence-shared.module';
import { SnapshotModule } from '../../../src/intelligence/snapshot/snapshot.module';
import { ObjectiveModule } from '../../../src/intelligence/objective/objective.module';
import { LifecycleModule } from '../../../src/intelligence/lifecycle/lifecycle.module';
import { TrendModule } from '../../../src/intelligence/trend/trend.module';
import { RevenueModule } from '../../../src/intelligence/revenue/revenue.module';
import { SignalModule } from '../../../src/intelligence/signal/signal.module';
import { DiagnosisModule } from '../../../src/intelligence/diagnosis/diagnosis.module';
import { BusinessModule } from '../../../src/intelligence/business/business.module';
import { PortfolioModule } from '../../../src/intelligence/portfolio/portfolio.module';
import { ForecastModule } from '../../../src/intelligence/forecast/forecast.module';
import { ConfidenceModule } from '../../../src/intelligence/confidence/confidence.module';
import { MemoryModule } from '../../../src/intelligence/memory/memory.module';
import { RecommendationModule } from '../../../src/intelligence/recommendation/recommendation.module';
import { ExplainabilityModule } from '../../../src/intelligence/explainability/explainability.module';
import { ExecutionModule } from '../../../src/intelligence/execution/execution.module';
import { LearningModule } from '../../../src/intelligence/learning/learning.module';
import { IntelligenceOrchestrator } from '../../../src/intelligence/orchestrator/intelligence-orchestrator.service';
import { SnapshotEngine } from '../../../src/intelligence/snapshot/snapshot-engine.service';
import { SliceRepository } from '../../../src/intelligence/shared/slice-repository.service';
import { EngineRegistry } from '../../../src/intelligence/shared/engine-registry';
import { META_SNAPSHOT_FETCHER } from '../../../src/intelligence/snapshot/meta-snapshot-fetcher.interface';
import { RawMetaBundle } from '../../../src/intelligence/snapshot/snapshot.types';

/**
 * Full 16-engine cascade smoke test. Uses an in-memory Meta fetcher
 * stub — everything downstream should cascade off snapshot.completed
 * naturally through the event bus.
 */
describe('Full 16-engine cascade (integration)', () => {
  let mongo: MongoMemoryServer;
  let moduleRef: TestingModule;
  let orchestrator: IntelligenceOrchestrator;
  let sliceRepo: SliceRepository;
  let emitter: EventEmitter2;

  const bundle: RawMetaBundle = {
    campaign: {
      id: 'mc-1',
      effective_status: 'ACTIVE',
      learning_stage: 'ACTIVE',
      account_id: 'act_x',
      insights: {
        spend: '1500',
        impressions: '30000',
        clicks: '600',
        ctr: '2',
        cpc: '2.5',
        frequency: '1.5',
        actions: [{ action_type: 'purchase', value: '20' }],
        action_values: [{ action_type: 'purchase', value: '3000' }],
      },
    },
    adSets: {
      as1: {
        id: 'as1',
        insights: {
          spend: '600',
          impressions: '12000',
          clicks: '240',
          actions: [{ action_type: 'purchase', value: '8' }],
          action_values: [{ action_type: 'purchase', value: '1200' }],
        },
      },
    },
    ads: {},
    metaWindowStart: new Date(Date.now() - 7 * 86400 * 1000),
    metaWindowEnd: new Date(Date.now() - 5 * 60 * 1000),
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const stubFetcher = { fetch: async () => bundle };
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(mongo.getUri()),
        IntelligenceSharedModule,
        SnapshotModule.forFeature({
          fetcherProvider: { provide: META_SNAPSHOT_FETCHER, useValue: stubFetcher },
        }),
        ObjectiveModule,
        LifecycleModule,
        TrendModule,
        RevenueModule,
        SignalModule,
        DiagnosisModule,
        BusinessModule,
        PortfolioModule,
        ForecastModule,
        ConfidenceModule,
        MemoryModule,
        RecommendationModule,
        ExplainabilityModule,
        ExecutionModule,
        LearningModule,
      ],
    }).compile();
    await moduleRef.init();

    orchestrator = moduleRef.get(IntelligenceOrchestrator);
    sliceRepo = moduleRef.get(SliceRepository);
    emitter = moduleRef.get(EventEmitter2);
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('registers all 16 engines in the DAG', () => {
    const registry = moduleRef.get(EngineRegistry);
    const names = registry.all().map((d) => d.name);
    expect(names).toEqual([
      'snapshot',
      'objective',
      'lifecycle',
      'trend',
      'revenue',
      'signal',
      'diagnosis',
      'business',
      'portfolio',
      'forecast',
      'confidence',
      'memory',
      'recommendation',
      'explainability',
      'execution',
      'learning',
    ]);
  });

  it('cascades an opened cycle through all 16 engines', async () => {
    const cycleCompleted = new Promise<{ cycleId: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for cycle.completed')),
        15000,
      );
      emitter.once('intelligence.cycle.completed', (p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });

    const dc = await orchestrator.openCycle({
      tenantId: 'astro',
      campaignId: 'cam-1',
      metaCampaignId: 'mc-1',
    });

    const snapshotEngine = moduleRef.get(SnapshotEngine);
    await snapshotEngine.captureForCycle({
      cycleId: dc.cycleId,
      tenantId: 'astro',
      campaignId: 'cam-1',
      metaCampaignId: 'mc-1',
      products: [{ name: 'Kundli', conversionValue: 999 }],
    });

    const evt = await cycleCompleted;
    expect(evt.cycleId).toBe(dc.cycleId);

    // Every engine should have written a slice
    const engines = [
      'snapshot',
      'objective',
      'lifecycle',
      'trend',
      'revenue',
      'signal',
      'diagnosis',
      'business',
      'portfolio',
      'forecast',
      'confidence',
      'memory',
      'recommendation',
      'explainability',
      'execution',
      'learning',
    ] as const;
    for (const name of engines) {
      const slice = await sliceRepo.load(dc.cycleId, name);
      expect(slice).toBeDefined();
    }
  }, 20000);
});
