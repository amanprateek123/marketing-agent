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

function utmSlug(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untagged';
}
