import {
  classifyChannel,
  dayRange,
  isFirst,
  istDay,
  istDayBounds,
  localeOf,
  nearestPayment,
  netOfGst,
  netRevenueOf,
  pickMetaClicks,
  refundOf,
  toAmount,
  TrafficRaw,
} from './pm.logic';

const DAY = 24 * 60 * 60 * 1000;
const traffic = (t: Partial<TrafficRaw>): TrafficRaw => ({
  utmSource: '',
  utmMedium: '',
  utmContent: '',
  referrerName: '',
  hasFbclid: false,
  hasGoogleClickId: false,
  metaAdCount: 0,
  ...t,
});

describe('pm.logic', () => {
  it('IST days and bounds', () => {
    expect(istDay(new Date('2026-10-24T20:00:00Z'))).toBe('2026-10-25'); // 01:30 IST
    const b = istDayBounds('2026-10-25');
    expect(b.start.toISOString()).toBe('2026-10-24T18:30:00.000Z');
    expect(b.end.getTime() - b.start.getTime()).toBe(DAY);
    expect(dayRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(() => dayRange('2026-11-02', '2026-10-30')).toThrow();
    expect(() => dayRange('2026-01-01', '2026-12-31', 30)).toThrow();
  });

  it('money', () => {
    expect(toAmount('1799')).toBe(1799);
    expect(toAmount('₹1,799.50')).toBe(1799.5);
    expect(toAmount(undefined)).toBe(0);
    expect(netOfGst(1799)).toBe(1524.58);
  });

  it('locale', () => {
    expect(localeOf('/hi/nadi-report-premium')).toBe('hi');
    expect(localeOf('/nadi-report-premium')).toBe('en');
  });

  it('channels', () => {
    expect(classifyChannel(traffic({ metaAdCount: 1, utmSource: 'fb' }))).toBe(
      'meta_ad',
    );
    expect(
      classifyChannel(traffic({ utmSource: 'social', utmMedium: 'quora' })),
    ).toBe('quora');
    expect(
      classifyChannel(traffic({ utmSource: 'social', utmMedium: 'chatgpt' })),
    ).toBe('chatgpt');
    expect(
      classifyChannel(traffic({ utmSource: 'social', utmMedium: 'fb' })),
    ).toBe('meta_other');
    expect(classifyChannel(traffic({ hasFbclid: true }))).toBe('meta_other');
    expect(classifyChannel(traffic({ hasGoogleClickId: true }))).toBe(
      'google_ads',
    );
    expect(classifyChannel(traffic({ referrerName: 'Google' }))).toBe(
      'google_organic',
    );
    expect(classifyChannel(traffic({ utmSource: 'whatsapp' }))).toBe(
      'other_utm',
    );
    expect(classifyChannel(traffic({ referrerName: 'Bing' }))).toBe('referral');
    expect(classifyChannel(traffic({}))).toBe('direct');
  });

  it('meta clicks: last/first inside the 7-day window only', () => {
    const order = Date.parse('2026-10-20T10:00:00Z');
    const t = (daysBefore: number, adId: string) => ({
      at: order - daysBefore * DAY,
      adId,
      adsetId: 's',
      campaignId: 'c',
    });
    const r = pickMetaClicks(
      [t(8, 'old'), t(5, 'a'), t(1, 'b'), t(-1, 'after')],
      order,
    );
    expect(r.first?.adId).toBe('a');
    expect(r.last?.adId).toBe('b');
    expect(r.distinctAds).toBe(2);
    expect(pickMetaClicks([], order)).toEqual({
      first: null,
      last: null,
      distinctAds: 0,
    });
  });

  it('new customer ignores the order’s own record', () => {
    const at = 1_000_000;
    expect(isFirst([{ ids: ['own'], at }], ['own'], at)).toBe(true);
    expect(
      isFirst(
        [
          { ids: ['own'], at },
          { ids: ['later'], at: at + 5 },
        ],
        ['own'],
        at,
      ),
    ).toBe(true);
    expect(
      isFirst(
        [
          { ids: ['earlier'], at: at - 5 },
          { ids: ['own'], at },
        ],
        ['own'],
        at,
      ),
    ).toBe(false);
    expect(isFirst([], ['own'], at)).toBe(true);
    // a payment known by a different id than the order still counts as its own
    expect(
      isFirst([{ ids: ['order-1', 'txn-1'], at: at - 1 }], ['order-1'], at),
    ).toBe(true);
    expect(() => isFirst([{ ids: ['x'], at: NaN }], ['own'], at)).toThrow();
  });

  it('refund states', () => {
    expect(refundOf([]).state).toBe('none');
    expect(
      refundOf([{ type: 'REFUND', transactionStatus: 'PENDING', amount: 590 }]),
    ).toMatchObject({ state: 'pending', amount: 590 });
    expect(
      refundOf([
        {
          type: 'REFUND',
          transactionStatus: 'PENDING',
          refundStatus: 'SUCCESS',
          amount: 590,
        },
      ]).state,
    ).toBe('refunded');
    expect(
      refundOf([{ type: 'ECOMMERCE', refundedAt: '2026-10-22T10:58:58+05:30' }])
        .state,
    ).toBe('refunded');
    // refundedAt on the original wins over a REFUND row still pending
    expect(
      refundOf([
        { type: 'ECOMMERCE', refundedAt: '2026-10-22T10:58:58+05:30' },
        { type: 'REFUND', transactionStatus: 'PENDING', amount: 590 },
      ]).state,
    ).toBe('refunded');
    // failed refunds are ignored
    expect(
      refundOf([{ type: 'REFUND', transactionStatus: 'PAYMENT_FAILED' }]).state,
    ).toBe('none');
  });

  it('net revenue: confirmed only, minus completed refunds', () => {
    const none = { state: 'none', amount: 0 };
    expect(netRevenueOf(false, 1799, none)).toBe(0);
    expect(netRevenueOf(true, 1799, none)).toBe(1524.58);
    expect(netRevenueOf(true, 1799, { state: 'refunded', amount: 1799 })).toBe(
      0,
    );
    expect(netRevenueOf(true, 1799, { state: 'refunded', amount: 0 })).toBe(0); // unknown amount = full
    expect(netRevenueOf(true, 1799, { state: 'pending', amount: 1799 })).toBe(
      1524.58,
    );
  });

  it('nearest payment within -30s/+180s', () => {
    const at = 1_000_000;
    expect(
      nearestPayment([{ at: at - 40_000 }, { at: at + 200_000 }], at),
    ).toBeNull();
    expect(
      nearestPayment([{ at: at + 100_000 }, { at: at + 5_000 }], at),
    ).toEqual({ at: at + 5_000 });
  });
});
