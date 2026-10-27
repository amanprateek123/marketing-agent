import type { Action } from '../pm-agent.types';
import {
  buildJournal,
  inr,
  journalMarkdown,
  matchChange,
  PmChangeRow,
  readOf,
  resetsLearning,
  resultLine,
  snapshotDiffs,
} from './journal.logic';

const at = (s: string) => new Date(`${s}+05:30`);

const change = (p: Partial<PmChangeRow>): PmChangeRow => ({
  at: at('2026-10-25T14:02:00'),
  objectType: 'AD_SET',
  objectId: 'S1',
  objectName: 'Hindi 25-44',
  campaignId: 'C1',
  adsetId: 'S1',
  eventType: 'update_ad_set_budget',
  field: 'daily_budget',
  oldValue: 10000,
  newValue: 8000,
  actorName: 'Asha',
  applicationName: '',
  source: 'log',
  ...p,
});

const action = (p: Partial<Action>): Action => ({
  id: 'A1',
  type: 'budget',
  title: 'cut ad set "Hindi 25-44" budget 20%',
  causeIds: [],
  entityLevel: 'adset',
  entityId: 'S1',
  entityName: 'Hindi 25-44',
  change: { field: 'daily_budget', from: 10000, to: 8000 },
  expectedEffect: { metric: 'cpa', low: 0, high: 0, evidence: [] },
  impactRupeesPerDay: 0,
  confidence: 0.5,
  resetsLearning: false,
  judgeOn: '2026-11-01',
  stopCondition: '',
  lessonIds: [],
  risk: '',
  ...p,
});

describe('journal.logic', () => {
  it('budget: same size → taken, other size → partly, opposite → no match', () => {
    const a = action({});
    expect(matchChange(a, change({}))).toBe('taken');
    expect(matchChange(a, change({ newValue: 9000 }))).toBe('partly');
    expect(matchChange(a, change({ newValue: 12000 }))).toBeNull();
    expect(
      matchChange(a, change({ objectId: 'S2', adsetId: 'S2' })),
    ).toBeNull();
  });

  it('campaign pause done on only some ad sets → partly; new ad in the ad set → taken', () => {
    const pause = action({
      type: 'pause',
      entityLevel: 'campaign',
      entityId: 'C1',
      change: { field: 'status', from: 'ACTIVE', to: 'PAUSED' },
    });
    const st = change({
      field: 'status',
      oldValue: 'ACTIVE',
      newValue: 'PAUSED',
    });
    expect(matchChange(pause, st)).toBe('partly');
    expect(matchChange(pause, { ...st, objectId: 'C1' })).toBe('taken');
    const creative = action({
      type: 'creative',
      change: { field: 'creative', from: null, to: 'new' },
    });
    const newAd = change({
      objectType: 'AD',
      objectId: 'AD9',
      field: 'created',
      oldValue: null,
      newValue: null,
    });
    expect(matchChange(creative, newAd)).toBe('taken');
  });

  it('learning resets: big budget step, creative, unpause after a long pause', () => {
    expect(resetsLearning(change({}), [])).toBe(false); // exactly 20%
    expect(resetsLearning(change({ newValue: 13000 }), [])).toBe(true);
    expect(resetsLearning(change({ field: 'created' }), [])).toBe(true);
    const unpause = change({
      field: 'status',
      oldValue: 'PAUSED',
      newValue: 'ACTIVE',
    });
    const pausedLong = change({
      field: 'status',
      newValue: 'PAUSED',
      at: at('2026-10-10T10:00:00'),
    });
    const pausedShort = { ...pausedLong, at: at('2026-10-24T10:00:00') };
    expect(resetsLearning(unpause, [pausedLong])).toBe(true);
    expect(resetsLearning(unpause, [pausedShort, pausedLong])).toBe(false);
  });

  it('read windows', () => {
    expect(readOf('2026-10-25', '2026-10-26', false, false)).toMatchObject({
      read: 'too_soon',
      judgeAgainOn: '2026-10-27',
    });
    expect(readOf('2026-10-25', '2026-10-27', false, false)).toMatchObject({
      read: 'early',
      judgeAgainOn: '2026-11-01',
    });
    expect(readOf('2026-10-25', '2026-10-27', true, false).read).toBe(
      'too_soon',
    );
    expect(readOf('2026-10-25', '2026-10-27', true, true).read).toBe('early');
    expect(readOf('2026-10-25', '2026-11-01', true, false).read).toBe(
      'settled',
    );
  });

  it('builds taken / not taken / outside entries, newest first', () => {
    const items = buildJournal({
      date: '2026-10-27',
      days: 14,
      runs: [
        {
          date: '2026-10-25',
          userNote: 'did A1, skipped A2',
          actions: [
            action({}),
            action({
              id: 'A2',
              type: 'pause',
              title: 'pause ad "Premium v3"',
              entityLevel: 'ad',
              entityId: 'AD3',
              change: { field: 'status', from: 'ACTIVE', to: 'PAUSED' },
            }),
          ],
        },
      ],
      changes: [
        change({}),
        change({
          at: at('2026-10-26T09:00:00'),
          objectType: 'AD',
          objectId: 'AD9',
          objectName: 'Diwali v1',
          field: 'created',
          oldValue: null,
          newValue: null,
        }),
        // Too late for the 72 h window and outside the 14 days: ignored.
        change({ at: at('2026-09-01T09:00:00') }),
      ],
      learningEnded: () => false,
    });
    expect(items.map((i) => [i.date, i.actionId ?? '-', i.status])).toEqual([
      ['2026-10-26', '-', 'outside_change'],
      ['2026-10-25', 'A1', 'taken'],
      ['2026-10-25', 'A2', 'not_taken'],
    ]);
    expect(items[0]).toMatchObject({
      resetsLearning: true,
      read: 'too_soon',
      judgeAgainOn: '2026-11-02',
    });
    expect(items[1].matched[0]).toBe(
      'Meta log 25 Oct 14:02, ad set "Hindi 25-44" daily budget ₹10,000 → ₹8,000 by Asha',
    );
    expect(items[1]).toMatchObject({
      read: 'early',
      userNote: 'did A1, skipped A2',
    });

    const md = journalMarkdown(items, {
      campaignName: 'Nadi Hindi',
      date: '2026-10-27',
      days: 14,
      notes: [{ date: '2026-10-25', note: 'did A1, skipped A2' }],
    });
    expect(md).toContain(
      'Settling now — do not stack edits on: ad "Diwali v1" until 2 Nov; ad set "Hindi 25-44" until 1 Nov',
    );
    expect(md).toContain(
      '## 2026-10-25 · A2 pause ad "Premium v3" — NOT TAKEN\n',
    );
    expect(md).toContain(
      '## 2026-10-26 · outside change: new ad "Diwali v1" created by Asha',
    );
    expect(md).toContain('> Your note on the 25 Oct run: did A1, skipped A2');
  });

  it('snapshot diffs find edits the log missed', () => {
    const base = {
      entityId: 'S1',
      level: 'adset' as const,
      name: 'Hindi 25-44',
      campaignId: 'C1',
      adsetId: 'S1',
      status: 'ACTIVE',
      dailyBudget: 10000,
      lifetimeBudget: null,
      bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
      targetingSummary: { ageMin: 25 },
      creativeId: '',
    };
    const rows = snapshotDiffs([
      { ...base, date: '2026-10-26', dailyBudget: 8000 },
      { ...base, date: '2026-10-25' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'daily_budget',
      oldValue: 10000,
      newValue: 8000,
      source: 'snapshot',
    });
  });

  it('formats rupees and the before/after line', () => {
    expect(inr(125000.4)).toBe('₹1,25,000');
    expect(
      resultLine(
        'early',
        2,
        { days: 2, spend: 8000, firstPartyCpa: 1120, firstPartyRoas: 0.61 },
        { days: 2, spend: 6400, firstPartyCpa: 980, firstPartyRoas: 0.74 },
      ),
    ).toBe(
      'Day 2 (early): spend ₹4,000 → ₹3,200/day, CPA ₹1,120 → ₹980, ROAS 0.61 → 0.74 (first-party, 2 days before vs after)',
    );
  });
});
