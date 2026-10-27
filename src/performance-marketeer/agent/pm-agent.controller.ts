import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Model } from 'mongoose';
import type { AuthedRequest } from '../../auth/roles';
import { PmAgentQueueService } from './pipeline/pm-agent-queue.service';
import { pmEnv, PmEnv } from '../pm.config';
import { dayRange } from '../pm.logic';
import { PmAgentRun } from '../schemas/pm-agent-run.schema';

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
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
    private readonly queue: PmAgentQueueService,
  ) {}

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

  // Data is per workspace; only the configured tenant has any.
  private assertTenant(tenantId: string) {
    if (tenantId !== this.env.tenantId) throw new NotFoundException();
  }
}
