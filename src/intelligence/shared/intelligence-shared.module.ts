import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CampaignIntelligenceCycle,
  CampaignIntelligenceCycleSchema,
} from '../orchestrator/cycle.schema';
import {
  EngineOutputDoc,
  EngineOutputSchema,
} from '../orchestrator/engine-output.schema';
import { IntelligenceOrchestrator } from '../orchestrator/intelligence-orchestrator.service';
import { EngineEventBus } from './engine-event-bus.service';
import { EngineRegistry } from './engine-registry';
import { SliceRepository } from './slice-repository.service';

/**
 * Shared primitives every engine module needs. Marked @Global() so
 * SnapshotModule / ObjectiveModule / etc. don't need to import it
 * explicitly — the providers are visible everywhere in the app.
 *
 * EventEmitterModule.forRoot() lives here to guarantee a single event
 * bus across the app.
 */
@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      verboseMemoryLeak: false,
    }),
    MongooseModule.forFeature([
      { name: CampaignIntelligenceCycle.name, schema: CampaignIntelligenceCycleSchema },
      { name: EngineOutputDoc.name, schema: EngineOutputSchema },
    ]),
  ],
  providers: [SliceRepository, EngineEventBus, EngineRegistry, IntelligenceOrchestrator],
  exports: [
    SliceRepository,
    EngineEventBus,
    EngineRegistry,
    IntelligenceOrchestrator,
    MongooseModule,
  ],
})
export class IntelligenceSharedModule {}
