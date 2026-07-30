import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * The Custom-brief submission from the creative page.
 *
 * IMPORTANT — every field the frontend sends MUST be declared here. `main.ts`
 * registers `ValidationPipe({ whitelist: true })`, which silently strips any
 * property without a decorator. An undeclared field does not error; it simply
 * never reaches the pipeline, which is exactly how a selection would appear to
 * be ignored for no visible reason. (See the whitelist-trap comments in
 * companies/dto/create-company.dto.ts — this repo has been bitten twice.)
 *
 * Only `prompt` is required. Everything else is a hint: anything left unset
 * means "let the pipeline decide", which is its normal behaviour and the whole
 * point of the Custom-brief path.
 */
export class StartRunDto {
  /** 'create' authors + generates creatives; 'research' builds the research doc + idea board. */
  @IsIn(['create', 'research'])
  method: 'create' | 'research';

  @IsString()
  @IsNotEmpty()
  prompt: string;

  /**
   * How many creatives (or research targets) to produce.
   *
   * Typed as a string because it comes from a text input the operator usually
   * leaves empty, and an empty string must mean "use the default" rather than
   * fail validation. The pipeline clamps it (blank/unparseable -> 5, max 50);
   * duplicating that rule here would just create two places to keep in sync.
   */
  @IsOptional()
  @IsString()
  count?: string;

  /** Explicit, so the pipeline's own domain/track classifier is skipped entirely. */
  @IsOptional()
  @IsIn(['polished', 'raw'])
  track?: 'polished' | 'raw';

  @IsOptional()
  @IsIn(['astro', 'automotive'])
  domain?: 'astro' | 'automotive';

  /** Required by the pipeline for polished astro creatives; it returns 400 if absent. */
  @IsOptional()
  @IsString()
  language?: string;

  /**
   * Several languages SPLIT the run round-robin rather than multiplying it: count 5 over 3
   * languages is 5 creatives, not 15. The pipeline owns that assignment so the two sides cannot
   * disagree about which creative is in which language.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  /** A `value` from GET /pipeline-bridge/:tenantId/options -> formats. */
  @IsOptional()
  @IsString()
  format?: string;

  /** Multi-select formats; supersedes the single `format` when both are sent. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  formats?: string[];

  /** `value`s from GET /pipeline-bridge/:tenantId/options -> angles. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  angles?: string[];

  /**
   * Reference images already stored by POST /pipeline-bridge/:tenantId/uploads.
   *
   * `@IsArray()` only — the element shape ({ filename, s3_url }) is the pipeline's contract and is
   * validated there. Declaring it as a nested DTO here would mean two places to keep in sync, and
   * whitelist:true would silently strip anything the nested class did not know about.
   */
  @IsOptional()
  @IsArray()
  image_refs?: Array<{ filename: string; s3_url: string | null }>;

  /**
   * What the pipeline should do with the attached image. REQUIRED by the pipeline whenever
   * `image_refs` is set — Slack asks this with a button after an upload, but this form has no
   * follow-up turn, so it is answered up front.
   */
  @IsOptional()
  @IsIn(['located_overlay', 'product_reference', 'shape_reference'])
  image_direction?: 'located_overlay' | 'product_reference' | 'shape_reference';

  @IsOptional()
  @IsString()
  quality?: string;

  @IsOptional()
  @IsString()
  model?: string;
}
