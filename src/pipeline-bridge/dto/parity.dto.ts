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

/** Only the models Slack's "Switch model" menu offered; creativebot refuses others with the list. */
export class SetModelDto {
  @IsString()
  @IsNotEmpty()
  model: string;

  @IsOptional()
  @IsString()
  quality?: string;
}

export class RetryDto {
  @IsOptional()
  @IsIn(['preview', 'full'])
  step?: 'preview' | 'full';
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

  /** Answers the sibling disclaimer gate in the same call (`tnc` | `ex_showroom`). */
  @IsOptional()
  @IsString()
  disclaimer?: string;
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

/** `language` for one, `languages` to split the run across several. At least one is required. */
export class LanguageDto {
  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  languages?: string[];
}

export class ImageKindDto {
  @IsIn(['overlay', 'product', 'imitate', 'imitate_text'])
  kind: 'overlay' | 'product' | 'imitate' | 'imitate_text';

  @IsOptional()
  @IsString()
  text?: string;
}

export class OfferingDto {
  @IsString()
  @IsNotEmpty()
  offering: string;
}

/** Not re-validated: the allowed choices differ by domain and creativebot answers with the list. */
export class DisclaimerDto {
  @IsString()
  @IsNotEmpty()
  choice: string;
}
