import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Bodies for the three post-delivery actions the Slack pipeline exposes.
 *
 * Same whitelist trap as StartRunDto: `ValidationPipe({ whitelist: true })` silently strips any
 * property without a decorator, so an undeclared field does not error — it simply never reaches the
 * pipeline, and the action appears to have been ignored for no visible reason.
 */

/** Revise: change the brief in words, then regenerate. Mirrors Slack's Revise button. */
export class ReviseDto {
  @IsString()
  @IsNotEmpty()
  instruction: string;
}

/** Regenerate: edit the delivered image in place from free text. No brief change. */
export class RegenerateDto {
  @IsString()
  @IsNotEmpty()
  instruction: string;

  /**
   * Which image to edit — `main` is the 1200x1200 base, otherwise a size profile. Constrained
   * because the pipeline maps `main` onto the base profile and would treat an unknown tag as a
   * size that does not exist.
   */
  @IsOptional()
  @IsIn(['main', '1200x1200', '1200x1500', '1080x1920', '1200x628'])
  tag?: string;
}

/**
 * The answer to a question a stalled revise asked.
 *
 * When the brief editor cannot pinpoint an edit it parks the run and asks. Slack clears that with a
 * thread reply; the dashboard has no thread, so this is how the run continues instead of hanging.
 */
export class ClarifyDto {
  @IsString()
  @IsNotEmpty()
  answer: string;
}
