/**
 * Append UTM params to a landing URL so downstream analytics (GA, Shopify,
 * custom) can attribute conversions back to the campaign / ad set / ad that
 * drove them. Meta's pixel covers Meta-side attribution; UTMs cover everywhere
 * else.
 *
 * Convention:
 *   utm_source   = "facebook"
 *   utm_medium   = "paid_social"
 *   utm_campaign = slug(campaignName)
 *   utm_term     = slug(adSetName)   — encodes audience segment
 *   utm_content  = slug(adName)      — encodes hookStyle + variantIndex
 *
 * Preserves existing query params + fragment. Returns the URL unchanged if it
 * is empty or unparseable — never block a launch on a UTM tagging bug.
 */
export function withUtmParams(
  landingUrl: string,
  ctx: { campaignName: string; adSetName: string; adName: string },
): string {
  if (!landingUrl) return landingUrl;
  try {
    const url = new URL(landingUrl);
    url.searchParams.set('utm_source', 'facebook');
    url.searchParams.set('utm_medium', 'paid_social');
    url.searchParams.set('utm_campaign', utmSlug(ctx.campaignName));
    url.searchParams.set('utm_term', utmSlug(ctx.adSetName));
    url.searchParams.set('utm_content', utmSlug(ctx.adName));
    return url.toString();
  } catch {
    return landingUrl;
  }
}

/**
 * Resolve the actual URL an ad's creative should link to. Website products
 * get UTM-tagged landingUrl as usual — but app products (applicationId set)
 * MUST link to the exact, untagged store URL: Meta rejects the ad outright
 * (subcode 1885031 "Object store URL does not match promoted object", hit in
 * production 2026-08-11) unless the creative's link is byte-for-byte
 * identical to the ad set's object_store_url — no query string, no tracking
 * tags. This means our own click-tracking redirect (the /dl/:token deep-link
 * system) can't be used as an app ad's link either; Meta's own App-Events
 * attribution (via applicationId) is the only mechanism available here.
 */
export function resolveAdLandingUrl(
  landingUrl: string,
  applicationId: string | undefined,
  ctx: { campaignName: string; adSetName: string; adName: string },
): string {
  return applicationId ? landingUrl : withUtmParams(landingUrl, ctx);
}

function utmSlug(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untagged';
}
