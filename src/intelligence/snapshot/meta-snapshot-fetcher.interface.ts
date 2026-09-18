import { RawMetaBundle } from './snapshot.types';

/**
 * The Snapshot Engine's only path to Meta. Real production impl calls
 * MetaAdsService + MetaMetricsService (deferred to a follow-up PR that
 * wires the concrete adapter). PR-03 tests supply a stub via DI to
 * exercise the engine end-to-end without hitting real Meta.
 *
 * Injection token: META_SNAPSHOT_FETCHER
 */
export interface MetaSnapshotFetcher {
  fetch(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
  }): Promise<RawMetaBundle>;
}

export const META_SNAPSHOT_FETCHER = 'META_SNAPSHOT_FETCHER';
