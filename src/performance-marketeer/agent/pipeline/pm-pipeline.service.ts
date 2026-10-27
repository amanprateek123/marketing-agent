import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { Model } from 'mongoose';
import { PmAnalysisService } from '../../analysis/pm-analysis.service';
import {
  PmEntityRow,
  PmMetrics,
  PmQuery,
} from '../../analysis/pm-analysis.types';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { PmAgentRun } from '../../schemas/pm-agent-run.schema';
import { PmLock } from '../../schemas/pm-lock.schema';
import { PmMetaEntity } from '../../schemas/pm-meta.schema';
import { PmCompetitorSync } from '../competitors/competitor.sync';
import { PmJournalService } from '../journal/journal.service';
import { PmLessonsService } from '../lessons/lessons.service';
import { PmRecordsService } from '../lessons/records.service';
import { PmSituationService } from '../lessons/situation.service';
import {
  Issue,
  PM_DAY_FILES,
  PM_FILES,
  PM_LOOP,
  PM_MODELS,
  PmJournalEntry,
  PmPhase,
} from '../pm-agent.types';
import { pmUserMessage, PM_SYSTEM_PROMPTS } from '../prompts/phase-prompts';
import { PmCalendarTools } from '../tools/calendar.tools';
import { PmCompetitorTools } from '../tools/competitors.tools';
import { PmCreativeTools } from '../tools/creatives.tools';
import { PmLandingTools } from '../tools/landing.tools';
import { PmDataTools } from '../tools/data.tools';
import { filesTools } from '../tools/files.tools';
import { mathsTools } from '../tools/maths.tools';
import { PmToolDef } from '../tools/pm-tool';
import {
  actionScore,
  CheckResult,
  decisionShape,
  FinalAction,
  finalActions,
  lessonsUsed,
  MergedCause,
  mergeCauses,
  mergeContradictions,
  runChecks,
  shouldSendBackInvestigation,
  shouldSendBackPlan,
  stopEarly,
  unresolvedOf,
} from './loop.logic';
import {
  EvidenceLog,
  PhaseOutput,
  PmPhaseError,
  readEvidence,
  runPhase,
  writePhaseFile,
} from './phase-runner';

const PHASES: PmPhase[] = ['investigate', 'verify', 'plan', 'plan_verify'];
const LEASE_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
/** A 'running' run whose heartbeat is older than this is dead (process killed). */
export const PM_RUN_STALE_MS = 30 * 60 * 1000;
/** Per-file cap when copying into PmAgentRun.files (Mongo documents max out at 16 MB). */
const MAX_FILE_CHARS = 3_000_000;
const envNum = (key: string, def: number) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export interface PmQueueItem {
  campaignId: string;
  name: string;
  product: string;
  spend7: number;
  firstPartyRoas7: number | null;
}
export interface PmCampaignResult {
  campaignId: string;
  /** skipped = another process (worker or CLI) is running this campaign/date. */
  status: 'done' | 'failed' | 'dry' | 'skipped';
  step: string;
  error?: string;
  actions: number;
  costUsd: number;
}

// ---------------------------------------------------------------- formatting

const inr = (n: number | null | undefined) =>
  n == null ? '–' : `₹${Math.round(n).toLocaleString('en-IN')}`;
const x2 = (n: number | null | undefined) => (n == null ? '–' : n.toFixed(2));
const pct = (n: number | null | undefined, d = 2) =>
  n == null ? '–' : `${(n * 100).toFixed(d)}%`;
const table = (head: string[], rows: (string | number)[][]) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(
      (r) =>
        `| ${r.map((c) => String(c).replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`,
    ),
  ].join('\n');
const metricsRow = (label: string, m: PmMetrics) => [
  label,
  inr(m.spend),
  inr(m.cpm),
  pct(m.ctr),
  x2(m.frequency),
  m.firstPartyOrders,
  inr(m.firstPartyRevenue),
  x2(m.firstPartyRoas),
  inr(m.firstPartyCpa),
  m.metaPurchases,
  x2(m.metaRoas),
];
const METRICS_HEAD = [
  'Window',
  'Spend',
  'CPM',
  'CTR',
  'Freq/day',
  '1P orders',
  '1P revenue',
  '1P ROAS',
  '1P CPA',
  'Meta purch.',
  'Meta ROAS',
];
const window = (date: string, days: number, product?: string): PmQuery => ({
  from: addDays(date, -days),
  to: addDays(date, -1),
  ...(product ? { product } : {}),
});

/**
 * Step 3 orchestrator (docs/performance-marketeer/09): day prep, queue, and
 * per campaign investigate ⇄ verify, plan ⇄ plan-verify, code checks and the
 * final actions file. Code, not a model, decides every send-back.
 */
@Injectable()
export class PmPipelineService {
  private readonly logger = new Logger(PmPipelineService.name);
  private readonly holder = randomUUID();
  readonly root = resolve(
    process.env.PM_AGENT_DIR || join(process.cwd(), 'var', 'pm-agent'),
  );

  constructor(
    private readonly analysis: PmAnalysisService,
    private readonly data: PmDataTools,
    private readonly creatives: PmCreativeTools,
    private readonly landing: PmLandingTools,
    private readonly competitors: PmCompetitorTools,
    private readonly competitorSync: PmCompetitorSync,
    private readonly calendar: PmCalendarTools,
    private readonly journal: PmJournalService,
    private readonly situations: PmSituationService,
    private readonly records: PmRecordsService,
    private readonly lessons: PmLessonsService,
    @InjectModel(PmAgentRun.name) private readonly runs: Model<PmAgentRun>,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmLock.name) private readonly locks: Model<PmLock>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  dayDir(date: string) {
    return join(this.root, 'day', date);
  }
  campaignRoot(campaignId: string) {
    return join(this.root, 'campaigns', campaignId);
  }
  campaignDir(campaignId: string, date: string) {
    return join(this.campaignRoot(campaignId), date);
  }

  // ---------------------------------------------------------------- day prep

  async prepareDay(date: string) {
    const dir = this.dayDir(date);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, PM_DAY_FILES.account),
      await this.accountMarkdown(date),
    );
    writeFileSync(
      join(dir, PM_DAY_FILES.festivals),
      await this.calendar.dayMarkdown(date),
    );
    let competitors: string;
    try {
      await this.competitorSync.syncDay(date);
      competitors = await this.competitorSync.dayMarkdown(date);
    } catch (e) {
      this.logger.warn(
        `competitors for ${date} unavailable: ${(e as Error).message}`,
      );
      competitors = `# Competitor ads — ${date}\n\nUnavailable: ${(e as Error).message}\n`;
    }
    writeFileSync(join(dir, PM_DAY_FILES.competitors), competitors);
    return dir;
  }

  private async accountMarkdown(date: string) {
    const [s7, s14, s30, trend, camps, warnings] = await Promise.all([
      this.analysis.summary(window(date, 7)),
      this.analysis.summary(window(date, 14)),
      this.analysis.summary(window(date, 30)),
      this.analysis.trend(window(date, 14)),
      this.analysis.entities(window(date, 7), 'campaign'),
      this.lessons.seasonWarnings(date),
    ]);
    const missing = s30.dataFreshness.missingDays;
    const f = s7.dataFreshness;
    return [
      `# Account health — run ${date} (data to ${addDays(date, -1)})`,
      '',
      'All covered products, all three ad accounts. 1P = first-party (our orders, device-matched to a Meta click ≤ 7 days, net ex-GST). Meta = Meta-reported.',
      '',
      table(METRICS_HEAD, [
        metricsRow(`7d ${s7.query.from}…${s7.query.to}`, s7.current),
        metricsRow(`prior 7d ${s7.previous.from}…${s7.previous.to}`, s7.prior),
        metricsRow(`14d ${s14.query.from}…`, s14.current),
        metricsRow(`30d ${s30.query.from}…`, s30.current),
      ]),
      '',
      `Verdict (7d): ${s7.target.verdict} (${s7.target.confidence}) — ${s7.target.note}`,
      `7d vs prior: spend ${pct(s7.change.spend, 0)}, CPM ${pct(s7.change.cpm, 0)}, CTR ${pct(s7.change.ctr, 0)}, 1P ROAS ${pct(s7.change.firstPartyRoas, 0)}`,
      '',
      '## Tracking / attribution',
      `- Confirmed web orders (7d) linked to a visit: ${pct(s7.attributionCoverage.linkedToVisit, 0)}, to a Meta ad: ${pct(s7.attributionCoverage.linkedToMetaAd, 0)}`,
      `- All confirmed orders 7d: ${s7.allOrders.orders} (${inr(s7.allOrders.revenue)}); Meta-attributed 1P: ${s7.current.firstPartyOrders}`,
      `- Data through: Meta ${f.metaThrough ?? '–'}, orders ${f.ordersThrough ?? '–'}, visitors ${f.visitorsThrough ?? '–'}`,
      `- Missing days (30d): Meta ${missing?.meta.join(', ') || 'none'}; orders ${missing?.orders.join(', ') || 'none'}; visitors ${missing?.visitors.join(', ') || 'none'}`,
      '',
      '## Season warnings (from lessons)',
      ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['None.']),
      '',
      '## Daily trend (14d)',
      table(
        [
          'Date',
          'Spend',
          'CPM',
          'CTR',
          'Freq/day',
          '1P orders',
          '1P ROAS',
          '7d roll. ROAS',
        ],
        trend.points.map((p, i) => [
          p.date,
          inr(p.spend),
          inr(p.cpm),
          pct(p.ctr),
          x2(p.frequency),
          p.firstPartyOrders,
          x2(p.firstPartyRoas),
          x2(trend.rollingRoas7[i]),
        ]),
      ),
      '',
      '## Campaigns (7d, by spend)',
      table(
        [
          'Campaign',
          'Id',
          'Product',
          'Status',
          'Spend',
          '1P orders',
          '1P ROAS',
          'Meta ROAS',
          'Verdict',
        ],
        camps.rows.map((r) => [
          r.name,
          r.id,
          r.product,
          r.effectiveStatus,
          inr(r.metrics.spend),
          r.metrics.firstPartyOrders,
          x2(r.metrics.firstPartyRoas),
          x2(r.metrics.metaRoas),
          r.target.verdict,
        ]),
      ),
      '',
    ].join('\n');
  }

  // ---------------------------------------------------------------- queue

  /**
   * Active campaigns (effective status ACTIVE, spend in the last 7 days) with
   * 7-day spend ≥ PM_AGENT_MIN_SPEND_7D, biggest first (Q-22 default). Above-
   * target campaigns stay in: they get scale plans (Q-27 default).
   */
  async queue(
    date: string,
    opts: { campaignIds?: string[]; limit?: number } = {},
  ): Promise<PmQueueItem[]> {
    const min = envNum('PM_AGENT_MIN_SPEND_7D', 3000);
    const { rows } = await this.analysis.entities(window(date, 7), 'campaign');
    let q = rows.filter(
      (r) =>
        r.effectiveStatus === 'ACTIVE' &&
        r.metrics.spend > 0 &&
        r.metrics.spend >= min,
    );
    if (opts.campaignIds?.length)
      q = q.filter((r) => opts.campaignIds!.includes(r.id));
    q.sort((a, b) => b.metrics.spend - a.metrics.spend);
    if (opts.limit) q = q.slice(0, opts.limit);
    return q.map((r: PmEntityRow) => ({
      campaignId: r.id,
      name: r.name,
      product: r.product,
      spend7: Math.round(r.metrics.spend),
      firstPartyRoas7: r.metrics.firstPartyRoas,
    }));
  }

  // ---------------------------------------------------------------- one campaign

  async runCampaign(
    date: string,
    campaignId: string,
    /** claimed: the caller (queue worker) already moved the run to 'running'. */
    opts: { dry?: boolean; claimed?: boolean } = {},
  ): Promise<PmCampaignResult> {
    const t = this.env.tenantId;
    const key = { tenantId: t, campaignId, date };
    let step = 'brief';
    let costUsd = 0;
    const setStep = async (s: string) => {
      step = s;
      this.logger.log(`[${campaignId} ${date}] ${s}`);
      if (!opts.dry)
        await this.runs.updateOne(key, {
          $set: { step: s, heartbeatAt: new Date() },
        });
    };
    if (!opts.dry && !opts.claimed && !(await this.claim(date, campaignId))) {
      this.logger.warn(`[${campaignId} ${date}] already running elsewhere`);
      return {
        campaignId,
        status: 'skipped',
        step: 'running elsewhere',
        actions: 0,
        costUsd: 0,
      };
    }
    // Phases can take longer than the stale window; keep the heartbeat fresh between steps.
    const beat = opts.dry
      ? undefined
      : setInterval(
          () =>
            void this.runs
              .updateOne(key, { $set: { heartbeatAt: new Date() } })
              .catch(() => undefined),
          HEARTBEAT_MS,
        );
    try {
      const camp = await this.entities
        .findOne({ tenantId: t, level: 'campaign', entityId: campaignId })
        .lean();
      if (!camp)
        throw new Error(`campaign ${campaignId} not in pm_meta_entities`);
      const dir = this.campaignDir(campaignId, date);
      mkdirSync(join(dir, PM_FILES.helpers), { recursive: true });
      if (!opts.dry)
        await this.runs.updateOne(key, {
          $set: {
            step,
            error: '',
            campaignName: camp.name,
            accountId: camp.accountId,
            product: camp.product,
            startedAt: new Date(),
            heartbeatAt: new Date(),
            finishedAt: null,
          },
        });
      const evidence = new EvidenceLog(join(dir, PM_FILES.evidence));
      const briefFile = join(dir, PM_FILES.brief);
      if (!existsSync(briefFile))
        writeFileSync(
          briefFile,
          await this.briefMarkdown(date, camp, evidence),
        );
      await setStep('journal');
      const journal = await this.journal.build(campaignId, date);
      const journalFile = join(dir, PM_FILES.journal);
      if (!existsSync(journalFile))
        writeFileSync(journalFile, journal.markdown);
      if (!opts.dry)
        await this.runs.updateOne(key, { $set: { journal: journal.entries } });

      // Lessons: one situation per run picks each phase's lessons (doc 10).
      await setStep('lessons');
      const situation = await this.situations.forCampaign(campaignId, date);
      const historyFile = join(dir, PM_FILES.history);
      writeFileSync(
        historyFile,
        await this.records.historyMarkdown(campaignId, date),
      );
      const lessonFiles = {} as Record<PmPhase, string>;
      for (const p of PHASES) {
        lessonFiles[p] = join(dir, PM_FILES.lessons(p));
        writeFileSync(
          lessonFiles[p],
          (await this.lessons.forPhase(p, situation)).markdown,
        );
      }
      if (!opts.dry) await this.runs.updateOne(key, { $set: { situation } });
      if (opts.dry)
        return { campaignId, status: 'dry', step, actions: 0, costUsd: 0 };

      const tools = this.tools();
      const written: string[] = [];
      const phase = async <P extends PmPhase>(
        p: P,
        round: number,
        model: string,
        verdict?: (o: PhaseOutput<P>) => 'pass' | 'send_back',
      ) => {
        await setStep(`${p} v${round}`);
        const file = join(dir, PM_FILES[p](round));
        const r = await runPhase({
          phase: p,
          round,
          model,
          systemPrompt: PM_SYSTEM_PROMPTS[p],
          userMessage: pmUserMessage(p, {
            campaignId,
            campaignName: camp.name,
            date,
            round,
            dir,
            dayDir: this.dayDir(date),
            previousFiles: [...written],
            lessonsFile: lessonFiles[p],
            historyFile,
          }),
          tools,
          ctx: { tenantId: t, campaignId, date, dir },
          evidence,
          scope: {
            campaignRoot: this.campaignRoot(campaignId),
            date,
            dayDir: this.dayDir(date),
          },
          file,
        }).catch(async (e) => {
          if (e instanceof PmPhaseError) await this.addCost(key, e.costUsd);
          throw e;
        });
        costUsd += r.costUsd;
        await this.addCost(key, r.costUsd);
        if (!r.reused || !existsSync(file))
          writePhaseFile(
            file,
            {
              phase: p,
              campaignId,
              round,
              model,
              costUsd: r.costUsd,
              verdict: verdict?.(r.output),
            },
            r.output,
          );
        written.push(file);
        return r.output;
      };

      const unresolved: string[] = [];
      // Investigate ⇄ verify.
      let inv!: PhaseOutput<'investigate'>;
      let ver!: PhaseOutput<'verify'>;
      let invRounds = 0;
      for (let round = 1, prev: number | undefined; ; round++) {
        invRounds = round;
        inv = await phase('investigate', round, PM_MODELS.investigate);
        const invNow = inv;
        ver = await phase('verify', round, PM_MODELS.verify, (v) =>
          shouldSendBackInvestigation(v, invNow).sendBack
            ? 'send_back'
            : 'pass',
        );
        const d = shouldSendBackInvestigation(ver, inv);
        if (!d.sendBack) break;
        if (
          round > PM_LOOP.maxSendBacks ||
          stopEarly(ver.issues.length, prev)
        ) {
          unresolved.push(
            ...unresolvedOf('verify', round, ver.issues),
            ...d.reasons.map((r) => `verify v${round}: ${r}`),
          );
          break;
        }
        prev = ver.issues.length;
      }
      const [accuracy, hitRates, ownerRules] = await Promise.all([
        this.lessons.causeCategoryAccuracy(),
        this.lessons.actionTypeHitRates(),
        this.lessons.ownerRules(),
      ]);
      const { causes, dropped } = mergeCauses(inv, ver, accuracy);

      // Plan ⇄ plan-verify.
      let plan!: PhaseOutput<'plan'>;
      let pv!: PhaseOutput<'plan_verify'>;
      let planRounds = 0;
      let openPlanIssues: Issue[] = [];
      for (let round = 1, prev: number | undefined; ; round++) {
        planRounds = round;
        plan = await phase(
          'plan',
          round,
          round === 1 ? PM_MODELS.plan : PM_MODELS.plan_revision,
        );
        const planNow = plan;
        pv = await phase('plan_verify', round, PM_MODELS.plan_verify, (v) =>
          shouldSendBackPlan(v, planNow).sendBack ? 'send_back' : 'pass',
        );
        const d = shouldSendBackPlan(pv, plan);
        if (!d.sendBack) break;
        if (round > PM_LOOP.maxSendBacks || stopEarly(pv.issues.length, prev)) {
          openPlanIssues = pv.issues;
          unresolved.push(
            ...unresolvedOf('plan-verify', round, pv.issues),
            ...d.reasons.map((r) => `plan-verify v${round}: ${r}`),
          );
          break;
        }
        prev = pv.issues.length;
      }

      await setStep('checks');
      // lessons.service reports `worked` (= hits: clean settled outcomes that worked).
      const actions = finalActions(
        plan,
        pv,
        causes,
        openPlanIssues,
        Object.fromEntries(
          Object.entries(hitRates).map(([k, v]) => [
            k,
            { n: v.n, hits: v.worked },
          ]),
        ),
      );
      const m7 = await this.analysis.scopeMetrics(
        window(date, 7),
        'campaign',
        campaignId,
      );
      const lessonEffects = new Map(
        (
          await Promise.all(
            actions.map(
              async (a) =>
                [
                  a.id,
                  await this.lessons.effectFor(decisionShape(a), situation),
                ] as const,
            ),
          )
        ).filter((x): x is [string, NonNullable<(typeof x)[1]>] => !!x[1]),
      );
      const ents = await this.campaignEntities(campaignId);
      const checks = runChecks({
        evidence: readEvidence(evidence.file),
        causes,
        actions,
        entityIds: new Set(ents.keys()),
        settling: await this.settlingEntities(campaignId, journal.entries),
        campaignRoas: m7.firstPartyRoas,
        date,
        ownerRules,
        situation,
        entityCreated: new Map(
          [...ents].filter((e): e is [string, string] => !!e[1]),
        ),
        lessonEffects,
      });
      writeFileSync(
        join(dir, PM_FILES.checks),
        checksMarkdown(campaignId, date, checks),
      );
      writeFileSync(
        join(dir, PM_FILES.actions),
        actionsMarkdown({
          name: camp.name,
          campaignId,
          date,
          actions,
          causes,
          dropped,
          unresolved,
          pathToTarget: plan.pathToTarget,
          summary: plan.summary,
        }),
      );

      const impact = actions.reduce((s, a) => s + a.impactRupeesPerDay, 0);
      const used = lessonsUsed([...causes, ...actions]);
      const contradicted = mergeContradictions(
        [inv, ver, plan, pv].map((o) => o.lessonsContradicted),
      );
      await setStep('record lessons');
      await this.lessons.recordRun(date, campaignId, used, contradicted);
      await this.runs.updateOne(key, {
        $set: {
          status: 'done',
          step: 'done',
          investigateRounds: invRounds,
          planRounds,
          unresolved,
          actions,
          causes,
          lessonsUsed: used,
          lessonsContradicted: contradicted,
          impactRupeesPerDay: Math.round(impact),
          files: this.files(dir),
          finishedAt: new Date(),
        },
      });
      return {
        campaignId,
        status: 'done',
        step: 'done',
        actions: actions.length,
        costUsd,
      };
    } catch (e) {
      const error = (e as Error).message;
      this.logger.error(`[${campaignId} ${date}] failed at ${step}: ${error}`);
      if (!opts.dry) {
        const dir = this.campaignDir(campaignId, date);
        await this.runs
          .updateOne(key, {
            $set: {
              status: 'failed',
              step,
              error,
              finishedAt: new Date(),
              ...(existsSync(dir) ? { files: this.files(dir) } : {}),
            },
          })
          .catch(() => undefined);
      }
      return { campaignId, status: 'failed', step, error, actions: 0, costUsd };
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * Atomically move (campaign, date) to 'running' for a direct (CLI) run.
   * Any state but a live 'running' can be taken; a 'running' doc with a
   * heartbeat older than PM_RUN_STALE_MS (or none: pre-queue docs) is dead.
   * False = a worker or another CLI holds it. The queue worker claims with
   * the same status transition (PmAgentQueueService.claimNext), so the two
   * never process one campaign/date at once.
   */
  async claim(date: string, campaignId: string): Promise<boolean> {
    const now = new Date();
    try {
      await this.runs.findOneAndUpdate(
        {
          tenantId: this.env.tenantId,
          campaignId,
          date,
          $or: [
            { status: { $ne: 'running' } },
            { heartbeatAt: null },
            { heartbeatAt: { $lt: new Date(now.getTime() - PM_RUN_STALE_MS) } },
          ],
        },
        {
          $set: { status: 'running', step: 'claimed', heartbeatAt: now },
          $setOnInsert: { queuedAt: now, queuedBy: 'cli' },
        },
        { upsert: true },
      );
      return true;
    } catch (e) {
      // No match → the upsert hits the unique (tenant, campaign, date) index.
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }

  private tools(): PmToolDef[] {
    return [
      ...this.data.defs(),
      ...mathsTools(),
      ...filesTools(this.root),
      ...this.creatives.defs(),
      ...this.landing.defs(),
      ...this.competitors.defs(),
      ...this.calendar.defs(),
      ...this.journal.defs(),
      ...this.lessons.defs(),
    ];
  }

  private addCost(key: object, usd: number) {
    return usd
      ? this.runs.updateOne(key, { $inc: { costUsd: usd } })
      : Promise.resolve();
  }

  /** This campaign's entity ids (campaign, ad sets, ads) → created time (ISO) or null. */
  private async campaignEntities(campaignId: string) {
    const docs = await this.entities
      .find(
        {
          tenantId: this.env.tenantId,
          $or: [{ entityId: campaignId }, { campaignId }],
        },
        { entityId: 1, createdTime: 1 },
      )
      .lean();
    return new Map(
      docs.map((d) => [
        d.entityId,
        d.createdTime ? new Date(d.createdTime).toISOString() : null,
      ]),
    );
  }

  /**
   * Entities with a change still settling per the journal: taken/partly
   * actions (entity from that day's run) and outside changes that name an
   * entity, read before day 7.
   */
  private async settlingEntities(
    campaignId: string,
    entries: PmJournalEntry[],
  ) {
    const out = new Set<string>();
    const open = entries.filter(
      (e) => e.status !== 'not_taken' && e.read !== 'settled',
    );
    const dates = [
      ...new Set(open.filter((e) => e.actionId).map((e) => e.date)),
    ];
    const past = await this.runs
      .find(
        { tenantId: this.env.tenantId, campaignId, date: { $in: dates } },
        { date: 1, actions: 1 },
      )
      .lean();
    for (const e of open as (PmJournalEntry & { entityId?: string })[]) {
      if (e.entityId) out.add(e.entityId);
      const a = past
        .find((r) => r.date === e.date)
        ?.actions.find((x) => x.id === e.actionId);
      if (a) out.add(a.entityId);
    }
    return out;
  }

  private files(dir: string) {
    const out: Record<string, string> = {};
    for (const f of readdirSync(dir).sort()) {
      if (
        !f.endsWith('.md') &&
        !f.endsWith('.md.json') &&
        f !== PM_FILES.evidence
      )
        continue;
      const text = readFileSync(join(dir, f), 'utf8');
      out[f] =
        text.length > MAX_FILE_CHARS
          ? text.slice(0, MAX_FILE_CHARS) + '\n…[cut]'
          : text;
    }
    return out;
  }

  // ---------------------------------------------------------------- brief

  /** Code-built data pack. Each section is also an evidence line, so the models can cite it. */
  private async briefMarkdown(
    date: string,
    camp: PmMetaEntity,
    ev: EvidenceLog,
  ) {
    const id = camp.entityId;
    const [
      m7,
      p7,
      m14,
      m30,
      adsetRows,
      adRows,
      trend,
      budget,
      settings,
      coverage,
      missing,
    ] = await Promise.all([
      this.analysis.scopeMetrics(window(date, 7), 'campaign', id),
      this.analysis.scopeMetrics(
        { from: addDays(date, -14), to: addDays(date, -8) },
        'campaign',
        id,
      ),
      this.analysis.scopeMetrics(window(date, 14), 'campaign', id),
      this.analysis.scopeMetrics(window(date, 30), 'campaign', id),
      this.analysis.entities(window(date, 7), 'adset', id),
      this.analysis.entities(window(date, 7), 'ad', id),
      this.analysis.trend(window(date, 14), 'campaign', id),
      this.analysis.budget(window(date, 14)),
      this.entities
        .find({
          tenantId: this.env.tenantId,
          campaignId: id,
          level: { $in: ['adset', 'ad'] },
        })
        .lean(),
      this.analysis.coverage(window(date, 7, camp.product)),
      this.analysis.missingDays(window(date, 30, camp.product)),
    ]);
    const byId = new Map(settings.map((s) => [s.entityId, s]));
    const adsets = settings.filter(
      (s) =>
        s.level === 'adset' &&
        (s.effectiveStatus === 'ACTIVE' ||
          adsetRows.rows.some((r) => r.id === s.entityId)),
    );
    const ads = settings.filter(
      (s) =>
        s.level === 'ad' &&
        (s.effectiveStatus === 'ACTIVE' ||
          adRows.rows.some((r) => r.id === s.entityId)),
    );
    const budgetRows = budget.rows.filter(
      (r) => r.id === id || byId.get(r.id)?.level === 'adset',
    );
    const row7 = (eid: string, rows: PmEntityRow[]) =>
      rows.find((r) => r.id === eid)?.metrics;

    const evMetrics = ev.record(
      'prep',
      0,
      'brief_metrics',
      { campaignId: id, date },
      { last7: m7, prior7: p7, last14: m14, last30: m30 },
    );
    const evAdsets = ev.record(
      'prep',
      0,
      'brief_adsets',
      { campaignId: id, window: window(date, 7) },
      adsetRows.rows,
    );
    const evAds = ev.record(
      'prep',
      0,
      'brief_ads',
      { campaignId: id, window: window(date, 7) },
      adRows.rows,
    );
    const evTrend = ev.record(
      'prep',
      0,
      'brief_trend',
      { campaignId: id, window: window(date, 14) },
      trend,
    );
    const evBudget = ev.record(
      'prep',
      0,
      'brief_budget',
      { campaignId: id, window: window(date, 14) },
      budgetRows,
    );
    const evAttr = ev.record(
      'prep',
      0,
      'brief_attribution',
      { campaignId: id, product: camp.product },
      { coverage, missingDays: missing },
    );

    const ts = (s: PmMetaEntity) => {
      const t = s.targetingSummary;
      if (!t) return '–';
      return [
        t.audienceType,
        t.ageMin || t.ageMax ? `age ${t.ageMin ?? ''}–${t.ageMax ?? ''}` : '',
        t.genders?.length ? `genders ${t.genders.join('/')}` : '',
        t.regions?.length
          ? `regions ${t.regions.slice(0, 8).join(', ')}${t.regions.length > 8 ? '…' : ''}`
          : '',
        t.cities?.length ? `${t.cities.length} cities` : '',
        t.customAudiences?.length
          ? `${t.customAudiences.length} custom aud.`
          : '',
        t.excludedAudiences?.length
          ? `${t.excludedAudiences.length} excluded`
          : '',
        t.interests?.length
          ? `interests ${t.interests.slice(0, 5).join(', ')}`
          : '',
        t.advantageAudience ? 'Advantage+ audience' : '',
      ]
        .filter(Boolean)
        .join('; ');
    };
    const funnel = (m: PmMetrics) =>
      `${m.linkClicks} link clicks → ${m.landingPageViews} landing views → ${m.siteVisitors} site visitors → ${m.siteCtaClicks} CTA clicks → ${m.sitePaymentsStarted} payments started → ${m.firstPartyOrders} orders (visit→order ${pct(m.visitToOrderRate)}, AOV ${inr(m.averageOrderValue)}, new customers ${m.newCustomerOrders})`;

    return [
      `# Brief — ${camp.name} (${id}) — run ${date}, data to ${addDays(date, -1)}`,
      '',
      'Built by code. Numbers cite the evidence line of their section. 1P = first-party (our orders, device-matched to a Meta click ≤ 7 days, net ex-GST); Meta = Meta-reported.',
      '',
      '## Settings',
      `- Product: ${camp.product} · account ${camp.accountId} · objective ${camp.objective || '–'} · status ${camp.status}/${camp.effectiveStatus} · created ${camp.createdTime ? new Date(camp.createdTime).toISOString().slice(0, 10) : '–'}`,
      `- Budget: ${camp.budgetLevel === 'campaign' ? `campaign (CBO) ${inr(camp.dailyBudget)}/day` : camp.budgetLevel === 'adset' ? 'ad set level (ABO)' : '–'}${camp.lifetimeBudget ? ` · lifetime ${inr(camp.lifetimeBudget)}` : ''} · bid ${camp.bidStrategy || '–'}`,
      '',
      `## Metrics (${evMetrics})`,
      table(METRICS_HEAD, [
        metricsRow('last 7d', m7),
        metricsRow('prior 7d', p7),
        metricsRow('last 14d', m14),
        metricsRow('last 30d', m30),
      ]),
      '',
      `Funnel 7d (${evMetrics}): ${funnel(m7)}`,
      '',
      `## Budget signals 14d (${evBudget})`,
      table(
        [
          'Level',
          'Name',
          'Id',
          'Daily budget',
          'Learning',
          'Spend',
          '1P ROAS',
          'Marginal ROAS',
          'Freq trend',
          'Signal',
        ],
        budgetRows.map((r) => [
          r.level,
          r.name,
          r.id,
          inr(r.dailyBudget),
          r.learningStage || '–',
          inr(r.spend),
          x2(r.firstPartyRoas),
          x2(r.marginalRoas),
          pct(r.frequencyTrend, 0),
          `${r.signal}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`,
        ]),
      ),
      '',
      `## Ad sets (7d metrics ${evAdsets})`,
      table(
        [
          'Ad set',
          'Id',
          'Status',
          'Budget',
          'Opt. goal',
          'Learning',
          'Targeting',
          'Spend',
          'CPM',
          'CTR',
          '1P orders',
          '1P ROAS',
          'Meta ROAS',
        ],
        adsets.map((s) => {
          const m = row7(s.entityId, adsetRows.rows);
          return [
            s.name,
            s.entityId,
            s.effectiveStatus,
            inr(s.dailyBudget),
            s.optimizationGoal || '–',
            s.learningStage || '–',
            ts(s),
            inr(m?.spend),
            inr(m?.cpm),
            pct(m?.ctr),
            m?.firstPartyOrders ?? 0,
            x2(m?.firstPartyRoas),
            x2(m?.metaRoas),
          ];
        }),
      ),
      '',
      `## Ads (7d metrics ${evAds})`,
      table(
        [
          'Ad',
          'Id',
          'Ad set',
          'Status',
          'Format',
          'Spend',
          'CPM',
          'CTR',
          'Freq/day',
          '1P orders',
          '1P ROAS',
          'Title',
          'Body',
          'CTA',
        ],
        ads.map((s) => {
          const m = row7(s.entityId, adRows.rows);
          const c = s.creative;
          return [
            s.name,
            s.entityId,
            s.adsetId,
            s.effectiveStatus,
            c?.videoId ? 'video' : c?.objectType || '–',
            inr(m?.spend),
            inr(m?.cpm),
            pct(m?.ctr),
            x2(m?.frequency),
            m?.firstPartyOrders ?? 0,
            x2(m?.firstPartyRoas),
            c?.title ?? '',
            (c?.body ?? '').slice(0, 200),
            c?.cta ?? '',
          ];
        }),
      ),
      '',
      `## Daily trend 14d (${evTrend})`,
      table(
        [
          'Date',
          'Spend',
          'CPM',
          'CTR',
          'Freq/day',
          'Meta purch.',
          '1P orders',
          '1P ROAS',
          '7d roll. ROAS',
        ],
        trend.points.map((p, i) => [
          p.date,
          inr(p.spend),
          inr(p.cpm),
          pct(p.ctr),
          x2(p.frequency),
          p.metaPurchases,
          p.firstPartyOrders,
          x2(p.firstPartyRoas),
          x2(trend.rollingRoas7[i]),
        ]),
      ),
      '',
      `## Attribution health (${evAttr}, ${evMetrics})`,
      `- 7d: Meta purchases ${m7.metaPurchases} vs 1P orders ${m7.firstPartyOrders} (1P ÷ Meta ${x2(m7.metaPurchases ? m7.firstPartyOrders / m7.metaPurchases : null)}); Meta ROAS ${x2(m7.metaRoas)} vs 1P ROAS ${x2(m7.firstPartyRoas)}`,
      `- ${camp.product} web orders 7d linked to a visit ${pct(coverage.linkedToVisit, 0)}, to a Meta ad ${pct(coverage.linkedToMetaAd, 0)}`,
      `- Missing days 30d: Meta ${missing.meta.join(', ') || 'none'}; orders ${missing.orders.join(', ') || 'none'}; visitors ${missing.visitors.join(', ') || 'none'}`,
      '',
    ].join('\n');
  }

  // ---------------------------------------------------------------- all

  async runAll(
    date: string,
    opts: { campaignIds?: string[]; limit?: number; dry?: boolean } = {},
  ) {
    await this.acquire(date);
    const beat = setInterval(() => void this.renew(), HEARTBEAT_MS);
    try {
      await this.prepareDay(date);
      const queue = await this.queue(date, opts);
      this.logger.log(`queue ${date}: ${queue.length} campaign(s)`);
      const results = await pool(
        queue,
        envNum('PM_AGENT_CONCURRENCY', 3),
        (q) => this.runCampaign(date, q.campaignId, { dry: opts.dry }),
      );
      const rollup = opts.dry ? null : await this.writeRollup(date);
      return {
        date,
        queued: queue.length,
        done: results.filter((r) => r.status === 'done').length,
        skipped: results
          .filter((r) => r.status === 'skipped')
          .map((r) => r.campaignId),
        failed: results
          .filter((r) => r.status === 'failed')
          .map((r) => ({
            campaignId: r.campaignId,
            step: r.step,
            error: r.error,
          })),
        costUsd:
          Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 100) / 100,
        rollup,
      };
    } finally {
      clearInterval(beat);
      await this.locks.updateOne(
        { _id: this.lockId, holder: this.holder },
        { $set: { until: new Date(0) } },
      );
    }
  }

  async writeRollup(date: string) {
    const docs = await this.runs
      .find({ tenantId: this.env.tenantId, date }, { files: 0, journal: 0 })
      .lean();
    const actions = docs
      .flatMap((r) =>
        (r.actions as FinalAction[]).map((a) => ({
          ...a,
          campaignName: r.campaignName,
          campaignId: r.campaignId,
        })),
      )
      .sort((a, b) => actionScore(b) - actionScore(a));
    const file = join(this.dayDir(date), 'rollup.md');
    writeFileSync(
      file,
      [
        `# Roll-up — ${date}`,
        '',
        `${docs.filter((d) => d.status === 'done').length} done, ${docs.filter((d) => d.status === 'failed').length} failed, ${actions.length} actions. Ranked by ₹ impact × confidence × action-type hit rate.`,
        '',
        table(
          [
            '#',
            'Campaign',
            'Action',
            'Entity',
            'Change',
            '₹/day',
            'Conf',
            'Verdict',
            'Check failures',
          ],
          actions.map((a, i) => [
            i + 1,
            `${a.campaignName} (${a.campaignId})`,
            `${a.id} ${a.title}`,
            `${a.entityLevel} ${a.entityName} (${a.entityId})`,
            `${a.change.field}: ${a.change.from} → ${a.change.to}`,
            inr(a.impactRupeesPerDay),
            a.confidence,
            a.verdict,
            a.checksFailed?.join(', ') || '–',
          ]),
        ),
        '',
        ...docs
          .filter((d) => d.status === 'failed')
          .map(
            (d) =>
              `- FAILED ${d.campaignName} (${d.campaignId}) at ${d.step}: ${d.error}`,
          ),
        '',
      ].join('\n'),
    );
    return file;
  }

  private get lockId() {
    return `pm-agent:${this.env.tenantId}`;
  }

  /** Same lease pattern as PmSyncService: only an expired lease can be taken. */
  private async acquire(date: string) {
    const now = new Date();
    try {
      await this.locks.findOneAndUpdate(
        { _id: this.lockId, tenantId: this.env.tenantId, until: { $lte: now } },
        {
          $set: {
            holder: this.holder,
            job: `agent ${date}`,
            until: new Date(now.getTime() + LEASE_MS),
          },
        },
        { upsert: true },
      );
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const l = await this.locks.findById(this.lockId).lean();
        throw new Error(
          `A Performance Marketeer agent run is already running (${l?.job ?? 'unknown'})`,
        );
      }
      throw e;
    }
  }

  private async renew() {
    await this.locks
      .updateOne(
        { _id: this.lockId, holder: this.holder },
        { $set: { until: new Date(Date.now() + LEASE_MS) } },
      )
      .catch((e) =>
        this.logger.warn(`lock renew failed: ${(e as Error).message}`),
      );
  }
}

/** Runs `fn` over items with at most `n` in flight; results in item order. */
async function pool<T, R>(
  items: T[],
  n: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function checksMarkdown(
  campaignId: string,
  date: string,
  checks: CheckResult[],
) {
  return [
    `# Code checks — ${campaignId} — ${date}`,
    '',
    'Run by code after the plan verifier: evidence ids exist, impacts come from impact_rupees, budget steps ≤ ±' +
      `${PM_LOOP.maxBudgetStep * 100}%, entities exist, nothing stacked on a settling entity, no spend increase below target ROAS, owner rules, predictions vs measured lessons. Failures mark actions; they do not remove them.`,
    '',
    checks.length
      ? table(
          ['Target', 'Check', 'Problem'],
          checks.map((c) => [c.target, c.check, c.message]),
        )
      : 'All checks passed.',
    '',
  ].join('\n');
}

function actionsMarkdown(a: {
  name: string;
  campaignId: string;
  date: string;
  summary: string;
  pathToTarget: string;
  actions: FinalAction[];
  causes: MergedCause[];
  dropped: { id: string; title: string }[];
  unresolved: string[];
}) {
  const cause = new Map(a.causes.map((c) => [c.id, c]));
  const why = (ids: string[]) =>
    ids
      .map((id) => {
        const c = cause.get(id);
        return c
          ? `${id} ${c.title} (conf ${c.confidence}${c.disputed ? ', DISPUTED' : ''})`
          : `${id} (not a final cause)`;
      })
      .join('; ') || '–';
  return [
    `# Actions — ${a.name} (${a.campaignId}) — ${a.date}`,
    '',
    a.summary,
    '',
    `Path to first-party ROAS > ${PM_LOOP.targetRoas.toFixed(2)}: **${a.pathToTarget}**`,
    '',
    '## Causes (final scores)',
    ...a.causes.map(
      (c) =>
        `- ${c.id} · ${c.verdict} · conf ${c.confidence}${c.disputed ? ' (disputed: investigator ' + c.investigatorConfidence + ', verifier ' + c.verifierConfidence + ')' : ''} · ₹${Math.round(c.impactRupeesPerDay)}/day${c.lessonIds.length ? ` · lessons ${c.lessonIds.join(', ')}` : ''} — ${c.title}${c.capNote ? ` (${c.capNote})` : ''}`,
    ),
    ...(a.dropped.length
      ? [
          '',
          'Dropped (rejected with evidence): ' +
            a.dropped.map((c) => `${c.id} ${c.title}`).join('; '),
        ]
      : []),
    '',
    '## Actions (ranked by ₹ impact × confidence × action-type hit rate)',
    ...a.actions.flatMap((x) => [
      '',
      `### ${x.rank}. ${x.id} — ${x.title}${x.verdict !== 'approve' ? ` [${x.verdict.toUpperCase()}]` : ''}${x.checksFailed.length ? ' [CHECK FAILED]' : ''}`,
      `- **Do in Ads Manager:** ${x.type} on ${x.entityLevel} "${x.entityName}" (${x.entityId}): ${x.change.field} ${x.change.from ?? '–'} → ${x.change.to ?? '–'}`,
      `- **Why:** ${why(x.causeIds)}`,
      `- **Expected:** ${x.expectedEffect.metric} ${x.expectedEffect.low} to ${x.expectedEffect.high} · ₹${Math.round(x.impactRupeesPerDay)}/day · conf ${x.confidence}`,
      `- **Risk:** ${x.risk || '–'}${x.resetsLearning ? ' · resets learning' : ''}`,
      `- **Judge on:** ${x.judgeOn} · **Stop if:** ${x.stopCondition}`,
      ...(x.creativeBrief ? [`- **Creative brief:** ${x.creativeBrief}`] : []),
      ...(x.lessonIds.length
        ? [`- **Lessons:** ${x.lessonIds.join(', ')}`]
        : []),
      ...(x.hitRateFactor !== 1
        ? [
            `- Rank weight ×${x.hitRateFactor.toFixed(2)} from the ${x.type} action track record`,
          ]
        : []),
      ...x.notes.map((n) => `- Note: ${n}`),
      ...x.checkMessages.map((f) => `- Check failed: ${f}`),
    ]),
    '',
    '## Unresolved',
    ...(a.unresolved.length ? a.unresolved.map((u) => `- ${u}`) : ['None.']),
    '',
  ].join('\n');
}
