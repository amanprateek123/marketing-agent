import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, createConnection, Model, Schema } from 'mongoose';
import {
  PmLessonDoc,
  PmLessonEventDoc,
  PmLessonEventSchema,
  PmLessonProposalDoc,
  PmLessonProposalSchema,
  PmLessonSchema,
  PmOwnerRuleDoc,
  PmOwnerRuleSchema,
} from '../../schemas/pm-lessons.schema';
import { PmCalendarTools } from '../tools/calendar.tools';
import * as curator from './curator';
import { isoWeek, PmLessonsService } from './lessons.service';
import type { PmSituation } from './lessons.types';

// Records models are the records agent's; plain loose schemas keep this spec about lessons only.
jest.mock('../../schemas/pm-lesson-records.schema', () => ({
  PmDecisionRecord: { name: 'PmDecisionRecord' },
  PmOutcomeRecord: { name: 'PmOutcomeRecord' },
  PmDiagnosisCheck: { name: 'PmDiagnosisCheck' },
}));
const loose = () => new Schema({}, { strict: false });

const T = '91astrology';
const sit: PmSituation = {
  product: 'nadi-report-premium', structure: 'ABO', objective: 'OUTCOME_SALES', audience: 'prospecting',
  spendBand: '5k-15k', learning: 'SUCCESS', daysSinceLaunch: 20, daysSinceLastEdit: 4, roas7d: 1.15,
  cpa7d: 900, ctr7d: 1.2, cpm7d: 140, freqDay: 1.1, accountCpmTrend: 'flat', season: [], festivalInDays: null, symptoms: [],
};
const claim = { kind: 'action_effect', action: { type: 'budget', direction: 'up', maxStep: 0.2 }, expect: 'worked' };

describe('PmLessonsService', () => {
  let mongo: MongoMemoryServer;
  let conn: Connection;
  let m: Record<string, Model<any>>;
  let svc: PmLessonsService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    conn = await createConnection(mongo.getUri()).asPromise();
    m = {
      lessons: conn.model(PmLessonDoc.name, PmLessonSchema),
      events: conn.model(PmLessonEventDoc.name, PmLessonEventSchema),
      proposals: conn.model(PmLessonProposalDoc.name, PmLessonProposalSchema),
      rules: conn.model(PmOwnerRuleDoc.name, PmOwnerRuleSchema),
      decisions: conn.model('PmDecisionRecord', loose(), 'pm_decisions'),
      outcomes: conn.model('PmOutcomeRecord', loose(), 'pm_outcomes'),
      checks: conn.model('PmDiagnosisCheck', loose(), 'pm_diagnosis_checks'),
    };
    process.env.PM_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pm-lessons-'));
    const records = { curatorDefs: () => [] };
    svc = new PmLessonsService(
      m.lessons, m.events, m.proposals, m.rules, m.decisions, m.outcomes, m.checks,
      records as any, new PmCalendarTools(), { tenantId: T } as any,
    );
  });
  afterAll(async () => {
    await conn?.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await Promise.all(Object.values(m).map((x) => x.deleteMany({})));
    jest.restoreAllMocks();
  });

  async function graded(i: number, campaignId: string, verdict: string, lessonIds: string[] = []) {
    const decisionId = `D-2026-10-0${i}-${campaignId}-A1`;
    await m.decisions.create({
      tenantId: T, decisionId, source: 'recommended', date: `2026-10-0${i}`, campaignId, entityLevel: 'adset',
      entityId: 'x', type: 'budget', field: 'daily_budget', direction: 'up', step: 0.2, taken: 'taken', context: sit, lessonIds,
    });
    const w = { from: 'a', to: 'b', roas: 1, orders: 10, spend: 1000, cpa: 1 };
    await m.outcomes.create({
      tenantId: T, decisionId, read: 'settled', before: w, after: w, baseline: { roasBefore: 1, roasAfter: 1 },
      diffInDiff: { roas: 0.1, low: 0, high: 0.2 }, verdict, insidePredictedRange: true, weak: false, gradedAt: `2026-10-1${i}`,
    });
    return decisionId;
  }

  it('scores daily: attaches code-computed cases, counts hits once, proposes promotion', async () => {
    await m.lessons.create({ tenantId: T, lessonId: 'L-1', type: 'action_effect', statement: 's', scope: { structure: 'ABO' }, claim, status: 'candidate', createdAt: '2026-10-01' });
    await graded(1, 'c1', 'worked', ['L-1']);
    await graded(2, 'c2', 'worked');
    await graded(3, 'c1', 'worked');
    await graded(4, 'c2', 'inconclusive');

    const s = await svc.scoreDaily('2026-10-26');
    expect(s).toMatchObject({ attached: 3, hits: 1, misses: 0, promotions: 1 });
    const l = await m.lessons.findOne({ lessonId: 'L-1' }).lean<any>();
    expect(l.cases).toHaveLength(3);
    expect(l.confidence).toBe(0.5);
    expect(l.uses).toBe(1);

    // Idempotent.
    expect(await svc.scoreDaily('2026-10-26')).toMatchObject({ attached: 0, hits: 0, promotions: 0 });

    const [p] = await svc.listProposals('pending');
    expect(p.op).toBe('PROMOTE');
    expect(await svc.approve(p.proposalId, 'ok')).toMatchObject({ status: 'approved', lessonId: 'L-1' });
    const md = (await svc.forPhase('plan', sit)).markdown;
    expect(md).toContain('## Lessons (code-picked, 1 of 1 active)');
    expect(md).toContain('- L-1 · action_effect');
  });

  it('applies valid curator ADDs as candidates, keeps invalid ones, leaves EDIT of active for you', async () => {
    await m.lessons.create({ tenantId: T, lessonId: 'L-1', type: 'action_effect', statement: 's', scope: { structure: 'ABO' }, claim, status: 'active', cases: [], createdAt: '2026-10-01' });
    const d1 = await graded(1, 'c1', 'worked');
    jest.spyOn(curator, 'runCurator').mockResolvedValue({
      reused: false,
      costUsd: 1,
      output: {
        summary: '',
        markdown: '',
        deltas: [
          { op: 'ADD', why: 'w', lesson: { type: 'action_effect', statement: 'When CBO…', scope: { structure: 'CBO' }, claim: claim as any }, cases: [{ ref: d1, supports: true, campaignId: 'c1', at: '2026-10-01' }] },
          { op: 'ADD', why: 'w', lesson: { type: 'action_effect', statement: 'When ABO…', scope: { audience: 'prospecting' }, claim: claim as any }, cases: [{ ref: d1, supports: true, campaignId: 'c1', at: '2026-10-01' }] },
          { op: 'ADD', why: 'w', lesson: { type: 'segment_fact', statement: 'x', scope: {}, claim: { kind: 'measured', metric: 'cvr' } }, cases: [{ ref: 'D-nope', supports: true, campaignId: 'c1', at: '2026-10-01' }] },
          { op: 'EDIT', why: 'w', lessonId: 'L-1', lesson: { statement: 'sharper' } },
        ],
      },
    });
    const r = await svc.curate('2026-10-26');
    expect(r.week).toBe(isoWeek('2026-10-26'));
    expect(r.proposals.map((p) => p.status)).toEqual(['invalid', 'applied', 'invalid', 'pending']);
    expect(r.proposals[0].validation.problems[0]).toContain('not a clean graded record');
    expect(r.proposals[1].lessonId).toBe('L-2');
    expect((await m.lessons.findOne({ lessonId: 'L-2' }).lean<any>()).status).toBe('candidate');

    const edit = r.proposals[3];
    await svc.approve(edit.proposalId);
    const l1 = await m.lessons.findOne({ lessonId: 'L-1' }).lean<any>();
    expect([l1.statement, l1.version]).toEqual(['sharper', 2]);
  });

  it('keeps owner rules', async () => {
    const r = await svc.createOwnerRule({ text: 'Never pause before day 3', active: true, check: { kind: 'no_pause_before_days', days: 3 } });
    expect(r.ruleId).toBe('R-1');
    expect((await svc.updateOwnerRule('R-1', { check: null })).check).toBeUndefined();
    expect(await svc.deleteOwnerRule('R-1')).toEqual({ ruleId: 'R-1', deleted: true });
  });

  it('labels ISO weeks', () => {
    expect(isoWeek('2026-10-26')).toBe('2026-W44');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
  });
});
