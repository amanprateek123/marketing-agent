import {
  confidenceOf,
  matchScope,
  meetsBar,
  nextStatus,
  renderLessonsMarkdown,
  selectForPhase,
  supportFromCheck,
  supportFromOutcome,
  validateProposal,
} from './lessons.logic';
import type {
  PmDecisionRecord,
  PmLesson,
  PmLessonCase,
  PmOutcomeRecord,
  PmSituation,
} from './lessons.types';

const sit: PmSituation = {
  product: 'nadi-report-premium',
  structure: 'ABO',
  objective: 'OUTCOME_SALES',
  audience: 'prospecting',
  spendBand: '5k-15k',
  learning: 'SUCCESS',
  daysSinceLaunch: 20,
  daysSinceLastEdit: 4,
  roas7d: 1.15,
  cpa7d: 900,
  ctr7d: 1.2,
  cpm7d: 140,
  freqDay: 1.1,
  accountCpmTrend: 'up',
  season: ['pre-diwali'],
  festivalInDays: 6,
  symptoms: ['ctr_drop', 'cpm_up'],
};

const cs = (pattern: string, start = '2026-09-01'): PmLessonCase[] =>
  [...pattern].map((p, i) => ({
    ref: `D-${i}`,
    supports: p === '+',
    campaignId: i % 2 ? 'c1' : 'c2',
    at: new Date(Date.parse(`${start}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10),
  }));

const lesson = (o: Partial<PmLesson> = {}): PmLesson => ({
  lessonId: 'L-1',
  type: 'action_effect',
  statement: 'When ABO prospecting at 7d ROAS ≥ 1.1, then +20% budget kept ROAS within −10%.',
  scope: { structure: 'ABO' },
  claim: { kind: 'action_effect', action: { type: 'budget', direction: 'up', maxStep: 0.2 }, expect: 'worked' },
  status: 'active',
  cases: cs('+++'),
  confidence: 0.5,
  uses: 0,
  hits: 0,
  version: 1,
  createdAt: '2026-09-01',
  ...o,
});

describe('matchScope', () => {
  it('handles equality, any-of, comparators and arrays', () => {
    expect(matchScope({ structure: 'abo' }, sit)).toBe(true);
    expect(matchScope({ structure: 'CBO|ADVANTAGE_PLUS' }, sit)).toBe(false);
    expect(matchScope({ roas7d: '>=1.1', freqDay: '<1.3' }, sit)).toBe(true);
    expect(matchScope({ roas7d: '<1' }, sit)).toBe(false);
    expect(matchScope({ daysSinceLaunch: '>3' }, { ...sit, daysSinceLaunch: null })).toBe(false);
    expect(matchScope({ season: 'pitru-paksha|pre-diwali' }, sit)).toBe(true);
    expect(matchScope({ symptoms: 'freq_high' }, sit)).toBe(false);
    expect(matchScope({ phase: 'plan', category: 'creative' }, sit)).toBe(true);
  });
});

describe('selectForPhase', () => {
  it('keeps active lessons of the phase types, ranked, capped per type and per phase', () => {
    const ls = [
      lesson({ lessonId: 'L-1' }),
      lesson({ lessonId: 'L-2', scope: { structure: 'ABO', audience: 'prospecting' } }),
      lesson({ lessonId: 'L-3', confidence: 0.8 }),
      lesson({ lessonId: 'L-4', status: 'candidate' }),
      lesson({ lessonId: 'L-5', scope: { structure: 'CBO' } }),
      lesson({ lessonId: 'L-6', type: 'diagnosis_pattern', claim: { kind: 'diagnosis_pattern', category: 'creative', holds: false } }),
      lesson({ lessonId: 'L-7', type: 'season_effect', scope: { phase: 'investigate' } }),
      lesson({ lessonId: 'L-8', type: 'segment_fact' }),
    ];
    const picked = selectForPhase(ls, 'plan', sit).map((l) => l.lessonId);
    expect(picked).toEqual(['L-2', 'L-3', 'L-8']);
    expect(selectForPhase(ls, 'investigate', sit).map((l) => l.lessonId)).toEqual(['L-6', 'L-7', 'L-8']);
    expect(selectForPhase(ls, 'plan', sit, { perPhase: 1 })).toHaveLength(1);
  });

  it('breaks ties by hit rate (neutral under 3 uses) then most recent case', () => {
    const a = lesson({ lessonId: 'A', uses: 4, hits: 1 });
    const b = lesson({ lessonId: 'B', uses: 2, hits: 0 });
    const c = lesson({ lessonId: 'C', cases: cs('+++', '2026-10-01') });
    expect(selectForPhase([a, b, c], 'plan', sit, { perTypePerPhase: 3 }).map((l) => l.lessonId)).toEqual(['C', 'B', 'A']);
  });
});

describe('confidence and bar', () => {
  it('bins confidence from n and share', () => {
    expect(confidenceOf(cs('++'))).toBe(0.2);
    expect(confidenceOf(cs('+++'))).toBe(0.5);
    expect(confidenceOf(cs('+++-'))).toBe(0.5);
    expect(confidenceOf(cs('++--'))).toBe(0.2);
    expect(confidenceOf(cs('+++++++-'))).toBe(0.8);
    expect(confidenceOf(cs('++++++--'))).toBe(0.5);
  });
  it('needs 3 supporting cases in 2 campaigns at ≥ 75%', () => {
    expect(meetsBar({ cases: cs('+++') })).toBe(true);
    expect(meetsBar({ cases: cs('+++').map((c) => ({ ...c, campaignId: 'c1' })) })).toBe(false);
    expect(meetsBar({ cases: cs('++-+-') })).toBe(false);
  });
});

describe('nextStatus', () => {
  const today = '2026-10-26';
  it('expires candidates after 60 days', () => {
    expect(nextStatus(lesson({ status: 'candidate', createdAt: '2026-08-01' }), today)).toBe('retired');
    expect(nextStatus(lesson({ status: 'candidate', createdAt: '2026-10-01' }), today)).toBe('candidate');
  });
  it('sends to review on two contradictions in a row or weak recent share', () => {
    expect(nextStatus(lesson({ cases: cs('++++--', '2026-10-01') }), today)).toBe('review');
    expect(nextStatus(lesson({ cases: cs('++-+-+-+', '2026-10-01').map((c, i) => ({ ...c, supports: [1, 1, 0, 1, 0, 0, 1, 0][i] === 1 })) }), today)).toBe('review');
    expect(nextStatus(lesson({ cases: cs('++++-+', '2026-10-01') }), today)).toBe('active');
  });
  it('returns review lessons to active when share recovers and the last two support', () => {
    expect(nextStatus(lesson({ status: 'review', cases: cs('+++-++', '2026-10-01') }), today)).toBe('active');
    expect(nextStatus(lesson({ status: 'review', cases: cs('+++--+', '2026-10-01') }), today)).toBe('review');
  });
  it('retires on low share over ≥ 6 cases or no recent support', () => {
    expect(nextStatus(lesson({ cases: cs('+-+---', '2026-10-01') }), today)).toBe('retired');
    expect(nextStatus(lesson({ cases: cs('+++', '2026-05-01') }), today)).toBe('retired');
    expect(nextStatus(lesson({ type: 'creative_pattern', cases: cs('+++', '2026-07-20') }), today)).toBe('retired');
    // Season lessons stay until the same window next year.
    expect(nextStatus(lesson({ type: 'season_effect', cases: cs('+++', '2025-10-20') }), today)).toBe('active');
    expect(nextStatus(lesson({ type: 'season_effect', cases: cs('+++', '2025-09-01') }), today)).toBe('retired');
  });
});

describe('support from records', () => {
  const d: PmDecisionRecord = {
    decisionId: 'D-1', source: 'recommended', date: '2026-10-10', campaignId: 'c1',
    entityLevel: 'adset', entityId: 'a1', entityName: 'A', type: 'budget', field: 'daily_budget',
    from: 10000, to: 12000, direction: 'up', step: 0.2, taken: 'taken', context: sit, causes: [], lessonIds: [],
  };
  const o = (verdict: PmOutcomeRecord['verdict'], weak = false) =>
    ({ decisionId: 'D-1', read: 'settled', verdict, weak } as PmOutcomeRecord);
  it('counts only clean verdicts on a matching action and context', () => {
    const l = lesson();
    expect(supportFromOutcome(l, d, o('worked'))).toBe(true);
    expect(supportFromOutcome(l, d, o('hurt'))).toBe(false);
    expect(supportFromOutcome(l, d, o('inconclusive'))).toBeNull();
    expect(supportFromOutcome(l, d, o('worked', true))).toBeNull();
    expect(supportFromOutcome(l, { ...d, step: 0.3 }, o('worked'))).toBeNull();
    expect(supportFromOutcome(l, { ...d, context: { ...sit, structure: 'CBO' } }, o('worked'))).toBeNull();
    expect(supportFromOutcome(l, { ...d, taken: 'not_taken' }, o('worked'))).toBeNull();
  });
  it('scores diagnosis checks against the claim', () => {
    const l = lesson({ type: 'diagnosis_pattern', claim: { kind: 'diagnosis_pattern', category: 'creative', holds: false } });
    const c = { checkId: 'DC-1', category: 'creative', result: 'not_held' } as any;
    expect(supportFromCheck(l, c)).toBe(true);
    expect(supportFromCheck(l, { ...c, result: 'held' })).toBe(false);
    expect(supportFromCheck(l, { ...c, result: 'unclear' })).toBeNull();
    expect(supportFromCheck(l, { ...c, category: 'tracking' })).toBeNull();
  });
});

describe('validateProposal', () => {
  const ctx = {
    lessons: [lesson()],
    knownIds: new Set(['D-0', 'D-1', 'D-9', 'cev-1', 'cev-2']),
    measureIds: new Set(['cev-2']),
  };
  const draft = { ...lesson(), lessonId: undefined, scope: { structure: 'ABO', roas7d: '>=1.1' } };
  it('accepts a valid ADD and flags missing ids, bad scope keys and claim kinds', () => {
    expect(validateProposal({ op: 'ADD', lesson: draft, cases: cs('+').map((c) => ({ ...c, ref: 'D-9' })) }, ctx)).toEqual([]);
    const bad = validateProposal(
      { op: 'ADD', lesson: { ...draft, scope: { colour: 'red' }, claim: { kind: 'measured', metric: 'roas' } }, cases: [{ ref: 'D-77', supports: true, campaignId: 'c1', at: '2026-10-01' }] },
      ctx,
    );
    expect(bad).toEqual(expect.arrayContaining(['unknown scope key "colour"', 'case D-77 does not exist', expect.stringContaining('needs a "action_effect" claim')]));
  });
  it('rejects near-duplicates and measured lessons without measure_* evidence', () => {
    const dup = validateProposal({ op: 'ADD', lesson: { ...lesson(), claim: { ...lesson().claim, effect: { metric: 'roas', median: 0, low: -1, high: 1 } } } as any, cases: cs('+') }, ctx);
    expect(dup).toContain('near-duplicate of L-1: use EDIT or MERGE');
    const seg = { type: 'segment_fact' as const, statement: 'x', scope: {}, claim: { kind: 'measured' as const, metric: 'cvr' } };
    expect(validateProposal({ op: 'ADD', lesson: seg, cases: [{ ref: 'cev-1', supports: true, campaignId: 'c1', at: '2026-10-01' }] }, ctx)).toContain('a segment_fact lesson must cite measure_* evidence ids');
    expect(validateProposal({ op: 'ADD', lesson: seg, cases: [{ ref: 'cev-2', supports: true, campaignId: 'c1', at: '2026-10-01' }] }, ctx)).toEqual([]);
  });
  it('checks targets, attachments and promotion', () => {
    expect(validateProposal({ op: 'RETIRE', lessonId: 'L-9' }, ctx)).toEqual(['lesson L-9 does not exist']);
    expect(validateProposal({ op: 'ATTACH', lessonId: 'L-1', cases: cs('+') }, ctx)).toEqual(['case D-0 is already attached']);
    expect(validateProposal({ op: 'PROMOTE', lessonId: 'L-1' }, ctx)).toEqual(['lesson L-1 is active, not a candidate']);
    expect(validateProposal({ op: 'MERGE', mergeIds: ['L-1'], lesson: draft }, ctx)).toContain('MERGE needs ≥ 2 mergeIds');
  });
});

describe('renderLessonsMarkdown', () => {
  it('renders lessons as checks and all active owner rules', () => {
    const md = renderLessonsMarkdown(
      [lesson({ uses: 5, hits: 4 })],
      [{ ruleId: 'R-1', text: 'Never pause an ad before day 3', active: true, check: { kind: 'no_pause_before_days', days: 3 } }, { ruleId: 'R-2', text: 'off', active: false }],
      'plan',
      12,
    );
    expect(md).toContain('## Lessons (code-picked, 1 of 12 active)');
    expect(md).toContain('- L-1 · action_effect · conf 0.5 · hit 4/5 (80%) · 3 of 3 cases — Check whether it holds today: When ABO');
    expect(md).toContain('## Owner rules (all)');
    expect(md).toContain('- R-1 — Never pause an ad before day 3 [code-checked: no_pause_before_days]');
    expect(md).not.toContain('R-2');
  });
});
