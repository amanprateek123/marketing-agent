import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Model } from 'mongoose';
import type { AuthedRequest } from '../../auth/roles';
import { PmAgentQueueService } from './pipeline/pm-agent-queue.service';
import { PmReportService } from './report/pm-report.service';
import { pmEnv, PmEnv, PM_HISTORY_START } from '../pm.config';
import { dayRange } from '../pm.logic';
import { PmAgentRun } from '../schemas/pm-agent-run.schema';
import { PmCampaignTarget } from '../schemas/pm-campaign-target.schema';
import { istDayFromToday } from '../pm.logic';
import { PmMetaEntity } from '../schemas/pm-meta.schema';

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

export class PmAgentNoteDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @IsString()
  @MaxLength(2000)
  note: string;
}

export class PmAgentQueueDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Matches(/^\d{1,32}$/, { each: true })
  campaignIds: string[];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @IsBoolean()
  rerun?: boolean;
}

export class PmAgentCancelDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;
}

/** Omitted = leave as it is; null = remove. */
export class PmCampaignTargetDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  targetPurchases?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  targetRoas?: number | null;

  /** Period in days, starting today (IST). Saving it starts a new count. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  targetDays?: number | null;

  /** Rupees per day. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  maxDailyBudget?: number | null;
}

type Q = Record<string, unknown>;
type RunAction = PmAgentRun['actions'][number];

function validDate(v: unknown): string {
  if (typeof v !== 'string')
    throw new BadRequestException('date must be YYYY-MM-DD');
  try {
    dayRange(v, v);
  } catch {
    throw new BadRequestException('date must be YYYY-MM-DD');
  }
  return v;
}
function optDate(q: Q): string | undefined {
  return q.date === undefined || q.date === '' ? undefined : validDate(q.date);
}
function campaign(v: string): string {
  if (!ID_RE.test(v)) throw new BadRequestException('Invalid campaignId');
  return v;
}

/**
 * Step 3 AI-analyst read endpoints, the user's note, and the admin queue
 * (docs/performance-marketeer/09). LLM runs start only from the queue
 * (worker: PmAgentQueueService) or the CLI — there is no cron. Behind the
 * global JWT guard; every query is filtered by tenantId.
 */
@Controller('performance-marketeer/:tenantId/agent')
export class PmAgentController {
  constructor(
    @InjectModel(PmAgentRun.name) private readonly runs: Model<PmAgentRun>,
    @InjectModel(PmCampaignTarget.name)
    private readonly targets: Model<PmCampaignTarget>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
    private readonly queue: PmAgentQueueService,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    private readonly reports: PmReportService,
  ) {}

  /**
   * Campaigns to pick for analysis, whether or not their data is loaded yet
   * (the list comes from Meta, refreshed hourly): active ones, and any
   * launched since PM_HISTORY_START. Active first, newest first.
   */
  @Get('campaigns')
  async campaigns(@Param('tenantId') t: string) {
    this.assertTenant(t);
    const docs = await this.entities
      .find(
        {
          tenantId: t,
          level: 'campaign',
          $or: [
            { effectiveStatus: 'ACTIVE' },
            {
              createdTime: {
                $gte: new Date(`${PM_HISTORY_START}T00:00:00+05:30`),
              },
            },
          ],
        },
        {
          entityId: 1,
          name: 1,
          accountId: 1,
          effectiveStatus: 1,
          createdTime: 1,
          product: 1,
          dailyBudget: 1,
        },
      )
      .lean()
      .exec();
    // Latest finished run per campaign, so the list can link to its report.
    const done = await this.runs.aggregate<{ _id: string; date: string }>([
      {
        $match: {
          tenantId: t,
          status: 'done',
          campaignId: { $in: docs.map((d) => d.entityId) },
        },
      },
      { $group: { _id: '$campaignId', date: { $max: '$date' } } },
    ]);
    const lastRun = new Map(done.map((x) => [x._id, x.date]));
    return docs
      .map((d) => ({
        id: d.entityId,
        name: d.name,
        accountId: d.accountId,
        effectiveStatus: d.effectiveStatus,
        createdTime: d.createdTime ?? null,
        product: d.product,
        dailyBudget: d.dailyBudget ?? null,
        lastRunDate: lastRun.get(d.entityId) ?? null,
      }))
      .sort(
        (a, b) =>
          Number(b.effectiveStatus === 'ACTIVE') -
            Number(a.effectiveStatus === 'ACTIVE') ||
          new Date(b.createdTime ?? 0).getTime() -
            new Date(a.createdTime ?? 0).getTime(),
      );
  }

  /** Queue campaigns for AI analysis (date default: today IST). */
  @Post('queue')
  async enqueue(
    @Param('tenantId') t: string,
    @Body() body: PmAgentQueueDto,
    @Req() req: AuthedRequest,
  ) {
    this.assertTenant(t);
    const date = body.date === undefined ? undefined : validDate(body.date);
    return this.queue.enqueue(
      body.campaignIds.map(campaign),
      date,
      req.user?.sub ?? '',
      body.rerun === true,
    );
  }

  /** Queued (with position) + running + ?date= (default today IST) finished runs. */
  @Get('queue')
  async queueList(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.queue.list(optDate(q));
  }

  /** Cancel a queued run (409 if it is running or finished). */
  @Post('queue/:campaignId/cancel')
  async cancel(
    @Param('tenantId') t: string,
    @Param('campaignId') c: string,
    @Body() body: PmAgentCancelDto,
  ) {
    this.assertTenant(t);
    return this.queue.cancel(campaign(c), validDate(body.date));
  }

  /** Dates that have runs, newest first (60 max). */
  @Get('dates')
  async dates(@Param('tenantId') t: string): Promise<string[]> {
    this.assertTenant(t);
    const rows = await this.runs
      .aggregate<{
        _id: string;
      }>([
        { $match: { tenantId: t } },
        { $group: { _id: '$date' } },
        { $sort: { _id: -1 } },
        { $limit: 60 },
      ])
      .exec();
    return rows.map((r) => r._id);
  }

  /** Day roll-up: ?date=YYYY-MM-DD (default: latest date with runs). */
  @Get('runs')
  async rollup(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    let date = optDate(q);
    if (!date) {
      const latest = await this.runs
        .findOne({ tenantId: t }, { date: 1 })
        .sort({ date: -1 })
        .lean()
        .exec();
      if (!latest) return { date: null, runs: [], actions: [] };
      date = latest.date;
    }
    const docs = await this.runs
      .find({ tenantId: t, date }, { files: 0, journal: 0, userNote: 0 })
      .sort({ impactRupeesPerDay: -1 })
      .lean()
      .exec();
    const runs = docs.map((r) => ({
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      product: r.product,
      status: r.status,
      step: r.step,
      error: r.error,
      investigateRounds: r.investigateRounds,
      planRounds: r.planRounds,
      impactRupeesPerDay: r.impactRupeesPerDay,
      actionCount: r.actions.length,
      unresolvedCount: r.unresolved.length,
      costUsd: r.costUsd,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }));
    // Priority = ₹ impact × confidence (09 phase 3); the run's own rank breaks ties.
    const actions = docs
      .flatMap((r) =>
        r.actions.map((a: RunAction) => ({
          ...a,
          campaignId: r.campaignId,
          campaignName: r.campaignName,
        })),
      )
      .sort(
        (a, b) =>
          b.impactRupeesPerDay * b.confidence -
            a.impactRupeesPerDay * a.confidence || a.rank - b.rank,
      );
    return { date, runs, actions };
  }

  /** Full run for one campaign: ?date= (default: its latest run). */
  @Get('runs/:campaignId')
  async run(
    @Param('tenantId') t: string,
    @Param('campaignId') c: string,
    @Query() q: Q,
  ) {
    this.assertTenant(t);
    const date = optDate(q);
    const doc = await this.runs
      .findOne({
        tenantId: t,
        campaignId: campaign(c),
        ...(date ? { date } : {}),
      })
      .sort({ date: -1 })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('No run for this campaign and date');
    return doc;
  }

  /** The owner's report for one run: ?date= (default: the latest run). */
  @Get('runs/:campaignId/report')
  report(
    @Param('tenantId') t: string,
    @Param('campaignId') c: string,
    @Query() q: Q,
  ) {
    this.assertTenant(t);
    return this.reports.report(campaign(c), optDate(q));
  }

  /** The user's note on a run's actions; tomorrow's journal reads it. */
  @Post('runs/:campaignId/note')
  async note(
    @Param('tenantId') t: string,
    @Param('campaignId') c: string,
    @Body() body: PmAgentNoteDto,
  ) {
    this.assertTenant(t);
    const date = validDate(body.date);
    const doc = await this.runs
      .findOneAndUpdate(
        { tenantId: t, campaignId: campaign(c), date },
        { $set: { userNote: body.note.trim() } },
        { new: true, projection: { userNote: 1, date: 1, campaignId: 1 } },
      )
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('No run for this campaign and date');
    return {
      campaignId: doc.campaignId,
      date: doc.date,
      userNote: doc.userNote,
    };
  }

  /** Campaign goals that are set. */
  @Get('targets')
  async targetList(@Param('tenantId') t: string) {
    this.assertTenant(t);
    const docs = await this.targets
      .find({
        tenantId: t,
        $or: [
          { targetPurchases: { $ne: null } },
          { targetRoas: { $ne: null } },
          { maxDailyBudget: { $ne: null } },
        ],
      })
      .lean()
      .exec();
    return docs.map((d) => ({
      campaignId: d.campaignId,
      targetPurchases: d.targetPurchases,
      targetRoas: d.targetRoas ?? null,
      targetDays: d.targetDays ?? null,
      targetStart: d.targetStart ?? null,
      maxDailyBudget: d.maxDailyBudget ?? null,
      updatedBy: d.updatedBy,
      updatedAt: (d as { updatedAt?: Date }).updatedAt ?? null,
    }));
  }

  /** Set, change or (null) remove parts of a campaign's goal. Any logged-in user. */
  @Put('targets/:campaignId')
  async setTarget(
    @Param('tenantId') t: string,
    @Param('campaignId') c: string,
    @Body() body: PmCampaignTargetDto,
    @Req() req: AuthedRequest,
  ) {
    this.assertTenant(t);
    const by = req.user?.sub ?? '';
    if (
      (body.targetPurchases != null || body.targetRoas != null) &&
      !body.targetDays
    )
      throw new BadRequestException(
        'A ROAS or purchase target needs a number of days',
      );
    const change = Object.fromEntries(
      (
        [
          'targetPurchases',
          'targetRoas',
          'targetDays',
          'maxDailyBudget',
        ] as const
      )
        .filter((k) => body[k] !== undefined)
        .map((k) => [k, body[k]]),
    );
    const start =
      body.targetDays === undefined
        ? {}
        : { targetStart: body.targetDays === null ? null : istDayFromToday() };
    const doc = await this.targets
      .findOneAndUpdate(
        { tenantId: t, campaignId: campaign(c) },
        {
          $set: { ...change, ...start, updatedBy: by },
          $push: {
            history: {
              $each: [{ ...change, by, at: new Date() }],
              $slice: -50,
            },
          },
        },
        { upsert: true, new: true },
      )
      .lean()
      .exec();
    return {
      campaignId: doc.campaignId,
      targetPurchases: doc.targetPurchases,
      targetRoas: doc.targetRoas ?? null,
      targetDays: doc.targetDays ?? null,
      targetStart: doc.targetStart ?? null,
      maxDailyBudget: doc.maxDailyBudget ?? null,
      updatedBy: doc.updatedBy,
      updatedAt: (doc as { updatedAt?: Date }).updatedAt ?? null,
    };
  }

  // Data is per workspace; only the configured tenant has any.
  private assertTenant(tenantId: string) {
    if (tenantId !== this.env.tenantId) throw new NotFoundException();
  }
}
