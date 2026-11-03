import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { pmEnv, PmEnv } from '../../pm.config';
import { PmLaunchService } from './launch.service';
import type { RoasType } from './launch.types';

export class PmLaunchStartDto {
  @IsString() @MaxLength(200) productName: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  creativeUrls: string[];
  @IsNumber() @Min(1) @Max(10_000_000) dailySpend: number;
  @IsNumber() @Min(0.1) @Max(50) desiredRoas: number;
  @IsIn(['meta', 'first_party']) roasType: RoasType;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) launchDate: string;
  @IsOptional() @IsNumber() @Min(1) maxCpa?: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class ChecklistDto {
  @IsBoolean() testPurchase: boolean;
  @IsBoolean() deduplicated: boolean;
  @IsBoolean() mobilePath: boolean;
  @IsBoolean() claimsVerified: boolean;
}

export class PmLaunchCreateDto {
  @IsObject()
  @ValidateNested()
  @Type(() => ChecklistDto)
  checklist: ChecklistDto;
}

class IdParam {
  @IsMongoId() id: string;
}

/** Launch Planner (doc 11). Behind the global JWT guard, open to any logged-in user. */
@Controller('performance-marketeer/:tenantId/launch')
export class PmLaunchController {
  constructor(
    private readonly launch: PmLaunchService,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  private assertTenant(t: string) {
    if (t !== this.env.tenantId)
      throw new ForbiddenException('Not available for this tenant');
  }

  @Get('products')
  products(@Param('tenantId') t: string) {
    this.assertTenant(t);
    return this.launch.products(t);
  }

  @Get('plans')
  list(@Param('tenantId') t: string) {
    this.assertTenant(t);
    return this.launch.list(t);
  }

  @Get('plans/:id')
  one(@Param('tenantId') t: string, @Param() p: IdParam) {
    this.assertTenant(t);
    return this.launch.one(t, p.id);
  }

  @Post('plans')
  start(
    @Param('tenantId') t: string,
    @Body() body: PmLaunchStartDto,
    @Req() req: { user?: { sub?: string } },
  ) {
    this.assertTenant(t);
    return this.launch.start(t, body, req.user?.sub ?? '');
  }

  @Post('plans/:id/retry')
  retry(@Param('tenantId') t: string, @Param() p: IdParam) {
    this.assertTenant(t);
    return this.launch.retry(t, p.id);
  }

  @Post('plans/:id/create-paused')
  create(
    @Param('tenantId') t: string,
    @Param() p: IdParam,
    @Body() body: PmLaunchCreateDto,
    @Req() req: { user?: { sub?: string } },
  ) {
    this.assertTenant(t);
    return this.launch.createPaused(
      t,
      p.id,
      body.checklist,
      req.user?.sub ?? '',
    );
  }
}
