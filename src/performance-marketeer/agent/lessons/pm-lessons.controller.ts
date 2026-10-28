import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { pmEnv, PmEnv } from '../../pm.config';
import { ActionSchema } from '../pm-agent.types';
import { PmLessonsService } from './lessons.service';
import type {
  PmLessonScope,
  PmLessonStatus,
  PmLessonType,
  PmOwnerRule,
  PmSituation,
} from './lessons.types';

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const STATUSES: PmLessonStatus[] = ['candidate', 'active', 'review', 'retired'];
const TYPES: PmLessonType[] = [
  'action_effect',
  'diagnosis_pattern',
  'creative_pattern',
  'season_effect',
  'segment_fact',
  'analyst_habit',
];
const PROPOSAL_STATUSES = [
  'pending',
  'applied',
  'approved',
  'rejected',
  'invalid',
];
/** Record (not an array) so a new PmSituation field fails to compile until listed. */
const SITUATION_KEYS: Record<keyof PmSituation, true> = {
  product: true,
  structure: true,
  objective: true,
  audience: true,
  spendBand: true,
  learning: true,
  daysSinceLaunch: true,
  daysSinceLastEdit: true,
  roas7d: true,
  cpa7d: true,
  ctr7d: true,
  cpm7d: true,
  freqDay: true,
  accountCpmTrend: true,
  season: true,
  festivalInDays: true,
  symptoms: true,
  level: true,
  entityId: true,
};
const SCOPE_KEYS = new Set([
  ...Object.keys(SITUATION_KEYS),
  'phase',
  'category',
]);
const ACTION_TYPES: readonly string[] = ActionSchema.shape.type.options;

export class PmNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class PmRequiredNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note: string;
}

export class PmLessonPatchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  statement?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  because?: string;

  @IsOptional()
  @IsObject()
  scope?: Record<string, unknown>;
}

export class PmOwnerRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  text: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** null clears the check (PATCH). */
  @IsOptional()
  @IsObject()
  check?: Record<string, unknown> | null;
}

export class PmOwnerRulePatchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  text?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsObject()
  check?: Record<string, unknown> | null;
}

type Q = Record<string, unknown>;

function id(v: string, what: string): string {
  if (!ID_RE.test(v)) throw new BadRequestException(`Invalid ${what}`);
  return v;
}
function oneOf<T extends string>(
  v: unknown,
  list: readonly T[],
  what: string,
): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !list.includes(v as T))
    throw new BadRequestException(`${what} must be one of ${list.join(', ')}`);
  return v as T;
}
const shortStr = (v: unknown, what: string, max = 100): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new BadRequestException(
      `${what} must be a string of 1-${max} characters`,
    );
  return v.trim();
};
const optStr = (v: unknown, what: string) =>
  v === undefined || v === '' ? undefined : shortStr(v, what);

export function validScope(s: Record<string, unknown>): PmLessonScope {
  const out: PmLessonScope = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SCOPE_KEYS.has(k))
      throw new BadRequestException(`Unknown scope key "${k}"`);
    out[k] = shortStr(v, `scope.${k}`);
  }
  return out;
}

export function validCheck(
  c: Record<string, unknown>,
): NonNullable<PmOwnerRule['check']> {
  const product = optStr(c.product, 'check.product');
  switch (c.kind) {
    case 'no_pause_before_days': {
      const days = c.days;
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > 60
      )
        throw new BadRequestException('check.days must be a whole number 1-60');
      return { kind: c.kind, days };
    }
    case 'max_budget_step': {
      const step = c.step;
      if (typeof step !== 'number' || !(step > 0 && step <= 1))
        throw new BadRequestException(
          'check.step must be a fraction above 0 and at most 1 (0.2 = 20%)',
        );
      return { kind: c.kind, step };
    }
    case 'no_budget_increase_in_season':
      return {
        kind: c.kind,
        season: shortStr(c.season, 'check.season'),
        ...(product ? { product } : {}),
      };
    case 'no_action_type': {
      const type = oneOf(c.type, ACTION_TYPES, 'check.type');
      if (!type) throw new BadRequestException('check.type is required');
      return { kind: c.kind, type, ...(product ? { product } : {}) };
    }
    default:
      throw new BadRequestException(
        'check.kind must be one of no_pause_before_days, max_budget_step, no_budget_increase_in_season, no_action_type',
      );
  }
}

/**
 * Lessons review endpoints (docs/performance-marketeer/10-lessons.md): you
 * approve/reject curator proposals, edit or retire lessons and keep your owner
 * rules. Behind the global JWT guard; only the configured tenant has data.
 */
@Controller('performance-marketeer/:tenantId/lessons')
export class PmLessonsController {
  constructor(
    private readonly lessons: PmLessonsService,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  @Get()
  list(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.lessons.listLessons({
      status: oneOf(q.status, STATUSES, 'status'),
      type: oneOf(q.type, TYPES, 'type'),
    });
  }

  @Get('proposals')
  proposals(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    return this.lessons.listProposals(
      oneOf(q.status, PROPOSAL_STATUSES, 'status'),
    );
  }

  @Post('proposals/:id/approve')
  approve(
    @Param('tenantId') t: string,
    @Param('id') p: string,
    @Body() b: PmNoteDto,
  ) {
    this.assertTenant(t);
    return this.lessons.approve(
      id(p, 'proposalId'),
      b.note?.trim() || undefined,
    );
  }

  @Post('proposals/:id/reject')
  reject(
    @Param('tenantId') t: string,
    @Param('id') p: string,
    @Body() b: PmRequiredNoteDto,
  ) {
    this.assertTenant(t);
    return this.lessons.reject(
      id(p, 'proposalId'),
      shortStr(b.note, 'note', 1000),
    );
  }

  @Get('owner-rules')
  ownerRules(@Param('tenantId') t: string) {
    this.assertTenant(t);
    return this.lessons.ownerRules();
  }

  @Post('owner-rules')
  createOwnerRule(@Param('tenantId') t: string, @Body() b: PmOwnerRuleDto) {
    this.assertTenant(t);
    return this.lessons.createOwnerRule({
      text: shortStr(b.text, 'text', 300),
      active: b.active ?? true,
      ...(b.check ? { check: validCheck(b.check) } : {}),
    });
  }

  @Patch('owner-rules/:ruleId')
  updateOwnerRule(
    @Param('tenantId') t: string,
    @Param('ruleId') r: string,
    @Body() b: PmOwnerRulePatchDto,
  ) {
    this.assertTenant(t);
    const patch: Partial<Omit<PmOwnerRule, 'check'>> & {
      check?: PmOwnerRule['check'] | null;
    } = {};
    if (b.text !== undefined) patch.text = shortStr(b.text, 'text', 300);
    if (b.active !== undefined) patch.active = b.active;
    if (b.check !== undefined)
      patch.check = b.check === null ? null : validCheck(b.check);
    if (!Object.keys(patch).length)
      throw new BadRequestException('Nothing to change');
    return this.lessons.updateOwnerRule(id(r, 'ruleId'), patch);
  }

  @Delete('owner-rules/:ruleId')
  deleteOwnerRule(@Param('tenantId') t: string, @Param('ruleId') r: string) {
    this.assertTenant(t);
    return this.lessons.deleteOwnerRule(id(r, 'ruleId'));
  }

  @Get('scorecard')
  scorecard(@Param('tenantId') t: string, @Query() q: Q) {
    this.assertTenant(t);
    const weeks = q.weeks === undefined || q.weeks === '' ? 8 : Number(q.weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52)
      throw new BadRequestException('weeks must be a whole number 1-52');
    return this.lessons.scorecard(weeks);
  }

  // Parameterised lesson routes last, so "proposals"/"owner-rules"/"scorecard" never match :lessonId.
  @Patch(':lessonId')
  edit(
    @Param('tenantId') t: string,
    @Param('lessonId') l: string,
    @Body() b: PmLessonPatchDto,
  ) {
    this.assertTenant(t);
    const patch: {
      statement?: string;
      because?: string;
      scope?: PmLessonScope;
    } = {};
    if (b.statement !== undefined)
      patch.statement = shortStr(b.statement, 'statement', 500);
    if (b.because !== undefined) patch.because = b.because.trim();
    if (b.scope !== undefined) patch.scope = validScope(b.scope);
    if (!Object.keys(patch).length)
      throw new BadRequestException('Nothing to change');
    return this.lessons.editLesson(id(l, 'lessonId'), patch);
  }

  @Post(':lessonId/retire')
  retire(
    @Param('tenantId') t: string,
    @Param('lessonId') l: string,
    @Body() b: PmRequiredNoteDto,
  ) {
    this.assertTenant(t);
    return this.lessons.retire(
      id(l, 'lessonId'),
      shortStr(b.note, 'note', 1000),
    );
  }

  // Data is per workspace; only the configured tenant has any.
  private assertTenant(tenantId: string) {
    if (tenantId !== this.env.tenantId) throw new NotFoundException();
  }
}
