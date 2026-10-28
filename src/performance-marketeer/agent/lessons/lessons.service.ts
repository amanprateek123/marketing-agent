import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { Model } from 'mongoose';
import { z } from 'zod';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { istDayFromToday } from '../../pm.logic';
import {
  PmDecisionRecord as DecisionModel,
  PmDiagnosisCheck as CheckModel,
  PmOutcomeRecord as OutcomeModel,
} from '../../schemas/pm-lesson-records.schema';
import {
  PmLessonDoc,
  PmLessonEventDoc,
  PmLessonEventKind,
  PmLessonProposalDoc,
  PmOwnerRuleDoc,
} from '../../schemas/pm-lessons.schema';
import type { PmPhase } from '../pm-agent.types';
import { PmCalendarTools } from '../tools/calendar.tools';
import type { PmToolDef } from '../tools/pm-tool';
import { CuratorEvidence, runCurator } from './curator';
import { CURATOR_SYSTEM_PROMPT, curatorUserMessage } from './curator.prompt';
import {
  actionMatches,
  confidenceOf,
  hitRate,
  matchScope,
  meetsBar,
  nextStatus,
  PM_LESSON_TYPES,
  rankLessons,
  renderLessonsMarkdown,
  selectForPhase,
  supportFromCheck,
  supportFromOutcome,
  validateProposal,
} from './lessons.logic';
import {
  PmDecisionRecord,
  PmDiagnosisCheck,
  PmLesson,
  PmLessonCase,
  PmLessonClaim,
  PmLessonProposal,
  PmLessonScope,
  PmLessonStatus,
  PmLessonType,
  PmOutcomeRecord,
  PmOwnerRule,
  PmSituation,
} from './lessons.types';
import { PmRecordsService } from './records.service';

type By = 'code' | 'curator' | 'user';
type Graded = { d: PmDecisionRecord; o: PmOutcomeRecord };

const CLEAN = ['worked', 'no_effect', 'hurt'];
const NO_ID = { _id: 0, __v: 0, tenantId: 0, createdAt: 0, updatedAt: 0 };
const LESSON_FIELDS = { _id: 0, __v: 0, tenantId: 0, updatedAt: 0 };
const REVIEW_AFTER_DAYS = 56;
const day = (s: string | Date | undefined) => (s ? new Date(s).toISOString().slice(0, 10) : '');
const num = (id: string) => Number(id.replace(/^\D+-?/, '').split('-').pop()) || 0;

/** ISO week label of a YYYY-MM-DD, e.g. 2026-W44. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/**
 * Lessons core (docs/performance-marketeer/10-lessons.md): picks lessons for
 * each phase, gives phases read-only lesson tools, scores lessons daily from
 * graded records (code only), runs the weekly curator and applies its deltas
 * after code checks, and the review actions behind the dashboard.
 */
@Injectable()
export class PmLessonsService {
  private readonly logger = new Logger(PmLessonsService.name);
  readonly root = resolve(process.env.PM_AGENT_DIR || join(process.cwd(), 'var', 'pm-agent'));

  constructor(
    @InjectModel(PmLessonDoc.name) private readonly lessons: Model<PmLessonDoc>,
    @InjectModel(PmLessonEventDoc.name) private readonly events: Model<PmLessonEventDoc>,
    @InjectModel(PmLessonProposalDoc.name) private readonly proposals: Model<PmLessonProposalDoc>,
    @InjectModel(PmOwnerRuleDoc.name) private readonly rules: Model<PmOwnerRuleDoc>,
    @InjectModel(DecisionModel.name) private readonly decisions: Model<DecisionModel>,
    @InjectModel(OutcomeModel.name) private readonly outcomes: Model<OutcomeModel>,
    @InjectModel(CheckModel.name) private readonly checks: Model<CheckModel>,
    private readonly records: PmRecordsService,
    private readonly calendar: PmCalendarTools,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  private get t() {
    return this.env.tenantId;
  }

  // ------------------------------------------------------------ reading

  private async all(filter: Record<string, unknown> = {}): Promise<PmLesson[]> {
    return this.lessons.find({ tenantId: this.t, ...filter }, LESSON_FIELDS).sort({ lessonId: 1 }).lean<PmLesson[]>();
  }

  private activeRules(): Promise<PmOwnerRule[]> {
    return this.rules.find({ tenantId: this.t, active: true }, NO_ID).sort({ ruleId: 1 }).lean<PmOwnerRule[]>();
  }

  /** The lessons + owner rules a phase gets, and the brief's markdown block. */
  async forPhase(phase: PmPhase, situation: PmSituation) {
    const [active, ownerRules] = await Promise.all([this.all({ status: 'active' }), this.activeRules()]);
    const lessons = selectForPhase(active, phase, situation);
    return { lessons, ownerRules, markdown: renderLessonsMarkdown(lessons, ownerRules, phase, active.length) };
  }

  private lessonRow = (l: PmLesson) => ({
    lessonId: l.lessonId,
    type: l.type,
    status: l.status,
    statement: l.statement,
    because: l.because,
    scope: l.scope,
    claim: l.claim,
    n: l.cases.length,
    supporting: l.cases.filter((c) => c.supports).length,
    confidence: l.confidence,
    uses: l.uses,
    hitRate: hitRate(l),
  });

  private async search(a: { type?: PmLessonType; tag?: string; text?: string; status?: PmLessonStatus }) {
    const tag = a.tag?.toLowerCase();
    const text = a.text?.toLowerCase();
    return (await this.all(a.status ? { status: a.status } : {}))
      .filter((l) => !a.type || l.type === a.type)
      .filter(
        (l) => !tag || Object.entries(l.scope).some(([k, v]) => k.toLowerCase() === tag || v.toLowerCase().split('|').includes(tag)),
      )
      .filter((l) => !text || `${l.statement} ${l.because ?? ''}`.toLowerCase().includes(text))
      .map(this.lessonRow);
  }

  /** Read-only tools for the phase agents. */
  defs(): PmToolDef[] {
    return [
      {
        name: 'lessons',
        description:
          'Search the ACTIVE lessons (learned from measured past outcomes) by type, scope tag (a scope key or value, e.g. "ABO", "pitru-paksha", "ctr_drop") or text. ' +
          'Returns id, statement, scope, n cases, confidence and hit rate. Lessons are priors, not rules: check them against today’s data.',
        shape: {
          type: z.enum(PM_LESSON_TYPES as [PmLessonType, ...PmLessonType[]]).optional(),
          tag: z.string().max(60).optional(),
          text: z.string().max(100).optional(),
        },
        run: async (a: { type?: PmLessonType; tag?: string; text?: string }) => this.search({ ...a, status: 'active' }),
      },
      {
        name: 'owner_rules',
        description: 'All active owner rules: standing instructions from the owner. These are rules, not priors.',
        shape: {},
        run: async () => this.activeRules(),
      },
    ];
  }

  /** Extra read-only tools only the curator gets. */
  private curatorOwnDefs(since: string): PmToolDef[] {
    return [
      {
        name: 'all_lessons',
        description: 'Every lesson in any status (candidate, active, review, retired) with its cases, scope and claim. Filter by status/type/tag/text.',
        shape: {
          status: z.enum(['candidate', 'active', 'review', 'retired']).optional(),
          type: z.enum(PM_LESSON_TYPES as [PmLessonType, ...PmLessonType[]]).optional(),
          tag: z.string().max(60).optional(),
          text: z.string().max(100).optional(),
        },
        run: async (a: { status?: PmLessonStatus; type?: PmLessonType; tag?: string; text?: string }) => {
          const rows = await this.search(a);
          const cases = new Map((await this.all()).map((l) => [l.lessonId, l.cases]));
          return rows.map((r) => ({ ...r, cases: cases.get(r.lessonId) }));
        },
      },
      {
        name: 'lesson_notes',
        description:
          'Since the last curator week: lessons the daily analysts said today’s data contradicted (with their evidence and note), and proposals the owner approved or rejected (with notes).',
        shape: {},
        run: async () => {
          const from = new Date(`${since}T00:00:00Z`);
          const [used, decided] = await Promise.all([
            this.events.find({ tenantId: this.t, kind: 'used', 'payload.contradicted': { $exists: true }, at: { $gte: from } }, { _id: 0, lessonId: 1, payload: 1, at: 1 }).lean(),
            this.proposals.find({ tenantId: this.t, status: { $in: ['approved', 'rejected'] }, decidedAt: { $gte: since } }, { _id: 0, proposalId: 1, op: 1, lessonId: 1, status: 1, decidedNote: 1, why: 1 }).lean(),
          ]);
          return { contradictions: used, decidedProposals: decided };
        },
      },
    ];
  }

  // ------------------------------------------------------------ writing helpers

  private event(lessonId: string, kind: PmLessonEventKind, by: By, payload: Record<string, unknown> = {}) {
    return this.events.create({ tenantId: this.t, lessonId, kind, by, payload, at: new Date() });
  }

  private async nextLessonId(): Promise<string> {
    const ids = await this.lessons.find({ tenantId: this.t }, { lessonId: 1 }).lean();
    return `L-${Math.max(0, ...ids.map((x) => num(x.lessonId))) + 1}`;
  }

  private async nextProposalId(week: string): Promise<string> {
    const ids = await this.proposals.find({ tenantId: this.t, week }, { proposalId: 1 }).lean();
    return `P-${week}-${Math.max(0, ...ids.map((x) => num(x.proposalId))) + 1}`;
  }

  private save(l: PmLesson) {
    const { lessonId, ...rest } = l;
    return this.lessons.updateOne({ tenantId: this.t, lessonId }, { $set: rest });
  }

  private async mustLesson(lessonId: string): Promise<PmLesson> {
    const l = await this.lessons.findOne({ tenantId: this.t, lessonId }, LESSON_FIELDS).lean<PmLesson>();
    if (!l) throw new NotFoundException(`Lesson ${lessonId} not found`);
    return l;
  }

  // ------------------------------------------------------------ daily (code only)

  /** After a campaign run: which lessons the phases used / found contradicted (notes go to the curator). */
  async recordRun(runDate: string, campaignId: string, used: string[], contradicted: { id: string; evidence: string[]; note: string }[]) {
    const ids = [...new Set([...used, ...contradicted.map((c) => c.id)])];
    const known = new Set((await this.lessons.find({ tenantId: this.t, lessonId: { $in: ids } }, { lessonId: 1 }).lean()).map((l) => l.lessonId));
    const against = new Map(contradicted.map((c) => [c.id, c]));
    await Promise.all(
      ids
        .filter((id) => known.has(id))
        .map((id) => {
          const c = against.get(id);
          return this.event(id, 'used', 'code', {
            runDate,
            campaignId,
            ...(c ? { contradicted: { evidence: c.evidence, note: c.note } } : {}),
          });
        }),
    );
  }

  /** Settled, clean, gradeable outcomes joined to their decisions, graded up to `date`. */
  private async graded(date: string): Promise<Graded[]> {
    // ponytail: full scan of the tenant's records (~30/week); filter by gradedAt in the query past ~10k rows.
    const [ds, os] = await Promise.all([
      this.decisions.find({ tenantId: this.t }).lean<PmDecisionRecord[]>(),
      this.outcomes.find({ tenantId: this.t, read: 'settled' }).lean<PmOutcomeRecord[]>(),
    ]);
    const byId = new Map(ds.map((d) => [d.decisionId, d]));
    return os
      .filter((o) => day(o.gradedAt) <= date && !o.weak && CLEAN.includes(o.verdict))
      .flatMap((o) => {
        const d = byId.get(o.decisionId);
        return d && d.taken !== 'not_taken' ? [{ d, o }] : [];
      });
  }

  private async cleanChecks(date: string): Promise<PmDiagnosisCheck[]> {
    const cs = await this.checks.find({ tenantId: this.t, result: { $ne: 'unclear' } }).lean<PmDiagnosisCheck[]>();
    return cs.filter((c) => day(c.checkedAt) <= date);
  }

  /**
   * Daily scoring by code: attach code-computed cases (from claims), count
   * hits/misses of lessons cited in decisions and diagnosis checks, recompute
   * confidence, apply the lifecycle and propose promotions. Idempotent: a
   * case or hit/miss is counted once per (lesson, record).
   */
  async scoreDaily(date: string) {
    const [lessons, graded, checks, scored] = await Promise.all([
      this.all({ status: { $ne: 'retired' } }),
      this.graded(date),
      this.cleanChecks(date),
      this.events.find({ tenantId: this.t, kind: { $in: ['hit', 'miss'] } }, { lessonId: 1, payload: 1 }).lean(),
    ]);
    const done = new Set(scored.map((e) => `${e.lessonId}|${String(e.payload?.ref)}`));
    const sum = { attached: 0, hits: 0, misses: 0, statusChanges: 0, promotions: 0 };

    for (const l of lessons) {
      const before = JSON.stringify([l.cases.length, l.uses, l.confidence, l.status]);
      const have = new Set(l.cases.map((c) => c.ref));
      const attach = async (c: PmLessonCase) => {
        if (have.has(c.ref)) return;
        have.add(c.ref);
        l.cases.push(c);
        sum.attached++;
        await this.event(l.lessonId, 'attached', 'code', { ...c });
      };
      const score = async (ref: string, hit: boolean) => {
        if (done.has(`${l.lessonId}|${ref}`)) return;
        done.add(`${l.lessonId}|${ref}`);
        l.uses++;
        if (hit) l.hits++;
        hit ? sum.hits++ : sum.misses++;
        await this.event(l.lessonId, hit ? 'hit' : 'miss', 'code', { ref });
      };
      for (const { d, o } of graded) {
        const s = supportFromOutcome(l, d, o);
        if (s !== null) await attach({ ref: d.decisionId, supports: s, campaignId: d.campaignId, at: d.date });
        if (d.lessonIds?.includes(l.lessonId)) await score(d.decisionId, s ?? o.verdict === 'worked');
      }
      for (const c of checks) {
        const s = supportFromCheck(l, c);
        if (s !== null) await attach({ ref: c.checkId, supports: s, campaignId: c.campaignId, at: c.runDate });
        if (c.lessonIds?.includes(l.lessonId)) await score(c.checkId, s ?? c.result === 'held');
      }
      l.confidence = confidenceOf(l.cases);
      const status = nextStatus(l, date);
      if (status !== l.status) {
        sum.statusChanges++;
        await this.event(l.lessonId, status === 'retired' ? 'retired' : 'status_change', 'code', { from: l.status, to: status, date });
        l.status = status;
      }
      if (JSON.stringify([l.cases.length, l.uses, l.confidence, l.status]) !== before) await this.save(l);
      if (l.status === 'candidate' && meetsBar(l) && (await this.proposePromotion(l, date))) sum.promotions++;
    }
    this.logger.log(`lessons scored ${date}: ${JSON.stringify(sum)}`);
    return sum;
  }

  /** A pending PROMOTE proposal for a candidate that meets the bar (once; again after a rejection only with more cases). */
  private async proposePromotion(l: PmLesson, date: string): Promise<boolean> {
    const prior = await this.proposals.find({ tenantId: this.t, op: 'PROMOTE', lessonId: l.lessonId }).lean();
    if (prior.some((p) => p.status === 'pending')) return false;
    if (prior.some((p) => (p.lesson?.cases?.length ?? 0) >= l.cases.length)) return false;
    const problems = validateProposal({ op: 'PROMOTE', lessonId: l.lessonId }, { lessons: await this.all(), knownIds: new Set(), measureIds: new Set() });
    if (problems.length) return false; // e.g. at the cap: retire or merge first
    const week = isoWeek(date);
    const proposalId = await this.nextProposalId(week);
    await this.proposals.create({
      tenantId: this.t,
      proposalId,
      week,
      op: 'PROMOTE',
      lessonId: l.lessonId,
      lesson: { cases: l.cases, confidence: l.confidence },
      why: `Meets the evidence bar: ${l.cases.filter((c) => c.supports).length} of ${l.cases.length} clean cases support it.`,
      validation: { ok: true, problems: [] },
      status: 'pending',
    });
    await this.event(l.lessonId, 'proposed', 'code', { proposalId, op: 'PROMOTE' });
    return true;
  }

  // ------------------------------------------------------------ weekly curator

  /**
   * The weekly curator (Opus): reads records and lessons through tools,
   * returns itemised deltas; code validates and confirms each. ADD → new
   * candidate; ATTACH → applied; EDIT/MERGE/RETIRE of candidates → applied,
   * of active/review lessons → pending for you; invalid ones kept with problems.
   */
  async curate(weekDate: string) {
    const week = isoWeek(weekDate);
    const since = addDays(weekDate, -7);
    const dir = join(this.root, 'lessons', week);
    mkdirSync(dir, { recursive: true });
    const evidence = new CuratorEvidence(join(dir, 'evidence.jsonl'));
    const model = process.env.PM_MODEL_CURATOR ?? 'claude-opus-5-5';
    const run = await runCurator({
      model,
      systemPrompt: CURATOR_SYSTEM_PROMPT,
      userMessage: curatorUserMessage(week, since, weekDate),
      tools: [...this.records.curatorDefs(), ...this.defs(), ...this.curatorOwnDefs(since)],
      tenantId: this.t,
      week,
      date: weekDate,
      dir,
      evidence,
      file: join(dir, 'curator.md'),
    });
    const existing = await this.proposals.find({ tenantId: this.t, week, op: { $ne: 'PROMOTE' } }, NO_ID).lean();
    if (run.reused && existing.length) return { week, costUsd: 0, proposals: existing };

    const [graded, checks, decisionIds] = await Promise.all([
      this.graded(weekDate),
      this.cleanChecks(weekDate),
      this.decisions.find({ tenantId: this.t }, { decisionId: 1 }).lean(),
    ]);
    const ev = evidence.read();
    const knownIds = new Set([...decisionIds.map((d) => d.decisionId), ...checks.map((c) => c.checkId), ...ev.map((e) => e.id)]);
    const allChecks = await this.checks.find({ tenantId: this.t }, { checkId: 1 }).lean();
    allChecks.forEach((c) => knownIds.add(c.checkId));
    const measureIds = new Set(ev.filter((e) => e.tool.startsWith('measure_')).map((e) => e.id));

    const out: PmLessonProposal[] = [];
    for (const delta of run.output.deltas) {
      const lessons = await this.all();
      const p: PmLessonProposal = {
        proposalId: await this.nextProposalId(week),
        week,
        op: delta.op,
        lesson: delta.lesson as Partial<PmLesson> | undefined,
        lessonId: delta.lessonId,
        mergeIds: delta.mergeIds,
        cases: delta.cases,
        why: delta.why,
        validation: { ok: true, problems: [] },
        status: 'pending',
      };
      const problems = validateProposal(p, { lessons, knownIds, measureIds });
      if (!problems.length && (p.op === 'ADD' || p.op === 'ATTACH')) {
        const subject = p.op === 'ADD' ? (p.lesson as PmLesson) : lessons.find((l) => l.lessonId === p.lessonId)!;
        problems.push(...this.confirmCases(subject, p.cases ?? [], graded, checks));
      }
      p.validation = { ok: !problems.length, problems };
      const targets = [p.lessonId, ...(p.mergeIds ?? [])].map((id) => lessons.find((l) => l.lessonId === id)).filter(Boolean) as PmLesson[];
      const needsYou = (p.op === 'EDIT' || p.op === 'MERGE' || p.op === 'RETIRE') && targets.some((l) => l.status !== 'candidate');
      p.status = problems.length ? 'invalid' : needsYou ? 'pending' : 'applied';
      if (p.status === 'applied') p.lessonId = await this.apply(p, 'curator', weekDate);
      await this.proposals.create({ tenantId: this.t, ...p, ...(p.status === 'applied' ? { decidedAt: weekDate } : {}) });
      await this.event(p.lessonId ?? '', 'proposed', 'curator', { proposalId: p.proposalId, op: p.op, status: p.status, problems });
      out.push(p);
    }
    this.logger.log(`curator ${week}: ${out.length} deltas, ${out.filter((p) => p.status === 'invalid').length} invalid, $${run.costUsd.toFixed(2)}`);
    return { week, costUsd: run.costUsd, proposals: out };
  }

  /** Code recount of cited record cases: a D-/DC- case must count for the claim with the same direction. */
  private confirmCases(l: Pick<PmLesson, 'claim' | 'scope'>, cases: PmLessonCase[], graded: Graded[], checks: PmDiagnosisCheck[]): string[] {
    const g = new Map(graded.map((x) => [x.d.decisionId, x]));
    const ch = new Map(checks.map((c) => [c.checkId, c]));
    return cases.flatMap((c) => {
      if (c.ref.startsWith('cev-')) return []; // measured evidence: counted as cited
      const x = g.get(c.ref);
      const k = ch.get(c.ref);
      const s = x ? supportFromOutcome(l, x.d, x.o) : k ? supportFromCheck(l, k) : null;
      if (s === null) return [`case ${c.ref} is not a clean graded record for this claim and scope`];
      return s === c.supports ? [] : [`case ${c.ref}: code says supports=${s}`];
    });
  }

  /** Apply a validated proposal; returns the lesson id it touched or created. */
  private async apply(p: PmLessonProposal, by: By, today: string): Promise<string | undefined> {
    const draft = p.lesson ?? {};
    switch (p.op) {
      case 'ADD': {
        const lessonId = await this.nextLessonId();
        const cases = p.cases ?? draft.cases ?? [];
        await this.lessons.create({
          tenantId: this.t,
          lessonId,
          type: draft.type,
          statement: draft.statement,
          because: draft.because,
          scope: draft.scope ?? {},
          claim: draft.claim,
          status: 'candidate',
          cases,
          confidence: confidenceOf(cases),
          uses: 0,
          hits: 0,
          version: 1,
          createdAt: today,
        });
        await this.event(lessonId, 'applied', by, { proposalId: p.proposalId, op: 'ADD' });
        return lessonId;
      }
      case 'ATTACH': {
        const l = await this.mustLesson(p.lessonId!);
        l.cases.push(...(p.cases ?? []));
        l.confidence = confidenceOf(l.cases);
        await this.save(l);
        for (const c of p.cases ?? []) await this.event(l.lessonId, 'attached', by, { ...c, proposalId: p.proposalId });
        return l.lessonId;
      }
      case 'EDIT': {
        const l = await this.mustLesson(p.lessonId!);
        const patch = pick(draft, ['statement', 'because', 'scope', 'claim']);
        await this.lessons.updateOne({ tenantId: this.t, lessonId: l.lessonId }, { $set: { ...patch, version: l.version + 1 } });
        await this.event(l.lessonId, 'edited', by, { proposalId: p.proposalId, before: pick(l, Object.keys(patch) as (keyof PmLesson)[]), after: patch });
        return l.lessonId;
      }
      case 'MERGE': {
        const sources = await Promise.all((p.mergeIds ?? []).map((id) => this.mustLesson(id)));
        const cases = [...new Map(sources.flatMap((s) => s.cases).map((c) => [c.ref, c])).values()];
        const lessonId = await this.nextLessonId();
        const wasActive = sources.some((s) => s.status !== 'candidate');
        await this.lessons.create({
          tenantId: this.t,
          lessonId,
          type: sources[0].type,
          statement: draft.statement,
          because: draft.because,
          scope: draft.scope ?? {},
          claim: draft.claim ?? sources[0].claim,
          status: wasActive ? 'active' : 'candidate',
          cases,
          confidence: confidenceOf(cases),
          uses: sources.reduce((n, s) => n + s.uses, 0),
          hits: sources.reduce((n, s) => n + s.hits, 0),
          version: 1,
          createdAt: today,
          ...(wasActive ? { approvedAt: today, reviewBy: addDays(today, REVIEW_AFTER_DAYS) } : {}),
        });
        for (const s of sources) {
          await this.lessons.updateOne({ tenantId: this.t, lessonId: s.lessonId }, { $set: { status: 'retired' } });
          await this.event(s.lessonId, 'merged', by, { into: lessonId, proposalId: p.proposalId });
        }
        return lessonId;
      }
      case 'RETIRE':
        await this.lessons.updateOne({ tenantId: this.t, lessonId: p.lessonId }, { $set: { status: 'retired' } });
        await this.event(p.lessonId!, 'retired', by, { proposalId: p.proposalId, why: p.why });
        return p.lessonId;
      case 'PROMOTE':
        await this.lessons.updateOne(
          { tenantId: this.t, lessonId: p.lessonId },
          { $set: { status: 'active', approvedAt: today, reviewBy: addDays(today, REVIEW_AFTER_DAYS) } },
        );
        await this.event(p.lessonId!, 'status_change', by, { from: 'candidate', to: 'active', proposalId: p.proposalId });
        return p.lessonId;
    }
  }

  // ------------------------------------------------------------ your review (dashboard)

  private async pending(proposalId: string) {
    const p = await this.proposals.findOne({ tenantId: this.t, proposalId }, NO_ID).lean<PmLessonProposal>();
    if (!p) throw new NotFoundException(`Proposal ${proposalId} not found`);
    if (p.status !== 'pending') throw new NotFoundException(`Proposal ${proposalId} is ${p.status}, not pending`);
    return p;
  }

  /** Approve a pending proposal; re-checked first since lessons may have changed. */
  async approve(proposalId: string, note?: string) {
    const p = await this.pending(proposalId);
    const today = istDayFromToday();
    // Pending ops (PROMOTE, EDIT/MERGE/RETIRE) cite no new cases: only lesson state is re-checked.
    const problems = validateProposal(p, { lessons: await this.all(), knownIds: new Set(), measureIds: new Set() });
    if (problems.length) {
      await this.proposals.updateOne({ tenantId: this.t, proposalId }, { $set: { status: 'invalid', validation: { ok: false, problems }, decidedAt: today } });
      return { proposalId, status: 'invalid' as const, problems };
    }
    const lessonId = await this.apply(p, 'user', today);
    await this.proposals.updateOne({ tenantId: this.t, proposalId }, { $set: { status: 'approved', decidedAt: today, decidedNote: note, lessonId } });
    await this.event(lessonId ?? '', 'approved', 'user', { proposalId, note });
    return { proposalId, status: 'approved' as const, lessonId };
  }

  async reject(proposalId: string, note: string) {
    const p = await this.pending(proposalId);
    await this.proposals.updateOne({ tenantId: this.t, proposalId }, { $set: { status: 'rejected', decidedAt: istDayFromToday(), decidedNote: note } });
    await this.event(p.lessonId ?? '', 'rejected', 'user', { proposalId, note });
    return { proposalId, status: 'rejected' as const };
  }

  /** Your edit of a lesson: version + 1, audited. */
  async editLesson(lessonId: string, patch: { statement?: string; because?: string; scope?: PmLessonScope }) {
    const l = await this.mustLesson(lessonId);
    await this.lessons.updateOne({ tenantId: this.t, lessonId }, { $set: { ...patch, version: l.version + 1 } });
    await this.event(lessonId, 'edited', 'user', { before: pick(l, Object.keys(patch) as (keyof PmLesson)[]), after: patch });
    return this.mustLesson(lessonId);
  }

  async retire(lessonId: string, note: string) {
    const l = await this.mustLesson(lessonId);
    await this.lessons.updateOne({ tenantId: this.t, lessonId }, { $set: { status: 'retired' } });
    await this.event(lessonId, 'retired', 'user', { from: l.status, note });
    return { lessonId, status: 'retired' as const };
  }

  listLessons(filter: { status?: PmLessonStatus; type?: PmLessonType } = {}) {
    const q: Record<string, unknown> = {};
    if (filter.status) q.status = filter.status;
    if (filter.type) q.type = filter.type;
    return this.all(q).then((ls) => ls.map((l) => ({ ...l, hitRate: hitRate(l) })));
  }

  listProposals(status?: string) {
    return this.proposals
      .find({ tenantId: this.t, ...(status ? { status } : {}) }, { _id: 0, __v: 0, tenantId: 0, updatedAt: 0 })
      .sort({ createdAt: -1 })
      .lean();
  }

  // ------------------------------------------------------------ owner rules

  ownerRules(): Promise<PmOwnerRule[]> {
    return this.rules.find({ tenantId: this.t }, NO_ID).sort({ ruleId: 1 }).lean<PmOwnerRule[]>();
  }

  async createOwnerRule(r: Omit<PmOwnerRule, 'ruleId'>): Promise<PmOwnerRule> {
    const ids = await this.rules.find({ tenantId: this.t }, { ruleId: 1 }).lean();
    const ruleId = `R-${Math.max(0, ...ids.map((x) => num(x.ruleId))) + 1}`;
    await this.rules.create({ tenantId: this.t, ruleId, ...r });
    return { ruleId, ...r };
  }

  async updateOwnerRule(ruleId: string, patch: Partial<Omit<PmOwnerRule, 'check'>> & { check?: PmOwnerRule['check'] | null }) {
    const { check, ...rest } = patch;
    const update: Record<string, unknown> = { $set: { ...rest, ...(check ? { check } : {}) } };
    if (check === null) update.$unset = { check: 1 };
    const r = await this.rules.findOneAndUpdate({ tenantId: this.t, ruleId }, update, { returnDocument: 'after', projection: NO_ID }).lean<PmOwnerRule>();
    if (!r) throw new NotFoundException(`Owner rule ${ruleId} not found`);
    return r;
  }

  async deleteOwnerRule(ruleId: string) {
    const r = await this.rules.deleteOne({ tenantId: this.t, ruleId });
    if (!r.deletedCount) throw new NotFoundException(`Owner rule ${ruleId} not found`);
    return { ruleId, deleted: true };
  }

  // ------------------------------------------------------------ is it working?

  /**
   * Weekly scorecard over decisions dated in the last `weeks` ISO weeks.
   * realisedRupees = Σ diffInDiff.roas × after.spend over clean graded
   * changes: revenue gained (or lost) vs the baseline during the after
   * window. Rough — overlapping changes on one campaign are not separated.
   */
  async scorecard(weeks = 8) {
    const today = istDayFromToday();
    const from = addDays(today, -7 * weeks);
    const [ds, os, cs, lessons] = await Promise.all([
      this.decisions.find({ tenantId: this.t, date: { $gte: from } }).lean<PmDecisionRecord[]>(),
      this.outcomes.find({ tenantId: this.t, read: 'settled' }).lean<PmOutcomeRecord[]>(),
      this.checks.find({ tenantId: this.t, runDate: { $gte: from } }).lean<PmDiagnosisCheck[]>(),
      this.all({ status: { $in: ['active', 'review'] } }),
    ]);
    const outcome = new Map(os.map((o) => [o.decisionId, o]));
    const rows = new Map<string, ReturnType<typeof emptyWeek>>();
    const row = (w: string) => rows.get(w) ?? rows.set(w, emptyWeek(w)).get(w)!;
    for (const d of ds) {
      const w = row(isoWeek(d.date));
      if (d.source === 'recommended') {
        w.acceptance.recommended++;
        if (d.taken === 'taken' || d.taken === 'partly') w.acceptance.taken++;
      }
      const o = outcome.get(d.decisionId);
      if (!o || o.weak || !CLEAN.includes(o.verdict) || d.taken === 'not_taken') continue;
      const a = (w.byActionType[d.type] ??= { n: 0, worked: 0, rate: 0 });
      a.n++;
      if (o.verdict === 'worked') a.worked++;
      if (o.insidePredictedRange !== null) {
        w.calibration.n++;
        if (o.insidePredictedRange) w.calibration.inside++;
      }
      if (o.diffInDiff.roas !== null) w.realisedRupees += o.diffInDiff.roas * o.after.spend;
    }
    for (const c of cs) {
      if (c.result === 'unclear') continue;
      const w = row(isoWeek(c.runDate));
      w.diagnosis.n++;
      if (c.result === 'held') w.diagnosis.held++;
    }
    const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 100) / 100 : null);
    return {
      from,
      to: today,
      weeks: [...rows.values()]
        .sort((a, b) => a.week.localeCompare(b.week))
        .map((w) => {
          for (const a of Object.values(w.byActionType)) a.rate = ratio(a.worked, a.n) ?? 0;
          return {
            ...w,
            realisedRupees: Math.round(w.realisedRupees),
            calibration: { ...w.calibration, share: ratio(w.calibration.inside, w.calibration.n) },
            acceptance: { ...w.acceptance, share: ratio(w.acceptance.taken, w.acceptance.recommended) },
            diagnosis: { ...w.diagnosis, accuracy: ratio(w.diagnosis.held, w.diagnosis.n) },
          };
        }),
      lessons: lessons.map((l) => ({ lessonId: l.lessonId, type: l.type, status: l.status, uses: l.uses, hits: l.hits, hitRate: hitRate(l) })),
      notes:
        'Hit rate = worked share of clean settled outcomes of taken/outside changes. realisedRupees = Σ diff-in-diff ROAS × after-window spend (rough, overlapping changes not separated).',
    };
  }

  // ------------------------------------------------------------ helpers for the pipeline code

  /** Worked share by action type over all clean settled outcomes. */
  async actionTypeHitRates(): Promise<Record<string, { n: number; worked: number; rate: number }>> {
    const out: Record<string, { n: number; worked: number; rate: number }> = {};
    for (const { d, o } of await this.graded(istDayFromToday())) {
      const a = (out[d.type] ??= { n: 0, worked: 0, rate: 0 });
      a.n++;
      if (o.verdict === 'worked') a.worked++;
      a.rate = a.worked / a.n;
    }
    return out;
  }

  /** How often each cause category held up (diagnosis checks, unclear excluded). */
  async causeCategoryAccuracy(): Promise<Record<string, { n: number; held: number }>> {
    const out: Record<string, { n: number; held: number }> = {};
    for (const c of await this.cleanChecks(istDayFromToday())) {
      const a = (out[c.category] ??= { n: 0, held: 0 });
      a.n++;
      if (c.result === 'held') a.held++;
    }
    return out;
  }

  /** The best-matching active action_effect lesson's measured effect for an action in a situation. */
  async effectFor(
    action: { type: string; field?: string; direction?: 'up' | 'down'; step?: number },
    situation: PmSituation,
  ): Promise<{ lessonId: string; effect: NonNullable<Extract<PmLessonClaim, { kind: 'action_effect' }>['effect']>; expect: string } | null> {
    const fits = (await this.all({ status: 'active', type: 'action_effect' })).filter(
      (l) =>
        l.claim.kind === 'action_effect' &&
        l.claim.effect &&
        matchScope(l.scope, situation) &&
        actionMatches(l.claim.action, { type: action.type, field: action.field ?? '', direction: action.direction, step: action.step }),
    );
    const best = rankLessons(fits)[0];
    if (!best || best.claim.kind !== 'action_effect' || !best.claim.effect) return null;
    return { lessonId: best.lessonId, effect: best.claim.effect, expect: best.claim.expect };
  }

  /** One-line warnings for active season_effect lessons whose season is on now or starts within 14 days. */
  async seasonWarnings(date: string): Promise<string[]> {
    const rows = this.calendar.query(date, addDays(date, 14), ['festival', 'astro_event', 'market_event'], undefined, date);
    const out: string[] = [];
    for (const l of await this.all({ status: 'active', type: 'season_effect' })) {
      const tags = (l.scope.season ?? '').toLowerCase().split('|').map((s) => s.trim()).filter(Boolean);
      const row = rows.find((r) => tags.some((t) => r.id === t || r.id.startsWith(`${t}-`)));
      if (!row) continue;
      const when = row.status === 'ongoing' ? 'is on now' : `starts in ${row.daysFromDate} days (${row.start})`;
      out.push(`${l.lessonId} · ${row.name} ${when}: ${l.statement}`);
    }
    return out;
  }
}

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Partial<T>;
}

function emptyWeek(week: string) {
  return {
    week,
    byActionType: {} as Record<string, { n: number; worked: number; rate: number }>,
    calibration: { n: 0, inside: 0 },
    acceptance: { recommended: 0, taken: 0 },
    realisedRupees: 0,
    diagnosis: { n: 0, held: 0 },
  };
}
