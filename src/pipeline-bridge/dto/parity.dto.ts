import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Bodies for the creative-studio actions that used to live only behind Slack buttons.
 *
 * Same whitelist trap as every other DTO here: `ValidationPipe({ whitelist: true })` silently
 * strips any property without a decorator, so an undeclared field never reaches creativebot and
 * the action looks ignored. Values the pipeline owns (model names) are NOT re-validated here.
 */

export class SetModelDto {
  @IsString()
  @IsNotEmpty()
  model: string;
}

export class ApproveStageDto {
  @IsIn(['preview', 'full'])
  stage: 'preview' | 'full';
}

/** The four ad-copy fields the operator can edit before approving. All optional: send what changed. */
export class CampaignFieldsDto {
  @IsOptional()
  @IsString()
  headline?: string;

  @IsOptional()
  @IsString()
  primary_text?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  cta?: string;
}

export class DiscardIdeaDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class BadgeDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;
}

export class LogoDto {
  @IsBoolean()
  include: boolean;
}

export class ResearchSourcesDto {
  @IsBoolean()
  confirm: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  urls?: string[];
}

export class ResearchRerunDto {
  @IsIn(['reuse', 'rerun'])
  choice: 'reuse' | 'rerun';
}

export class ResearchPdfDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;

  @IsString()
  @IsNotEmpty()
  product: string;
}

export class LearnDecisionDto {
  @IsIn(['approve', 'reject', 'edit'])
  decision: 'approve' | 'reject' | 'edit';

  @IsOptional()
  @IsString()
  text?: string;
}
