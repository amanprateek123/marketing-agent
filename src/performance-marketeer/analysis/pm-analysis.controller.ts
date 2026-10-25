import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { findPmProduct, pmEnv, PmEnv } from '../pm.config';
import { dayRange, istDayFromToday } from '../pm.logic';
import { PmLevel, PmQuery } from './pm-analysis.types';
import { PmAnalysisService } from './pm-analysis.service';

const LEVELS: PmLevel[] = ['account', 'campaign', 'adset', 'ad'];
const CHANNELS = [
  'meta_ad',
  'meta_other',
  'google_ads',
  'google_organic',
  'quora',
  'chatgpt',
  'other_utm',
  'referral',
  'direct',
];
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

type Q = Record<string, unknown>;

/** A query value that must be a plain string (blocks ?x[$ne]= objects). */
function str(q: Q, key: string): string | undefined {
  const v = q[key];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string')
    throw new BadRequestException(`${key} must be a string`);
  return v;
}
function id(q: Q, key: string) {
  const v = str(q, key);
  if (v !== undefined && !ID_RE.test(v))
    throw new BadRequestException(`Invalid ${key}`);
  return v;
}
function range(q: Q): { from: string; to: string } {
  const from = str(q, 'from') ?? '';
  const to = str(q, 'to') ?? '';
  try {
    dayRange(from, to, 200);
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
  return { from, to };
}
function pmQuery(q: Q): PmQuery {
  const product = str(q, 'product');
  if (product && !findPmProduct(product))
    throw new BadRequestException('Unknown product');
  return { ...range(q), ...(product ? { product } : {}) };
}
function level<T extends PmLevel>(q: Q, allowed: T[], fallback?: T): T {
  const v = str(q, 'level') ?? fallback;
  if (!v || !allowed.includes(v as T))
    throw new BadRequestException(`level must be one of ${allowed.join(', ')}`);
  return v as T;
}
function levelAndId(q: Q) {
  const l = level(q, LEVELS, 'account');
  const i = id(q, 'id');
  if (l !== 'account' && !i)
    throw new BadRequestException('id is required for this level');
  return { level: l, id: l === 'account' ? undefined : i };
}

/**
 * Read-only analysis endpoints (contract: pm-analysis.types.ts). Behind the
 * global JWT guard; not gated on PM_SYNC_ENABLED since nothing here writes.
 */
@Controller('performance-marketeer/:tenantId')
export class PmAnalysisController {
  constructor(
    private readonly analysis: PmAnalysisService,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  @Get('summary')
  summary(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.analysis.summary(pmQuery(q));
  }

  @Get('entities')
  entities(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.analysis.entities(
      pmQuery(q),
      level(q, ['campaign', 'adset', 'ad'], 'campaign'),
      id(q, 'parentId'),
    );
  }

  @Get('trend')
  trend(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    const l = levelAndId(q);
    return this.analysis.trend(pmQuery(q), l.level, l.id);
  }

  @Get('decompose')
  decompose(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    const l = levelAndId(q);
    return this.analysis.decompose(pmQuery(q), l.level, l.id);
  }

  @Get('funnel')
  funnel(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    const channel = str(q, 'channel');
    if (channel && !CHANNELS.includes(channel))
      throw new BadRequestException(
        `channel must be one of ${CHANNELS.join(', ')}`,
      );
    return this.analysis.funnel(pmQuery(q), channel, id(q, 'adId'));
  }

  @Get('fatigue')
  fatigue(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.analysis.fatigue(pmQuery(q));
  }

  @Get('geo')
  geo(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.analysis.geo(pmQuery(q));
  }

  @Get('budget')
  budget(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.analysis.budget(pmQuery(q));
  }

  @Get('reconcile')
  reconcile(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.analysis.reconcile(pmQuery(q));
  }

  @Get('changes')
  changes(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    const { from, to } = range(q);
    return this.analysis.changes(from, to, id(q, 'objectId'));
  }

  /** ?date=YYYY-MM-DD (default yesterday, IST) &product= (optional). */
  @Get('report')
  report(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    const date = str(q, 'date') ?? istDayFromToday(-1);
    try {
      dayRange(date, date);
    } catch {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const product = str(q, 'product');
    if (product && !findPmProduct(product))
      throw new BadRequestException('Unknown product');
    return this.analysis.report(date, product);
  }

  // Data is per workspace; only the configured tenant has any.
  private assertTenant(tenantId: string) {
    if (tenantId !== this.env.tenantId) throw new NotFoundException();
  }
}
