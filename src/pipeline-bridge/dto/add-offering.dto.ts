import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

/**
 * Onboarding a new 91Astrology product from its landing page.
 *
 * Same whitelist rule as `StartRunDto`: `main.ts` registers
 * `ValidationPipe({ whitelist: true })`, which silently DELETES any property not declared here.
 * An undeclared field does not error — it just never reaches the pipeline.
 *
 * Only the URL is required. The pipeline derives the slug and display name from it when they are
 * absent, the same way a person would (`/graha-kavach-report` -> `graha_kavach_report`), so there
 * is one rule for that rather than two.
 */
export class AddOfferingDto {
  /**
   * The product's landing page. This is both what the research pack is scraped FROM and what
   * attributes the product's ads afterwards, which is why it is the one required field.
   *
   * `require_tld` is left on (the default) so a typo like `91astrology/foo` is rejected here rather
   * than failing deep inside a headless browser.
   */
  @IsUrl({ require_protocol: false })
  @IsNotEmpty()
  landing_url: string;

  /** e.g. 'Graha Kavach Report'. Derived from the URL path when omitted. */
  @IsOptional()
  @IsString()
  display_name?: string;

  /** Override the derived manifest slug. Lowercase, underscores. */
  @IsOptional()
  @IsString()
  slug?: string;

  /**
   * Skip the browser and plain-fetch the page instead.
   *
   * Faster, but the collapsed FAQ answers and the live price are only reachable with a render, so
   * the pack comes out thinner. Off by default for that reason.
   */
  @IsOptional()
  @IsBoolean()
  no_render?: boolean;
}
