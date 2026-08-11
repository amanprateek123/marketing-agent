import { withUtmParams, resolveAdLandingUrl } from './meta-utm.util';

/**
 * Covers the app-campaign ad-link exception: Meta rejects the ad outright
 * (subcode 1885031 "Object store URL does not match promoted object", hit in
 * production 2026-08-11) unless the ad creative's link is byte-for-byte
 * identical to the ad set's object_store_url. UTM tagging must be skipped
 * entirely for app campaigns, not just have its params stripped later.
 */
describe('resolveAdLandingUrl', () => {
  const ctx = { campaignName: 'Test Campaign', adSetName: 'Ad set 1', adName: 'Ad 1' };

  it('UTM-tags the URL for a website product (no applicationId)', () => {
    const result = resolveAdLandingUrl('https://example.com/product', undefined, ctx);
    const url = new URL(result);
    expect(url.origin + url.pathname).toBe('https://example.com/product');
    expect(url.searchParams.get('utm_source')).toBe('facebook');
    expect(url.searchParams.get('utm_campaign')).toBe('test-campaign');
  });

  it('returns the store URL completely untouched for an app campaign (applicationId set)', () => {
    const storeUrl = 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app';
    const result = resolveAdLandingUrl(storeUrl, '935762695083961', ctx);
    expect(result).toBe(storeUrl);
  });
});

describe('withUtmParams', () => {
  it('appends the standard UTM params, slugified', () => {
    const result = withUtmParams('https://example.com/product', {
      campaignName: 'Nadi Report — Diwali Sale!',
      adSetName: 'Broad IN',
      adName: 'Variant 1',
    });
    const url = new URL(result);
    expect(url.searchParams.get('utm_source')).toBe('facebook');
    expect(url.searchParams.get('utm_medium')).toBe('paid_social');
    expect(url.searchParams.get('utm_campaign')).toBe('nadi-report-diwali-sale');
    expect(url.searchParams.get('utm_term')).toBe('broad-in');
    expect(url.searchParams.get('utm_content')).toBe('variant-1');
  });

  it('returns the URL unchanged if empty or unparseable', () => {
    expect(withUtmParams('', { campaignName: 'x', adSetName: 'y', adName: 'z' })).toBe('');
    expect(withUtmParams('not a url', { campaignName: 'x', adSetName: 'y', adName: 'z' })).toBe(
      'not a url',
    );
  });
});
