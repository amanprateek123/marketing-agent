import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One creative's place in a batch — the per-creative slot plan (SLOT-CONTRACT.md, 2026-09-30).
 *
 * The pipeline treats every field here as the source of truth for THAT creative ("explicit fields
 * win verbatim"); anything left unset is filled by the pipeline's own rules (angles cycle, raw looks
 * spread). Every key the contract names is declared, because this is a nested class under
 * `whitelist: true`: an undeclared key inside a slot is stripped exactly like an undeclared
 * top-level field, and the creative would quietly be authored without it.
 *
 * `angle` / `hook_type` / `visual_direction` are plain strings, not `@IsIn`: their legal values are
 * owned by the pipeline (api_options.ANGLES, the raw / polished visual-direction guides), which
 * refuses an unknown one in plain words. A second list here would be the drift the `count` note on
 * StartRunDto warns about.
 */
export class CreativeSlotDto {
  /** 1-based position in the batch. */
  @IsInt()
  @Min(1)
  slot: number;

  @IsOptional()
  @IsIn(['polished', 'raw'])
  track?: 'polished' | 'raw';

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  angle?: string;

  @IsOptional()
  @IsString()
  hook_type?: string;

  @IsOptional()
  @IsString()
  visual_direction?: string;

  /** The brain hypothesis this creative tests, when it tests one. */
  @IsOptional()
  @IsInt()
  hypothesis_id?: number;

  @IsOptional()
  @IsIn(['proven', 'variant', 'seed'])
  hypothesis_kind?: 'proven' | 'variant' | 'seed';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hypothesis_statement?: string;

  /** Free text for the author. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

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

  /**
   * A weighted per-creative style mix, e.g. ['polished', 'polished', 'raw'] — the pipeline's
   * `tracks`. Declared so whitelist:true does not delete it; values are the pipeline's to police.
   */
  @IsOptional()
  @IsArray()
  @IsIn(['polished', 'raw'], { each: true })
  tracks?: Array<'polished' | 'raw'>;

  @IsOptional()
  @IsIn(['astro', 'automotive'])
  domain?: 'astro' | 'automotive';

  /**
   * WHICH 91Astrology product the creative is for — a `value` from
   * GET /pipeline-bridge/:tenantId/options -> offerings.
   *
   * This field's absence was a live bug, and a textbook instance of the whitelist trap this
   * file's header warns about. Without it declared here, `ValidationPipe({ whitelist: true })`
   * stripped any product the creative page sent, so the pipeline received none, stamped
   * `research_slug` NULL, and fell back to its manifest default — every dashboard astro creative
   * was authored from the Nadi research pack, filed to the Nadi S3 folder and labelled "Nadi
   * Report" regardless of the brief. 66 runs in 30 days (2026-09-23).
   *
   * Optional here rather than `@IsNotEmpty()` on purpose: the pipeline owns the rule (it is
   * required for an astro create, not for automotive or research) and duplicating that condition
   * here would give two places to keep in sync, which is what the `count` comment above warns
   * about. The creative page enforces it in the UI so the operator cannot submit without one.
   */
  @IsOptional()
  @IsString()
  offering?: string;

  /**
   * WHICH disclaimer the creative carries — a `value` from
   * GET /pipeline-bridge/:tenantId/options -> disclaimers, keyed by domain.
   *
   * Declared for exactly the reason `offering` above is: without it,
   * `ValidationPipe({ whitelist: true })` deletes it before the bridge sees it, and the operator's
   * choice vanishes with no error anywhere.
   *
   * Optional, and deliberately NOT constrained with `@IsIn` here: the legal values differ by
   * domain and are owned by the pipeline, which answers 400 naming them. Listing them again here
   * would be the second copy the `count` note warns about. Omitted means the domain default —
   * for astro, no disclaimer.
   */
  @IsOptional()
  @IsString()
  disclaimer_choice?: string;

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
  @IsIn([
    'located_overlay',
    'product_reference',
    'shape_reference',
    'shape_reference_with_text',
  ])
  image_direction?:
    | 'located_overlay'
    | 'product_reference'
    | 'shape_reference'
    | 'shape_reference_with_text';

  /**
   * The explicit per-creative plan: one entry per creative, in batch order. When present the
   * pipeline authors creative N as `slots[N-1]` says (its angle, look, hook, hypothesis) instead of
   * choosing. The legacy unordered `angles` list still works when this is absent.
   *
   * A nested DTO rather than `@IsArray()` alone (the opposite call to `image_refs` above) on
   * purpose: these fields are the operator's own choices, typed on this form, so a malformed one
   * should be a 400 here in plain terms, not a creative quietly authored without it.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreativeSlotDto)
  slots?: CreativeSlotDto[];

  @IsOptional()
  @IsString()
  quality?: string;

  @IsOptional()
  @IsString()
  model?: string;
}
