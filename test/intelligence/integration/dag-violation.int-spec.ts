import { Test } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { IntelligenceSharedModule } from '../../../src/intelligence/shared/intelligence-shared.module';
import { BackwardsDependencyEngine } from '../fixtures/fake-engines';
import { DagValidationError } from '../../../src/intelligence/shared/engine.errors';

/**
 * The registry must refuse to boot a module whose engines declare a
 * backwards dependency. This is the CI guard that prevents
 * accidental step-ordering bugs in a real engine PR.
 */
describe('DAG violation caught at module init', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
  });

  afterAll(async () => {
    await mongo.stop();
  });

  it('throws DagValidationError when an engine depends on a higher-step slice', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        IntelligenceSharedModule,
      ],
      providers: [BackwardsDependencyEngine],
    }).compile();
    // Nest's Testing module fires both onModuleInit and
    // onApplicationBootstrap during init(). The registry's DAG
    // validator runs in onApplicationBootstrap and throws.
    let caught: unknown;
    try {
      await moduleRef.init();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DagValidationError);
    expect((caught as Error).message).toMatch(/cannot depend on signal/);
    await moduleRef.close().catch(() => undefined);
  });
});
