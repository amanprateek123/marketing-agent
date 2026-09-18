import { createHash } from 'crypto';
import type {
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from '../schemas/campaign.schema';

export const PRODUCT_SCOPED_REVENUE_VERSION = 'product_scoped_v1';

export type ProductResolutionEvidence =
  | 'persisted_campaign_product_exact'
  | 'inferred_fallback'
  | 'missing_persisted_campaign_product'
  | 'unmatched_persisted_campaign_product'
  | 'ambiguous_configured_product_name';

export interface PersistedProductResolution {
  campaignProductName: string;
  resolvedProductName: string;
  evidence: ProductResolutionEvidence;
  product: any | null;
}

export function normalizeProductIdentity(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Founder evidence accepts only the product identity explicitly persisted on
 * the Campaign and an exact configured-product name match. Campaign-name
 * heuristics, brief fallbacks and a sole-active-product fallback are
 * intentionally unavailable here.
 */
export function resolvePersistedCampaignProduct(
  campaignProductName: unknown,
  products: any[] | undefined,
): PersistedProductResolution {
  const rawName = String(campaignProductName ?? '').trim();
  const normalizedName = normalizeProductIdentity(rawName);
  if (!normalizedName) {
    return {
      campaignProductName: '',
      resolvedProductName: '',
      evidence: 'missing_persisted_campaign_product',
      product: null,
    };
  }

  const matches = (products ?? []).filter(
    (product) => normalizeProductIdentity(product?.name) === normalizedName,
  );
  if (matches.length > 1) {
    return {
      campaignProductName: rawName,
      resolvedProductName: '',
      evidence: 'ambiguous_configured_product_name',
      product: null,
    };
  }
  if (matches.length === 0) {
    return {
      campaignProductName: rawName,
      resolvedProductName: '',
      evidence: 'unmatched_persisted_campaign_product',
      product: null,
    };
  }
  return {
    campaignProductName: rawName,
    resolvedProductName: String(matches[0]?.name ?? '').trim(),
    evidence: 'persisted_campaign_product_exact',
    product: matches[0],
  };
}

export function buildRevenueConfigFingerprint(input: {
  product: any;
  conversionTypes: ReadonlySet<string>;
  effectiveConversionValue: number;
  refundFactor: number;
  useAppEvents: boolean;
}): string {
  // Snapshot identity only: this proves which non-secret configuration was
  // used when the row was synced. It is not a comparison with today's config.
  const canonical = {
    productName: normalizeProductIdentity(input.product?.name),
    customConversionId: String(input.product?.customConversionId ?? '').trim(),
    customEventName: String(input.product?.customEventName ?? '').trim(),
    conversionEvent: String(input.product?.conversionEvent ?? '').trim(),
    metaAppId: String(input.product?.metaAppId ?? '').trim(),
    conversionTypes: [...input.conversionTypes].sort(),
    effectiveConversionValue: input.effectiveConversionValue,
    refundFactor: input.refundFactor,
    useAppEvents: input.useAppEvents,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function isTrustedProductScopedTimeseriesRevenue(
  row: {
    revenue?: unknown;
    revenueBasis?: CampaignRevenueBasis | string;
    revenueAttributionSource?: CampaignRevenueAttributionSource | string;
    revenueAttributionActionTypes?: unknown;
    revenueCalculationVersion?: unknown;
    revenueFetchCompleteness?: unknown;
    campaignProductName?: unknown;
    resolvedProductName?: unknown;
    productResolutionEvidence?: unknown;
    revenueConfigFingerprint?: unknown;
  },
  expectedCampaignProductName: unknown,
): boolean {
  const expected = normalizeProductIdentity(expectedCampaignProductName);
  const rawRevenue = Number(row.revenue);
  const actionTypes = Array.isArray(row.revenueAttributionActionTypes)
    ? row.revenueAttributionActionTypes.filter(Boolean)
    : [];
  const trustedSources = new Set([
    'custom_conversion',
    'custom_event',
    'standard_event',
    'app_event',
  ]);
  const trustedBases = new Set([
    'meta_action_value',
    'configured_conversion_value',
    'no_attributed_revenue',
  ]);

  return (
    Boolean(expected) &&
    row.revenueCalculationVersion === PRODUCT_SCOPED_REVENUE_VERSION &&
    row.revenueFetchCompleteness === 'complete' &&
    row.productResolutionEvidence === 'persisted_campaign_product_exact' &&
    normalizeProductIdentity(row.campaignProductName) === expected &&
    normalizeProductIdentity(row.resolvedProductName) === expected &&
    /^[a-f0-9]{64}$/.test(String(row.revenueConfigFingerprint ?? '')) &&
    trustedBases.has(String(row.revenueBasis ?? '')) &&
    trustedSources.has(String(row.revenueAttributionSource ?? '')) &&
    actionTypes.length > 0 &&
    Number.isFinite(rawRevenue) &&
    rawRevenue >= 0 &&
    (row.revenueBasis !== 'no_attributed_revenue' || rawRevenue === 0)
  );
}
