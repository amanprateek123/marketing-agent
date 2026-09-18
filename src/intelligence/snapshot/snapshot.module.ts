import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  IntelligenceSnapshot,
  IntelligenceSnapshotSchema,
} from './snapshot.schema';
import { SnapshotBuilder } from './snapshot-builder.service';
import { SnapshotValidator } from './snapshot-validator.service';
import { SnapshotEngine } from './snapshot-engine.service';
import { SnapshotController } from './snapshot.controller';
import {
  META_SNAPSHOT_FETCHER,
  MetaSnapshotFetcher,
} from './meta-snapshot-fetcher.interface';

/**
 * SnapshotModule needs a MetaSnapshotFetcher provided from the outside.
 * A follow-up PR (Meta Adapter) wires the concrete implementation that
 * delegates to MetaAdsService. For tests we register a stub via
 * `forFeature({ fetcher })`.
 *
 * Usage in the top-level IntelligenceModule (once the adapter lands):
 *   SnapshotModule.forFeature({ fetcherClass: MetaAdapterService })
 */
@Module({})
export class SnapshotModule {
  /**
   * Options are optional. When BOTH are omitted, SnapshotModule
   * expects META_SNAPSHOT_FETCHER to be provided by an external
   * @Global module (typically IntelligenceAdaptersModule).
   * Test setups can pass fetcherProvider directly with a stub.
   */
  static forFeature(
    opts: {
      fetcherClass?: Type<MetaSnapshotFetcher>;
      fetcherProvider?: Provider;
    } = {},
  ): DynamicModule {
    const localFetcherProvider: Provider | undefined = opts.fetcherProvider
      ? opts.fetcherProvider
      : opts.fetcherClass
        ? { provide: META_SNAPSHOT_FETCHER, useClass: opts.fetcherClass }
        : undefined;

    return {
      module: SnapshotModule,
      global: true, // makes exported providers visible to sibling engine + scheduler modules
      imports: [
        MongooseModule.forFeature([
          { name: IntelligenceSnapshot.name, schema: IntelligenceSnapshotSchema },
        ]),
      ],
      controllers: [SnapshotController],
      providers: [
        SnapshotBuilder,
        SnapshotValidator,
        SnapshotEngine,
        ...(localFetcherProvider ? [localFetcherProvider] : []),
      ],
      exports: [SnapshotEngine, SnapshotBuilder, SnapshotValidator],
    };
  }
}
