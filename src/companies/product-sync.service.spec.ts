import { linkProduct, slugify, plannedWrites } from './product-sync.service';
import { ProductSyncService } from './product-sync.service';

const offerings = [
  { slug: 'golu_devta_arzi', display_name: 'Golu Devta Arzi' },
  { slug: 'nadi_report_premium', display_name: 'Nadi Report Premium' },
  { slug: 'nadi_report', display_name: 'Nadi Report' },
  { slug: 'career_report', display_name: 'Career Report' },
];

describe('linkProduct — which Brain product a platform product is', () => {
  it('an explicit offeringSlug wins when it exists on the Brain', () => {
    expect(
      linkProduct(
        { name: 'Anything', offeringSlug: 'career_report' },
        offerings,
      ),
    ).toEqual({ slug: 'career_report', how: 'explicit' });
  });

  it('a stale explicit slug is reported, not trusted', () => {
    const r = linkProduct(
      { name: 'Golu Devta Arzi', offeringSlug: 'gone_slug' },
      offerings,
    );
    expect(r.slug).toBeNull();
    expect(r.reason).toMatch(/gone_slug/);
  });

  it('matches the display name or slug exactly, ignoring case and punctuation', () => {
    expect(linkProduct({ name: 'golu devta arzi' }, offerings)).toEqual({
      slug: 'golu_devta_arzi',
      how: 'name',
    });
    expect(linkProduct({ name: 'Nadi Report' }, offerings)).toEqual({
      slug: 'nadi_report',
      how: 'name',
    });
    expect(linkProduct({ name: 'nadi_report_premium' }, offerings)).toEqual({
      slug: 'nadi_report_premium',
      how: 'name',
    });
  });

  it('never guesses a partial match', () => {
    const r = linkProduct({ name: 'Nadi' }, offerings);
    expect(r.slug).toBeNull();
    expect(r.reason).toMatch(/no Brain product/i);
  });
});

describe('slugify', () => {
  it('turns a product name into a Brain slug', () => {
    expect(slugify('Kundli Match — Premium!')).toBe('kundli_match_premium');
    expect(slugify('  2026 Forecast ')).toBe('2026_forecast');
  });
});

describe('plannedWrites — what to record, and only what changed', () => {
  const company = { meta: { pageId: 'PAGE_DEFAULT', pixelId: 'PIXEL_CO' } };

  it('a product with its own Page records it (and its Instagram) for that product only', () => {
    const w = plannedWrites(
      { name: 'Golu', pageId: 'PAGE_GOLU', customConversionId: 'CC_GOLU' },
      company,
      'golu_devta_arzi',
      { resolved: {} },
      'IG_GOLU',
    );
    expect(w).toEqual(
      expect.arrayContaining([
        {
          key: 'page_id',
          value: 'PAGE_GOLU',
          offering_slug: 'golu_devta_arzi',
        },
        {
          key: 'instagram_actor_id',
          value: 'IG_GOLU',
          offering_slug: 'golu_devta_arzi',
        },
        {
          key: 'custom_conversion_id',
          value: 'CC_GOLU',
          offering_slug: 'golu_devta_arzi',
        },
      ]),
    );
    expect(w.find((x) => x.key === 'pixel_id')).toBeUndefined();
  });

  it('a product with no Page of its own writes no Page row (the company default covers it)', () => {
    const w = plannedWrites(
      { name: 'Nadi' },
      company,
      'nadi_report',
      { resolved: {} },
      null,
    );
    expect(w.find((x) => x.key === 'page_id')).toBeUndefined();
  });

  it('nothing is written when the Brain already holds the same value for this product', () => {
    const current = {
      resolved: {
        page_id: { value: 'PAGE_GOLU', scope: 'offering:golu_devta_arzi' },
        instagram_actor_id: {
          value: 'IG_GOLU',
          scope: 'offering:golu_devta_arzi',
        },
      },
    };
    expect(
      plannedWrites(
        { name: 'Golu', pageId: 'PAGE_GOLU' },
        company,
        'golu_devta_arzi',
        current,
        'IG_GOLU',
      ),
    ).toEqual([]);
  });

  it('the same value inherited from the account still gets its own product row', () => {
    const current = {
      resolved: { page_id: { value: 'PAGE_GOLU', scope: 'account' } },
    };
    const w = plannedWrites(
      { name: 'Golu', pageId: 'PAGE_GOLU' },
      company,
      'golu_devta_arzi',
      current,
      null,
    );
    expect(w).toEqual([
      { key: 'page_id', value: 'PAGE_GOLU', offering_slug: 'golu_devta_arzi' },
    ]);
  });
});

describe('ProductSyncService.syncCompany', () => {
  function make(
    brainTools: Record<string, (args: any) => any>,
    opts: { meta?: any } = {},
  ) {
    const calls: Array<[string, any]> = [];
    const brain = {
      isConfigured: () => true,
      call: jest.fn(async (tool: string, args: any) => {
        calls.push([tool, args]);
        const fn = brainTools[tool];
        if (!fn) throw new Error(`unexpected tool ${tool}`);
        return fn(args);
      }),
    };
    const metaAds = {
      getPage: jest.fn(async (id: string) => ({ id, name: `Page ${id}` })),
      resolveInstagramIdentity: jest.fn(async (id: string) => `IG_${id}`),
      ...(opts.meta ?? {}),
    };
    const pipeline = { addOffering: jest.fn(async () => ({ ok: true })) };
    const svc = new ProductSyncService(
      { get: () => undefined } as any,
      metaAds as any,
      pipeline as any,
      brain as any,
    );
    return { svc, calls, metaAds, pipeline };
  }

  const company = (products: any[]) => ({
    tenantId: 't1',
    meta: { pageId: 'PAGE_DEFAULT', accessToken: 'tok' },
    products,
    markModified: jest.fn(),
    save: jest.fn(async () => undefined),
  });

  it('links, records the product Page and Instagram, and saves the link back', async () => {
    const { svc, calls } = make({
      brain_read: () => ({ rows: offerings }),
      ad_account_config_read: () => ({
        resolved: { page_id: { value: 'PAGE_DEFAULT', scope: 'account' } },
      }),
      ad_account_config_write: (a) => ({ id: 1, ...a }),
    });
    const c = company([
      { name: 'Golu Devta Arzi', active: true, pageId: 'PAGE_GOLU' },
    ]);
    const r = await svc.syncCompany(c as any);
    expect(r.linked).toEqual([
      expect.objectContaining({
        product: 'Golu Devta Arzi',
        slug: 'golu_devta_arzi',
        recorded: ['page_id', 'instagram_actor_id'],
      }),
    ]);
    const writes = calls
      .filter(([t]) => t === 'ad_account_config_write')
      .map(([, a]) => a);
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'page_id',
          value: 'PAGE_GOLU',
          offering_slug: 'golu_devta_arzi',
          source: 'human',
        }),
        expect.objectContaining({
          key: 'instagram_actor_id',
          value: 'IG_PAGE_GOLU',
          offering_slug: 'golu_devta_arzi',
        }),
      ]),
    );
    expect(c.products[0].offeringSlug).toBe('golu_devta_arzi');
    expect(c.markModified).toHaveBeenCalledWith('products');
    expect(c.save).toHaveBeenCalled();
  });

  it('registers a new product everywhere when it has a landing page', async () => {
    const { svc, calls, pipeline } = make({
      brain_read: () => ({ rows: offerings }),
      offering_register: (a) => ({ slug: a.slug, outcome: 'created' }),
      ad_account_config_read: () => ({ resolved: {} }),
      ad_account_config_write: (a) => ({ id: 1, ...a }),
    });
    const c = company([
      {
        name: 'Kundli Match',
        active: true,
        price: 999,
        landingUrl: 'https://www.91astrology.com/kundli-match',
      },
    ]);
    const r = await svc.syncCompany(c as any);
    expect(pipeline.addOffering).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        landing_url: 'https://www.91astrology.com/kundli-match',
        display_name: 'Kundli Match',
        slug: 'kundli_match',
      }),
    );
    expect(calls.find(([t]) => t === 'offering_register')?.[1]).toEqual(
      expect.objectContaining({
        slug: 'kundli_match',
        display_name: 'Kundli Match',
        price_inr: 999,
      }),
    );
    expect(r.registered).toEqual(['kundli_match']);
    expect(c.products[0].offeringSlug).toBe('kundli_match');
  });

  it('reports an unlinkable product instead of guessing, and never throws', async () => {
    const { svc } = make({ brain_read: () => ({ rows: offerings }) });
    const c = company([{ name: 'Nadi', active: true }]);
    const r = await svc.syncCompany(c as any);
    expect(r.unlinked).toEqual([expect.objectContaining({ product: 'Nadi' })]);
    expect(c.save).not.toHaveBeenCalled();
  });

  it('an Instagram lookup failure still records the Page and says why', async () => {
    const { svc } = make(
      {
        brain_read: () => ({ rows: offerings }),
        ad_account_config_read: () => ({ resolved: {} }),
        ad_account_config_write: (a) => ({ id: 1, ...a }),
      },
      {
        meta: {
          resolveInstagramIdentity: jest.fn(async () => {
            throw new Error('Instagram identity is missing');
          }),
        },
      },
    );
    const c = company([
      { name: 'Career Report', active: true, pageId: 'PAGE_CAREER' },
    ]);
    const r = await svc.syncCompany(c as any);
    expect(r.linked[0].recorded).toEqual(['page_id']);
    expect(r.linked[0].warnings.join(' ')).toMatch(/Instagram/);
  });
});
