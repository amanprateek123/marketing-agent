import type { PmToolCtx } from '../pm-agent.types';

/**
 * Shared shape of one Performance Marketeer tool. Groups export
 * `(deps) => PmToolDef[]`; the orchestrator turns them into SDK MCP tools per
 * phase call (binding the PmToolCtx), so every result is logged to
 * evidence.jsonl and comes back to the model with its evidence id.
 */
export interface PmToolDef {
  name: string; // snake_case, e.g. 'campaign_overview'
  description: string;
  /** zod raw shape (an object of zod types), as the SDK's tool() expects. */
  shape: Record<string, any>;
  /** Return plain JSON. Throw for bad input; the message goes to the model. */
  run(args: any, ctx: PmToolCtx): Promise<unknown>;
  /** Result is not evidence (e.g. file writes) — skip evidence.jsonl. */
  noEvidence?: boolean;
}

/** Results bigger than this are cut so one call can't flood the context. */
export const MAX_TOOL_RESULT_CHARS = 60_000;

export async function runPmTool(
  def: PmToolDef,
  args: unknown,
  ctx: PmToolCtx,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const result = await def.run(args, ctx);
    const ev = def.noEvidence ? undefined : await ctx.record(def.name, args, result);
    let text = JSON.stringify(ev ? { ev, result } : result);
    if (text.length > MAX_TOOL_RESULT_CHARS)
      text = text.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated: narrow the query]';
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `error: ${(e as Error).message}` }],
      isError: true,
    };
  }
}
