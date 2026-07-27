import { CompanyDocument } from '../../companies/schemas/company.schema';
import { buildMetaCampaignName } from './meta-campaign-name.util';
import {
  assertProductLaunchable,
  findProductByName,
  ProductResolutionError,
  resolveCampaignProduct,
  tryResolveCampaignProduct,
} from './resolve-campaign-product';

/**
 * Regression suite for the 2026-07-27 wrong-product launch.
 *
 * A campaign built for "wish letter" launched against a different product's
 * landing page, pixel and custom conversion, because launch() re-derived the
 * product from campaignConfig.conversionEvent and fell back to products[0].
 * The shape below mirrors the tenant it happened on: two active products
 * sharing conversionEvent 'Purchase', one of them tracking via a Custom
 * Conversion (so its conversionEvent field is blank), plus an inactive third.
 */
const company = {
  tenantId: '91astrology',
  products: [
    {
      name: 'Nadi Report',
      active: true,
      conversionEvent: 'Purchase',
      landingUrl: 'https://91astrology.com/nadi-report-premium',
    },
    {
      name: 'Nadi Leaf Reading',
      active: false,
      conversionEvent: 'CustomEvent',
      landingUrl: 'https://www.91astrology.com/premium-consultation/nadi-leaf',
    },
    {
      name: 'wish letter',
      active: true,
      customConversionId: '28675378708729288',
      pixelId: '459303576818354',
      landingUrl: 'https://91astrology.com/golu-devta-arzi',
    },
  ],
} as unknown as CompanyDocument;

const soleProductCompany = {
  tenantId: 'solo',
  products: [{ name: 'Only Thing', active: true, landingUrl: 'https://x.test/p' }],
} as unknown as CompanyDocument;

describe('resolveCampaignProduct', () => {
  it('REGRESSION: refuses to guess when no product is recorded and several are active', () => {
    // The exact production failure. Old behaviour returned products[0]
    // ("Nadi Report") and launched against its funnel; correct behaviour is
    // to stop, because nothing here identifies the product.
    expect(() =>
      resolveCampaignProduct(company, {
        name: 'Agent_wishletter_advantageplus',
      }),
    ).toThrow(ProductResolutionError);

    try {
      resolveCampaignProduct(company, { name: 'Agent_wishletter_advantageplus' });
    } catch (err: any) {
      // The message has to be actionable on its own — it's what surfaces in
      // the API response and on the approve screen.
      expect(err.message).toContain('Agent_wishletter_advantageplus');
      expect(err.message).toContain('2 active products');
      expect(err.message).toContain('"Nadi Report"');
      expect(err.message).toContain('"wish letter"');
      expect(err.message).toContain('productName');
    }
  });

  it('uses the product recorded on the campaign', () => {
    const r = resolveCampaignProduct(company, {
      productName: 'wish letter',
      name: 'C',
    });
    expect(r.product.name).toBe('wish letter');
    expect(r.product.landingUrl).toBe('https://91astrology.com/golu-devta-arzi');
    expect(r.source).toBe('campaign');
    expect(r.matchedLoosely).toBeUndefined();
  });

  it('matches across spacing/case differences, and reports that it did', () => {
    // A form sending "wishletter" for a product named "wish letter" used to
    // fall through to the first active product with no error at all.
    const r = resolveCampaignProduct(company, { productName: 'WishLetter', name: 'C' });
    expect(r.product.name).toBe('wish letter');
    expect(r.matchedLoosely).toEqual({ requested: 'WishLetter', matched: 'wish letter' });
  });

  it('falls back to the brief when the campaign predates productName', () => {
    const r = resolveCampaignProduct(company, { name: 'C' }, { product: 'Nadi Report' });
    expect(r.product.name).toBe('Nadi Report');
    expect(r.source).toBe('brief');
  });

  it('prefers the campaign over the brief when they disagree', () => {
    const r = resolveCampaignProduct(
      company,
      { productName: 'wish letter', name: 'C' },
      { product: 'Nadi Report' },
    );
    expect(r.product.name).toBe('wish letter');
    expect(r.source).toBe('campaign');
  });

  it('resolves an inactive product when it is named explicitly', () => {
    // Inactive means "don't pick it for me", not "this campaign can't exist".
    const r = resolveCampaignProduct(company, { productName: 'Nadi Leaf Reading', name: 'C' });
    expect(r.product.name).toBe('Nadi Leaf Reading');
  });

  it('throws — listing what exists — when the named product is unknown', () => {
    expect(() =>
      resolveCampaignProduct(company, { productName: 'Golu Devta', name: 'C' }),
    ).toThrow(/does not exist.*Nadi Report.*wish letter/s);
  });

  it('uses the sole active product only when there is exactly one', () => {
    const r = resolveCampaignProduct(soleProductCompany, { name: 'C' });
    expect(r.product.name).toBe('Only Thing');
    expect(r.source).toBe('sole_active');
  });

  it('throws when the tenant has no products at all', () => {
    const empty = { tenantId: 't', products: [] } as unknown as CompanyDocument;
    expect(() => resolveCampaignProduct(empty, { name: 'C' })).toThrow(/no products configured/);
  });
});

describe('findProductByName', () => {
  it('refuses duplicate exact names rather than picking one', () => {
    const dupes = [
      { name: 'Same', landingUrl: 'https://a.test' },
      { name: 'Same', landingUrl: 'https://b.test' },
    ] as any[];
    expect(() => findProductByName(dupes, 'Same')).toThrow(/must be unique/);
  });

  it('refuses when several products collapse to the same normalized name', () => {
    const ambiguous = [{ name: 'wish letter' }, { name: 'Wish-Letter' }] as any[];
    expect(() => findProductByName(ambiguous, 'wishletter')).toThrow(/cannot tell which one/);
  });
});

describe('assertProductLaunchable', () => {
  it('accepts a normal https landing page', () => {
    expect(() => assertProductLaunchable(company.products![2] as any)).not.toThrow();
  });

  it('rejects a missing landing URL instead of shipping an empty link', () => {
    expect(() => assertProductLaunchable({ name: 'P', landingUrl: '' } as any)).toThrow(
      /no landingUrl/,
    );
  });

  it('rejects a URL Meta would reject', () => {
    expect(() => assertProductLaunchable({ name: 'P', landingUrl: 'notaurl' } as any)).toThrow(
      /unparseable/,
    );
    expect(() =>
      assertProductLaunchable({ name: 'P', landingUrl: 'ftp://x.test/p' } as any),
    ).toThrow(/must be http/);
  });
});

describe('tryResolveCampaignProduct', () => {
  it('returns the error instead of throwing, for read-only paths', () => {
    const { resolution, error } = tryResolveCampaignProduct(company, { name: 'C' });
    expect(resolution).toBeNull();
    expect(error).toMatch(/Refusing to guess/);
  });

  it('returns the resolution when it succeeds', () => {
    const { resolution, error } = tryResolveCampaignProduct(company, {
      productName: 'Nadi Report',
      name: 'C',
    });
    expect(error).toBeUndefined();
    expect(resolution!.product.name).toBe('Nadi Report');
  });
});

describe('buildMetaCampaignName', () => {
  // Shared by launch() and the approval preview so the operator approves the
  // name Meta actually receives.
  const on = new Date('2026-07-27T06:00:00.000Z');

  it('date-suffixes a human-given name', () => {
    expect(buildMetaCampaignName({ name: 'Agent_wishletter_advantageplus' }, on)).toBe(
      'Agent_wishletter_advantageplus_2026-07-27',
    );
  });

  it('falls back to the topic slug for pipeline campaigns', () => {
    expect(buildMetaCampaignName({ topic: 'golu devta arzi' }, on)).toBe(
      'AGENT_GOLU_DEVTA_ARZI_2026-07-27',
    );
  });

  it('never produces a bare AGENT__<date> when both are missing', () => {
    expect(buildMetaCampaignName({}, on)).toBe('AGENT_CAMPAIGN_2026-07-27');
  });
});
