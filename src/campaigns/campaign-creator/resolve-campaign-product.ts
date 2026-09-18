import { CompanyDocument } from '../../companies/schemas/company.schema';
import { Product } from '../../companies/schemas/company.types';

/**
 * Which product is a campaign actually selling?
 *
 * Everything a campaign sends to Meta that is product-specific — the ad's
 * destination URL, the pixel, the custom conversion / custom event it
 * optimizes toward, the conversion value ROAS is judged against — is read off
 * ONE `Product` on the company. Get that product wrong and the ads run, report
 * "Active", spend real money, and point at a different product's funnel.
 *
 * That is exactly what happened in production on 2026-07-27. A manual campaign
 * was created for "wish letter", but `ManualCampaignService.create()` used the
 * operator's product selection only to copy `conversionEvent`/`conversionValue`
 * into campaignConfig and never persisted WHICH product it was — the Campaign
 * document had no product field at all. Because that product tracks conversions
 * via a Custom Conversion, its `conversionEvent` is blank, so the
 * `product?.conversionEvent || 'Purchase'` fallback wrote 'Purchase'. At
 * /approve — a separate request, with the operator's choice long gone —
 * `launch()` re-derived the product with:
 *
 *     products.find(p => p.conversionEvent === config.conversionEvent)
 *       ?? products[0]
 *
 * 'Purchase' matched the FIRST product in the array (a different one), so every
 * ad shipped with that product's landing URL, pixel and custom conversion. No
 * error was raised anywhere: from the code's point of view it had "found a
 * product".
 *
 * This module is the single answer to that question, and it is deliberately
 * unwilling to guess. It resolves in strict priority order:
 *
 *   1. `campaign.productName` — recorded at create time from the operator's
 *      (or the brief's) explicit choice. Authoritative.
 *   2. `brief.product` — for agent campaigns created before productName
 *      existed, and as a cross-check.
 *   3. The tenant's single active product — only when there is exactly one, so
 *      there is nothing to get wrong.
 *
 * Anything else throws. A launch that stops with "which product is this for?"
 * costs one operator minute; a launch that guesses costs the whole budget
 * pointed at the wrong funnel.
 */

export type ProductResolutionSource =
  /** campaign.productName — explicit, recorded when the campaign was created */
  | 'campaign'
  /** creativeBrief.product — agent campaigns, and pre-productName campaigns */
  | 'brief'
  /** tenant has exactly one active product, so there is no ambiguity */
  | 'sole_active';

export interface ProductResolution {
  product: Product;
  source: ProductResolutionSource;
  /**
   * Set when the requested name only matched after normalizing case and
   * separators — e.g. a form that sent "wishletter" for a product actually
   * named "wish letter". The match is accepted (it is unambiguous) but callers
   * should surface it so the mismatch gets cleaned up rather than relied on.
   */
  matchedLoosely?: { requested: string; matched: string };
}

/**
 * Thrown when the product cannot be determined with certainty. Callers on a
 * write path (launch, ad creation) must let this abort the operation — never
 * catch it and continue with a default product.
 */
export class ProductResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductResolutionError';
  }
}

/** "Wish Letter" / "wish-letter" / "wishletter" all collapse to "wishletter". */
const normalizeName = (name: string): string =>
  (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Products default to active; only an explicit `false` deactivates one. */
const isActive = (p: Product): boolean => p.active !== false;

const listNames = (products: Product[]): string =>
  products.length
    ? products.map((p) => `"${p.name}"`).join(', ')
    : '(none configured)';

/**
 * Exact name match, falling back to a normalized match when — and only when —
 * exactly one product normalizes to the requested name. Ambiguity throws.
 */
export function findProductByName(
  products: Product[],
  requested: string,
): { product: Product; loose: boolean } {
  const exact = products.filter((p) => p.name === requested);
  if (exact.length === 1) return { product: exact[0], loose: false };
  if (exact.length > 1) {
    throw new ProductResolutionError(
      `The tenant has ${exact.length} products named "${requested}" — product names must be unique. Rename one before launching.`,
    );
  }

  const key = normalizeName(requested);
  const loose = key
    ? products.filter((p) => normalizeName(p.name) === key)
    : [];
  if (loose.length === 1) return { product: loose[0], loose: true };
  if (loose.length > 1) {
    throw new ProductResolutionError(
      `"${requested}" matches ${loose.length} products (${listNames(loose)}) once case and spacing are ignored — cannot tell which one is meant.`,
    );
  }

  throw new ProductResolutionError(
    `Product "${requested}" does not exist for this tenant. Available products: ${listNames(products)}.`,
  );
}

/**
 * Resolve the product a campaign is for, or throw. See the module header for
 * why this refuses to fall back to "the first (active) product".
 */
export function resolveCampaignProduct(
  company: CompanyDocument,
  campaign: { productName?: string; name?: string } | null | undefined,
  brief?: { product?: string } | null,
): ProductResolution {
  const products = ((company as any).products ?? []) as Product[];
  const label = campaign?.name
    ? `Campaign "${campaign.name}"`
    : 'This campaign';

  const requested = (campaign?.productName ?? '').trim();
  if (requested) {
    const { product, loose } = findProductByName(products, requested);
    return {
      product,
      source: 'campaign',
      ...(loose
        ? { matchedLoosely: { requested, matched: product.name } }
        : {}),
    };
  }

  const briefProduct = (brief?.product ?? '').trim();
  if (briefProduct) {
    const { product, loose } = findProductByName(products, briefProduct);
    return {
      product,
      source: 'brief',
      ...(loose
        ? { matchedLoosely: { requested: briefProduct, matched: product.name } }
        : {}),
    };
  }

  // No recorded product. Only safe when there is literally one choice.
  const active = products.filter(isActive);
  if (active.length === 1) return { product: active[0], source: 'sole_active' };

  if (products.length === 0) {
    throw new ProductResolutionError(
      `${label} cannot be launched: the tenant has no products configured. Add the product (with its landing URL, pixel and conversion settings) first.`,
    );
  }
  throw new ProductResolutionError(
    `${label} has no product recorded, and the tenant has ${active.length} active products (${listNames(active)}). Refusing to guess — set the campaign's productName (PATCH /campaigns/:tenantId/:campaignId/config with { "productName": "..." }) and try again.`,
  );
}

/**
 * Non-throwing variant for read-only/background paths (metrics, reporting)
 * where a wrong product distorts numbers but aborting the whole loop is worse.
 * Callers MUST log the miss — silently reading `null` is how this class of bug
 * stays invisible. Never use this on a path that writes to Meta.
 */
export function tryResolveCampaignProduct(
  company: CompanyDocument,
  campaign: { productName?: string; name?: string } | null | undefined,
  brief?: { product?: string } | null,
): { resolution: ProductResolution | null; error?: string } {
  try {
    return { resolution: resolveCampaignProduct(company, campaign, brief) };
  } catch (err: any) {
    return { resolution: null, error: err?.message ?? String(err) };
  }
}

/**
 * Everything a product needs before its ads can go live. Checked up front so a
 * missing landing URL fails the launch instead of shipping ads whose link
 * field is an empty string.
 */
export function assertProductLaunchable(
  product: Product,
  context = 'launch',
): void {
  const url = (product.landingUrl ?? '').trim();
  if (!url) {
    throw new ProductResolutionError(
      `Product "${product.name}" has no landingUrl — cannot ${context} ads with no destination. Set the product's Landing URL first.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProductResolutionError(
      `Product "${product.name}" has an unparseable landingUrl ("${url}") — Meta will reject the ad. Fix it before launching.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProductResolutionError(
      `Product "${product.name}" landingUrl must be http(s) — got "${parsed.protocol}//" in "${url}".`,
    );
  }
}
