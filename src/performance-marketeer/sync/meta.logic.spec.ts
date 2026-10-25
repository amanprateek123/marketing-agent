import { usageFrom } from '../clients/pm-meta.client';
import {
  breakdownKey,
  dateChunks,
  landingUrlOf,
  adProduct,
  majorityProduct,
  metricsOf,
  productFromName,
  productFromUrl,
  rupees,
  targetingSummary,
} from './meta.logic';

describe('meta.logic', () => {
  it('picks one purchase name, never sums omni + pixel', () => {
    const { metrics } = metricsOf({
      spend: '1715.67',
      impressions: '7567',
      inline_link_clicks: '38',
      actions: [
        { action_type: 'omni_purchase', value: '3' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
        { action_type: 'landing_page_view', value: '30' },
        { action_type: 'omni_landing_page_view', value: '31' },
      ],
      action_values: [
        { action_type: 'omni_purchase', value: '3900' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3900' },
      ],
    });
    expect(metrics).toMatchObject({
      spend: 1715.67,
      impressions: 7567,
      linkClicks: 38,
      metaPurchases: 3,
      metaPurchaseValue: 3900,
      landingPageViews: 30,
    });
    expect(metricsOf({}).metrics.metaPurchases).toBe(0);
  });

  it('landing URL from each creative shape, then product', () => {
    expect(
      landingUrlOf({
        object_story_spec: {
          link_data: {
            link: 'https://www.91astrology.com/nadi-report-premium?x=1',
          },
        },
      }),
    ).toContain('premium');
    expect(
      landingUrlOf({
        asset_feed_spec: {
          link_urls: [
            { website_url: 'https://www.91astrology.com/hi/nadi-report' },
          ],
        },
      }),
    ).toContain('/hi/nadi-report');
    expect(
      landingUrlOf({
        object_story_spec: {
          video_data: {
            call_to_action: {
              value: { link: 'https://x.com/golu-devta-arzi' },
            },
          },
        },
      }),
    ).toContain('golu');
    expect(landingUrlOf(null)).toBe('');
    expect(
      productFromUrl(
        'https://www.91astrology.com/nadi-report-premium?utm_source=fb',
      ),
    ).toBe('nadi-report-premium');
    expect(productFromUrl('https://www.91astrology.com/hi/nadi-report')).toBe(
      'nadi-report',
    );
    expect(productFromUrl('https://www.91astrology.com/nadi-report/cart')).toBe(
      'nadi-report',
    );
    expect(productFromUrl('https://www.91astrology.com/golu-devta-arzi')).toBe(
      'golu-devta-arzi',
    );
    expect(
      productFromUrl('http://play.google.com/store/apps/details?id=x'),
    ).toBeNull();
    expect(productFromUrl('not a url')).toBeNull();
  });

  it('name fallback only when unambiguous', () => {
    expect(productFromName('Agent_wish_letter_2026-08-07 tat')).toBe(
      'golu-devta-arzi',
    );
    expect(productFromName('Nadi Report Premium ABO Oct26')).toBe(
      'nadi-report-premium',
    );
    expect(productFromName('Nadi-Report-Oct26-Region-Wise')).toBeNull(); // could be either Nadi product
  });

  it('majority product by spend', () => {
    expect(
      majorityProduct([
        { product: 'a', spend: 10 },
        { product: 'b', spend: 5 },
        { product: 'other', spend: 1 },
      ]),
    ).toBe('a');
    expect(
      majorityProduct([
        { product: 'a', spend: 5 },
        { product: 'b', spend: 5 },
      ]),
    ).toBe('other');
    expect(majorityProduct([])).toBe('other');
  });

  it('budgets, breakdown keys, chunks', () => {
    expect(rupees('150000')).toBe(1500);
    expect(rupees(undefined)).toBeNull();
    expect(
      breakdownKey({ gender: 'female', age: '25-34' }, ['gender', 'age']),
    ).toBe('female|25-34');
    expect(dateChunks('2026-10-01', '2026-10-10', 4)).toEqual([
      { since: '2026-10-07', until: '2026-10-10' },
      { since: '2026-10-03', until: '2026-10-06' },
      { since: '2026-10-01', until: '2026-10-02' },
    ]);
  });

  it('targeting summary and audience type', () => {
    expect(
      targetingSummary({ age_min: 25, geo_locations: { countries: ['IN'] } }),
    ).toMatchObject({
      ageMin: 25,
      countries: ['IN'],
      audienceType: 'broad',
      advantageAudience: false,
    });
    expect(
      targetingSummary({
        custom_audiences: [{ id: '1', name: 'Website visitors 30d' }],
      })?.audienceType,
    ).toBe('retargeting');
    expect(
      targetingSummary({
        custom_audiences: [{ id: '1', name: 'Lookalike (IN, 1%) - buyers' }],
      })?.audienceType,
    ).toBe('lookalike');
    expect(
      targetingSummary({
        flexible_spec: [{ interests: [{ id: '1', name: 'Astrology' }] }],
      })?.audienceType,
    ).toBe('interest');
    expect(targetingSummary(null)).toBeNull();
  });

  it('reads usage headers', () => {
    const h = {
      'x-business-use-case-usage': JSON.stringify({
        '1': [
          {
            call_count: 80,
            total_cputime: 10,
            total_time: 5,
            estimated_time_to_regain_access: 0,
          },
        ],
      }),
    };
    expect(usageFrom(h)).toEqual({ maxPct: 80, waitMs: 0 });
    expect(
      usageFrom({
        'x-app-usage': JSON.stringify({
          call_count: 5,
          estimated_time_to_regain_access: 2,
        }),
      }),
    ).toEqual({ maxPct: 5, waitMs: 120_000 });
    expect(usageFrom({})).toEqual({ maxPct: 0, waitMs: 0 });
  });

  it('ad product: a readable URL decides; fallbacks only without one', () => {
    const heal = 'https://www.91astrology.com/heal/offering/07dce654';
    expect(adProduct(heal, 'golu-devta-arzi', 'Pitru Puja')).toEqual({
      product: 'other',
      source: 'url',
    });
    expect(
      adProduct(
        'https://www.91astrology.com/hi/nadi-report-premium?x=1',
        undefined,
        '',
      ),
    ).toEqual({ product: 'nadi-report-premium', source: 'url' });
    expect(adProduct('', 'nadi-report', 'x')).toEqual({
      product: 'nadi-report',
      source: 'traffic',
    });
    expect(adProduct('', undefined, 'Agent_wish_letter')).toEqual({
      product: 'golu-devta-arzi',
      source: 'name',
    });
    expect(adProduct('', undefined, 'App Chat')).toEqual({
      product: 'other',
      source: 'none',
    });
  });

  it('parent tag: other competes', () => {
    expect(
      majorityProduct([
        { product: 'other', spend: 90 },
        { product: 'nadi-report-premium', spend: 10 },
      ]),
    ).toBe('other');
  });
});
