import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * The inputs the console sends when starting an agent.
 *
 * EVERY FIELD ANY AGENT ACCEPTS MUST BE DECLARED HERE. `main.ts` registers
 * `ValidationPipe({ whitelist: true })`, which silently strips undeclared properties — an
 * undeclared field does not error, it simply never reaches Foundry. A question typed into the
 * console would arrive as an empty run and the Brain would do a full portfolio review instead of
 * answering it, with nothing anywhere to say why. This repo has been bitten by the whitelist trap
 * twice before; the fix is to keep this class in step with `agents.registry.ts`.
 *
 * Everything is optional. The Brain with no inputs is a full portfolio review, which is its normal
 * unattended behaviour — an empty body is a legitimate request, not a malformed one.
 */
export class StartAgentRunDto {
  /** What a conversational surface sends. The Brain treats it and `question` identically. */
  @IsOptional()
  @IsString()
  message?: string;

  /** The original single-shot field, kept because the Brain's trigger still declares it. */
  @IsOptional()
  @IsString()
  question?: string;

  @IsOptional()
  @IsIn(['decide', 'sense', 'allocate', 'consolidate'])
  mode?: 'decide' | 'sense' | 'allocate' | 'consolidate';

  /** Allocate mode only. YYYY-MM-DD. */
  @IsOptional()
  @IsString()
  plan_date?: string;

  /** Narrows a review to particular products. The Brain caps it at eight. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  offering_slugs?: string[];

  /**
   * The conversation thread this turn belongs to.
   *
   * Set by the conversation route, not typed by an operator. Without it the Brain cannot call
   * `conversation_read` and every message starts the thread over.
   */
  @IsOptional()
  @IsString()
  session_id?: string;

  /** Competitor Research: the observations to turn into learnings. */
  @IsOptional()
  @IsString()
  observations?: string;

  /** Report and Analyst: the reporting window. */
  @IsOptional()
  @IsIn(['last_7d', 'last_30d', 'last_90d'])
  window?: 'last_7d' | 'last_30d' | 'last_90d';
}
