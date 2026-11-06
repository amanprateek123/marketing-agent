import { PM_PRODUCTS } from '../pm.config';
import {
  adNameIndex,
  nameTaggedCampaigns,
  resolveAdClick,
  utmSlug,
} from '../pm.logic';
import { toVisitorDay } from './visitor-days.sync';

// Real shapes from Career Report (launched from Meridian with name-based UTMs, Nov 2026).
const ads = [
  {
    entityId: '120249661053120403',
    adsetId: '120249661050940403',
    campaignId: '120249661050380403',
    name: 'ADVANTAGE_PLUS_2026-11-03 — Variant 1 (uploaded)',
  },
  {
    entityId: '120249661104560403',
    adsetId: '120249661050940403',
    campaignId: '120249661050380403',
    name: 'ADVANTAGE_PLUS_2026-11-03 — Variant 4 (uploaded)',
  },
];

describe('name-tagged Meta ad clicks', () => {
  const names = adNameIndex(ads);

  it('slugs names exactly as the old launcher did', () => {
    expect(utmSlug('ADVANTAGE_PLUS_2026-11-03 — Variant 4 (uploaded)')).toBe(
      'advantage-plus-2026-11-03-variant-4-uploaded',
    );
  });

  it('maps a name tag to the ad and ad set ids, leaves id tags alone', () => {
    const named = {
      adId: 'advantage-plus-2026-11-03-variant-4-uploaded',
      adsetId: 'advantage-plus-2026-11-03',
      campaignId: '120249661050380403',
      at: 1,
    };
    expect(resolveAdClick(named, names)).toEqual({
      ...named,
      adId: '120249661104560403',
      adsetId: '120249661050940403',
    });
    const byId = {
      adId: '120249656264410403',
      adsetId: '120249654438890403',
      campaignId: '120248512026000403',
      at: 1,
    };
    expect(resolveAdClick(byId, names)).toBe(byId);
  });

  it('drops unknown or ambiguous names instead of guessing', () => {
    const c = {
      adId: 'no-such-ad',
      adsetId: '',
      campaignId: '120249661050380403',
    };
    expect(resolveAdClick(c, names)).toBeNull();
    const dup = adNameIndex([
      ads[0],
      { ...ads[0], entityId: '999999999999999' },
    ]);
    expect(
      resolveAdClick(
        { ...c, adId: 'advantage-plus-2026-11-03-variant-1-uploaded' },
        dup,
      ),
    ).toBeNull();
  });

  it('only loads ads for campaigns with name tags', () => {
    expect(
      nameTaggedCampaigns([
        { adId: 'some-name', campaignId: '120249661050380403' },
        { adId: '120249656264410403', campaignId: '120248512026000403' },
        { adId: '', campaignId: '' },
      ]),
    ).toEqual(['120249661050380403']);
  });

  it('turns a name-tagged visit into a Meta ad visit', () => {
    const product = PM_PRODUCTS.find((p) => p.id === 'career-report')!;
    const click = [
      'advantage-plus-2026-11-03-variant-4-uploaded',
      'advantage-plus-2026-11-03',
      '120249661050380403',
      1762300000000,
    ];
    const row = {
      deviceId: 'd1',
      firstAt: 1,
      lastAt: 2,
      sessions: 1,
      landingViews: 1,
      cartViews: 0,
      landingPath: '/career-report',
      ref: ['', 'Facebook', 'social'],
      utm: [
        'facebook',
        'paid_social',
        'career-report-3-11-2026-2026-11-03',
        click[0],
        click[1],
        click[2],
      ],
      hasFbclid: 1,
      hasGoogleClickId: 0,
      firstAd: click,
      lastAd: click,
      metaAdCount: 1,
      payments: [],
      purchases: [],
    };
    const v = toVisitorDay(row, product, '2026-11-04', 't', names);
    expect(v.traffic.channel).toBe('meta_ad');
    expect(v.metaAd?.last.adId).toBe('120249661104560403');
    // Without the ad names it stays an unlinked Meta visit, as before.
    const bare = toVisitorDay(row, product, '2026-11-04', 't');
    expect(bare.metaAd).toBeNull();
    expect(bare.traffic.channel).toBe('meta_other');
  });
});
