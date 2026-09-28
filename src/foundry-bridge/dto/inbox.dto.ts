import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** POST brain/:t/questions — a question for the Brain, asked from the dashboard. */
export class AskQuestionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}

/** One competitor as the Competitors page edits it. */
export class CompetitorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  facebookPage?: string | null;

  /** Offering slugs this competitor competes with. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  products?: string[];
}

/** PUT brain/:t/competitors — the whole list, replacing what is stored. */
export class SaveCompetitorsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompetitorDto)
  competitors: CompetitorDto[];
}

/** POST brain/:t/competitors/candidates/:id/decision */
export class CandidateDecisionDto {
  @IsIn(['accept', 'reject'])
  decision: 'accept' | 'reject';

  @IsString()
  @MaxLength(1000)
  reason: string;
}
