import {
  audienceOf,
  buildSituation,
  learningOf,
  PmSituationInput,
  seasonOf,
  spendBand,
  structureOf,
} from './situation.logic';

const m = (o: Partial<PmSituationInput['m7']> = {}): PmSituationInput['m7'] => ({
  spend: 70_000,
  impressions: 500_000,
  cpm: 140,
  ctr: 0.01,
  frequency: 1.2,
  firstPartyOrders: 40,
  firstPartyRevenue: 49_000,
  firstPartyRoas: 0.7,
  firstPartyCpa: 1750,
  metaRoas: 0.8,
  visitToOrderRate: 0.02,
  sitePaymentsStarted: 80,
  ...o,
});

const input = (o: Partial<PmSituationInput> = {}): PmSituationInput => ({
  date: '2026-10-26',
  product: 'nadi-report',
  objective: 'OUTCOME_SALES',
  campaignName: 'Nadi Oct',
  budgetLevel: 'adset',
  adsets: [{ audienceType: 'broad', learningStage: 'SUCCESS' }],
  launchedOn: '2026-10-01',
  lastEditOn: null,
  m7: m(),
  p7: m(),
  accountCpm7: 100,
  accountCpmPrior7: 100,
  missingDays: 0,
  calendar: [],
  ...o,
});

describe('situation tags', () => {
  it('bands daily spend', () => {
    expect(spendBand(4_999)).toBe('<5k');
    expect(spendBand(5_000)).toBe('5k-15k');
    expect(spendBand(20_000)).toBe('15k-50k');
    expect(spendBand(50_000)).toBe('>50k');
  });
  it('reads structure from the budget level and Advantage+ names', () => {
    expect(structureOf('adset', 'Nadi-Advatnage+Oct')).toBe('ABO');
    expect(structureOf('campaign', 'Nadi CBO')).toBe('CBO');
    expect(structureOf('campaign', "Nadi-Report-Advatnage+Oct'26")).toBe('ADVANTAGE_PLUS');
    expect(structureOf('', 'x')).toBe('unknown');
  });
  it('rolls up audiences and learning', () => {
    expect(audienceOf(['broad', 'lookalike'])).toBe('prospecting');
    expect(audienceOf(['broad', 'retargeting'])).toBe('mixed');
    expect(audienceOf(['custom', undefined])).toBe('unknown');
    expect(learningOf(['SUCCESS', 'SUCCESS', ''])).toBe('SUCCESS');
    expect(learningOf(['SUCCESS', 'FAIL'])).toBe('mixed');
    expect(learningOf([])).toBe('unknown');
  });
  it('tags seasons on and before calendar rows', () => {
    const s = seasonOf([
      { id: 'pitru-paksha-2026', kind: 'festival', status: 'ongoing', daysFromDate: 0 },
      { id: 'diwali-2026', kind: 'festival', status: 'upcoming', daysFromDate: 12 },
      { id: 'black-friday-2026', kind: 'market_event', status: 'upcoming', daysFromDate: 30 },
    ]);
    expect(s.season).toEqual(['pitru-paksha-2026', 'pitru-paksha', 'pre-diwali-2026', 'pre-diwali']);
    expect(s.festivalInDays).toBe(0);
  });
});

describe('buildSituation', () => {
  it('is quiet when nothing moved', () => {
    const s = buildSituation(input());
    expect(s).toMatchObject({
      structure: 'ABO',
      audience: 'prospecting',
      spendBand: '5k-15k',
      learning: 'SUCCESS',
      daysSinceLaunch: 25,
      daysSinceLastEdit: null,
      roas7d: 0.7,
      ctr7d: 1,
      accountCpmTrend: 'flat',
    });
    expect(s.symptoms).toEqual(['below_target']);
  });
  it('flags every symptom past its threshold', () => {
    const s = buildSituation(
      input({
        m7: m({ ctr: 0.007, cpm: 170, frequency: 1.6, firstPartyOrders: 20, firstPartyRevenue: 25_000, visitToOrderRate: 0.01, sitePaymentsStarted: 60 }),
        adsets: [{ audienceType: 'broad', learningStage: 'FAIL' }],
        missingDays: 1,
        lastEditOn: '2026-10-22',
        accountCpm7: 115,
      }),
    );
    expect(s.symptoms).toEqual([
      'below_target',
      'ctr_drop',
      'cpm_up',
      'freq_high',
      'orders_drop',
      'payment_drop',
      'funnel_drop',
      'learning_limited',
      'data_gap',
      'recent_edit',
    ]);
    expect(s.accountCpmTrend).toBe('up');
    expect(s.daysSinceLastEdit).toBe(4);
  });
});
