import axios from 'axios';
import {
  checkLaunchAudiences,
  dropUnavailablePurchaserExclusions,
  markOptionalPurchaserExclusions,
  purchaserAudienceIds,
} from './launch-audience-check';

jest.mock('axios');
const get = axios.get as jest.Mock;

const audience = (id: string, extra: any = {}) => ({
  data: {
    id,
    account_id: '111',
    delivery_status: { code: 200 },
    operation_status: { code: 200 },
    ...extra,
  },
});
const metaError = (status: number, error: any) => ({
  response: { status, data: { error } },
});

describe('checkLaunchAudiences', () => {
  beforeEach(() => jest.resetAllMocks());

  it('accepts a ready audience, including one shared from another ad account', async () => {
    get.mockResolvedValue(audience('shared', { account_id: '222' }));
    const check = await checkLaunchAudiences(['shared'], 'token');
    expect([...check.valid]).toEqual(['shared']);
  });

  it('rejects an audience in an error state', async () => {
    get.mockResolvedValue(audience('a', { delivery_status: { code: 400 } }));
    const check = await checkLaunchAudiences(['a'], 'token');
    expect(check.invalid.has('a')).toBe(true);
  });

  it('rejects an audience Meta says does not exist', async () => {
    get.mockRejectedValue(
      metaError(400, {
        code: 100,
        error_subcode: 33,
        message: 'Object does not exist',
      }),
    );
    const check = await checkLaunchAudiences(['gone'], 'token');
    expect(check.invalid.get('gone')).toBe('Object does not exist');
    expect(check.unchecked.size).toBe(0);
  });

  it.each([
    ['timeout', new Error('timeout of 10000ms exceeded')],
    [
      'rate limit',
      metaError(400, { code: 17, message: 'User request limit reached' }),
    ],
    ['5xx', metaError(503, { message: 'Service unavailable' })],
    [
      'is_transient',
      metaError(400, { code: 100, is_transient: true, message: 'Try again' }),
    ],
  ])('marks a %s as unchecked, not invalid', async (_label, err) => {
    get.mockRejectedValue(err);
    const check = await checkLaunchAudiences(['a'], 'token');
    expect([...check.unchecked]).toEqual(['a']);
    expect(check.invalid.size).toBe(0);
    expect(check.valid.size).toBe(0);
  });
});

describe('purchasers exclusions are optional whoever added them', () => {
  // 2026-10-01: dashboard-built campaign saved Purchasers exclusion
  // 120242739389540403; Meta rejected it on act_692074691787119 and launch
  // refused to drop it because it wasn't marked as auto-added.
  const products = [
    {
      name: 'Nadi Report',
      metaAudiences: [
        { id: '120242739389540403', name: 'Purchasers_NadiReport' },
        { id: 'lal', name: 'LAL_1pct' },
      ],
    },
    {
      name: 'Nadi Leaf',
      metaAudiences: [{ id: 'p2', name: 'Purchaser_NadiLeaf' }],
    },
  ];
  const purchasers = purchaserAudienceIds(products);

  it('collects purchasers audiences from every product', () =>
    expect([...purchasers].sort()).toEqual(['120242739389540403', 'p2']));

  it('marks a saved purchasers exclusion as optional, leaving chosen exclusions alone', () => {
    const adSets: any[] = [
      {
        name: 'Ad set 1',
        excludeAudienceIds: ['chosen', '120242739389540403'],
      },
    ];
    markOptionalPurchaserExclusions(adSets, purchasers);
    expect(adSets[0].autoExcludeAudienceIds).toEqual(['120242739389540403']);
  });

  it('drops an unavailable purchasers exclusion before launch, but not a chosen one', () => {
    const adSets: any[] = [
      {
        name: 'Ad set 1',
        excludeAudienceIds: ['chosen', '120242739389540403'],
      },
    ];
    const invalid = new Map([
      ['120242739389540403', 'not returned by Meta'],
      ['chosen', 'deleted'],
    ]);
    expect(
      dropUnavailablePurchaserExclusions(adSets, purchasers, invalid),
    ).toEqual([{ adSet: 'Ad set 1', ids: ['120242739389540403'] }]);
    expect(adSets[0].excludeAudienceIds).toEqual(['chosen']);
  });

  it('leaves ad sets without purchasers exclusions untouched', () => {
    const adSets: any[] = [
      { name: 'Retarget', excludeAudienceIds: ['chosen'] },
    ];
    markOptionalPurchaserExclusions(adSets, purchasers);
    expect(adSets[0].autoExcludeAudienceIds).toBeUndefined();
  });
});
