import { Injectable, Logger } from '@nestjs/common';
import { CompaniesService } from '../../companies/companies.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';

/**
 * Standard retargeting cohort stack a tenant should maintain on Meta. Defined
 * once here so every tenant runs against the same playbook and audit/learning
 * can compare apples-to-apples across tenants. Each cohort has:
 *  - name: human-readable, prefixed with tenantId at create time
 *  - kind: which Meta audience flavor (pixel-event / video-view / engagement / lookalike)
 *  - retentionDays: how recent the membership window is
 *  - stage: funnel mapping used by audience-targeting-resolver (cold/warm/hot)
 *
 * Naming convention (tenant_<retention>_<kind>) is parsed downstream — DO NOT
 * change keys without updating audience-targeting-resolver's name-pattern check.
 */
export interface StandardCohort {
  key: string;
  kind: 'pixel_event' | 'page_engagement' | 'ig_engagement' | 'video_view' | 'lookalike';
  retentionDays: number;
  stage: 'cold' | 'warm' | 'hot';
  description: string;
  // For pixel_event: which event triggers membership
  pixelEvent?: string;
  // For lookalike: which source audience (by key in this stack) to seed from
  lookalikeSeed?: string;
  lookalikeRatio?: number;
}

/**
 * The canonical stack. Order matters — lookalikes must come AFTER their source.
 * Conservative defaults; tweak only with clear data — these have been validated
 * across multiple Indian DTC tenants in spirituality/consultation verticals.
 */
export const STANDARD_COHORTS: StandardCohort[] = [
  // Hot — cart/booker pool, highest intent
  { key: 'purchasers_180d', kind: 'pixel_event', retentionDays: 180, stage: 'hot',
    pixelEvent: 'Purchase', description: 'Anyone who fired Purchase event in last 180d — source for buyer lookalikes' },
  { key: 'booking_initiated_7d', kind: 'pixel_event', retentionDays: 7, stage: 'hot',
    pixelEvent: 'InitiateCheckout', description: 'Started booking but did not complete — cart-recovery audience' },

  // Warm — high engagement, not yet bought
  { key: 'page_visitors_30d', kind: 'pixel_event', retentionDays: 30, stage: 'warm',
    pixelEvent: 'PageView', description: 'Visited any page in last 30d — broad warm retargeting' },
  { key: 'video_50pct_30d', kind: 'video_view', retentionDays: 30, stage: 'warm',
    description: 'Watched 50%+ of any video ad in last 30d — content-engaged warm pool' },

  // Cool — broad re-engagement
  { key: 'page_visitors_90d', kind: 'pixel_event', retentionDays: 90, stage: 'warm',
    pixelEvent: 'PageView', description: 'Visited in last 90d — wider warm net' },

  // Cold — lookalike pool seeded from buyers (the right seed, not random page visitors)
  { key: 'lal_1pct_buyers', kind: 'lookalike', retentionDays: 0, stage: 'cold',
    lookalikeSeed: 'purchasers_180d', lookalikeRatio: 0.01,
    description: '1% lookalike of recent buyers — primary cold prospecting audience' },
  { key: 'lal_2pct_buyers', kind: 'lookalike', retentionDays: 0, stage: 'cold',
    lookalikeSeed: 'purchasers_180d', lookalikeRatio: 0.02,
    description: '2% lookalike of recent buyers — broader cold scaling' },
];

export interface CohortStatusEntry {
  key: string;
  metaAudienceId: string | null;
  status: 'created' | 'exists' | 'failed' | 'skipped';
  error?: string;
}

/**
 * Audience orchestration service.
 *
 * Maintains the standard retargeting cohort stack per tenant on Meta. Today's
 * MVP: a setup endpoint that creates the stack on demand. Future scheduled
 * refresh (weekly lookalike rebuild, daily expiry sweep) lands in scheduler.
 *
 * Why this exists: without auto-maintained cohorts, the agent has nothing to
 * point warm/hot ad sets at. Campaign Review keeps falling back to
 * advantage_plus broad targeting because the source audiences don't exist —
 * which means 0 retargeting revenue. This service fixes the supply side.
 *
 * Scope intentionally minimal:
 *  - createStandardStack(tenantId): provisions each cohort that doesn't exist
 *  - listCohorts(tenantId): returns current state with metaAudienceId map
 *  - DOES NOT yet handle: scheduled refresh, expiry sweeping, cross-tenant
 *    audience sharing, custom rules per tenant
 *
 * Persistence: cohort → audienceId map lives on company.products[].metaAudiences
 * (existing field). createStandardStack appends new audiences there so the
 * existing audience-targeting-resolver picks them up without further wiring.
 */
@Injectable()
export class AudienceOrchestrationService {
  private readonly logger = new Logger(AudienceOrchestrationService.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly metaAdsService: MetaAdsService,
  ) {}

  /**
   * Create any missing cohorts from STANDARD_COHORTS for the given tenant.
   *
   * Idempotent: if a cohort with the expected name already exists in
   * product.metaAudiences, it's skipped. Failures are logged per-cohort and
   * don't abort the whole stack.
   *
   * @param tenantId    company tenantId
   * @param productName which product's metaAudiences array to populate; defaults to first active
   * @returns per-cohort status report
   */
  async createStandardStack(
    tenantId: string,
    productName?: string,
  ): Promise<CohortStatusEntry[]> {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken || !company.meta?.accountId || !company.meta?.pixelId) {
      throw new Error(`Tenant ${tenantId} missing Meta credentials (accessToken/accountId/pixelId required)`);
    }

    const targetProduct = productName
      ? (company.products ?? []).find((p) => p.name === productName)
      : (company.products ?? []).find((p) => p.active);
    if (!targetProduct) {
      throw new Error(`No target product found for tenant ${tenantId} (productName=${productName ?? 'first-active'})`);
    }

    const accountIdNormalized = company.meta.accountId.startsWith('act_')
      ? company.meta.accountId
      : `act_${company.meta.accountId}`;
    const existingByName = new Map(
      (targetProduct.metaAudiences ?? []).map((a: any) => [a.name, a.id] as [string, string]),
    );
    const newAudiences: any[] = [];
    const results: CohortStatusEntry[] = [];

    // Build in order so lookalikes can reference already-created sources
    const sourceIdByKey = new Map<string, string>();

    for (const cohort of STANDARD_COHORTS) {
      const audienceName = this.cohortName(tenantId, cohort);

      if (existingByName.has(audienceName)) {
        const id = existingByName.get(audienceName)!;
        sourceIdByKey.set(cohort.key, id);
        results.push({ key: cohort.key, metaAudienceId: id, status: 'exists' });
        continue;
      }

      try {
        let audienceId: string;

        if (cohort.kind === 'pixel_event') {
          if (!cohort.pixelEvent) throw new Error(`pixel_event cohort ${cohort.key} missing pixelEvent`);
          audienceId = await this.metaAdsService.createPixelAudience(
            accountIdNormalized,
            company.meta.accessToken,
            audienceName,
            company.meta.pixelId,
            { event: cohort.pixelEvent, retentionDays: cohort.retentionDays },
          );
        } else if (cohort.kind === 'lookalike') {
          if (!cohort.lookalikeSeed || !cohort.lookalikeRatio) {
            throw new Error(`lookalike cohort ${cohort.key} missing seed or ratio`);
          }
          const sourceId = sourceIdByKey.get(cohort.lookalikeSeed)
            ?? existingByName.get(this.cohortName(tenantId, STANDARD_COHORTS.find((c) => c.key === cohort.lookalikeSeed)!));
          if (!sourceId) {
            results.push({ key: cohort.key, metaAudienceId: null, status: 'skipped',
              error: `lookalike seed "${cohort.lookalikeSeed}" not created yet — needs source audience first` });
            continue;
          }
          audienceId = await this.metaAdsService.createLookalikeAudience(
            accountIdNormalized,
            company.meta.accessToken,
            audienceName,
            sourceId,
            (company.geography === 'India' ? 'IN' : (company.geography ?? 'IN').slice(0, 2).toUpperCase()),
            cohort.lookalikeRatio,
          );
        } else {
          // video_view / page_engagement / ig_engagement — not implemented in this MVP
          // (they require source-content IDs which the system doesn't track yet)
          results.push({ key: cohort.key, metaAudienceId: null, status: 'skipped',
            error: `${cohort.kind} cohort kind not yet implemented in MVP — needs source content IDs` });
          continue;
        }

        sourceIdByKey.set(cohort.key, audienceId);
        newAudiences.push({
          id: audienceId,
          name: audienceName,
          type: cohort.kind === 'lookalike' ? 'lookalike' : 'custom',
          ...(cohort.lookalikeRatio ? { lookalikePercent: Math.round(cohort.lookalikeRatio * 100) } : {}),
        });
        results.push({ key: cohort.key, metaAudienceId: audienceId, status: 'created' });
        this.logger.log(`Cohort ${cohort.key} created for ${tenantId}: ${audienceId}`);
      } catch (err: any) {
        results.push({ key: cohort.key, metaAudienceId: null, status: 'failed', error: err.message });
        this.logger.error(`Cohort ${cohort.key} failed for ${tenantId}: ${err.message}`);
      }
    }

    // Append newly-created audiences to the product's metaAudiences. Existing
    // audience-targeting-resolver picks them up via the same array; no resolver
    // changes needed for MVP. Future enhancement: add a separate
    // `tenantAudienceStack` field on Company for tenant-wide cohorts that span
    // products.
    if (newAudiences.length > 0) {
      const updatedProducts = (company.products ?? []).map((p) =>
        p.name === targetProduct.name
          ? { ...p, metaAudiences: [...(p.metaAudiences ?? []), ...newAudiences] }
          : p,
      );
      await this.companiesService.update(tenantId, { products: updatedProducts as any });
      this.logger.log(`Audience stack: appended ${newAudiences.length} new audiences to ${tenantId}/${targetProduct.name}`);
    }

    return results;
  }

  /**
   * Read-only view of the cohort stack state for a tenant — what's created,
   * what's missing, what failed. Useful for the dashboard and for the audit
   * loop to detect drift (audience expired in Meta but still listed on Product).
   */
  async listCohortStatus(tenantId: string, productName?: string): Promise<CohortStatusEntry[]> {
    const company = await this.companiesService.findByTenantId(tenantId);
    const targetProduct = productName
      ? (company.products ?? []).find((p) => p.name === productName)
      : (company.products ?? []).find((p) => p.active);
    if (!targetProduct) return [];
    const existingByName = new Map(
      (targetProduct.metaAudiences ?? []).map((a: any) => [a.name, a.id] as [string, string]),
    );
    return STANDARD_COHORTS.map((cohort) => {
      const name = this.cohortName(tenantId, cohort);
      const id = existingByName.get(name);
      return {
        key: cohort.key,
        metaAudienceId: id ?? null,
        status: (id ? 'exists' : 'failed') as CohortStatusEntry['status'],
        ...(id ? {} : { error: 'not created yet' }),
      };
    });
  }

  /**
   * Cohort naming convention. Keep stable — name parsing happens in
   * audience-targeting-resolver to map back to stage / kind.
   * Pattern: `<tenantId>_<key>` e.g. `91astrology_lal_1pct_buyers`.
   */
  private cohortName(tenantId: string, cohort: StandardCohort): string {
    return `${tenantId}_${cohort.key}`;
  }
}
