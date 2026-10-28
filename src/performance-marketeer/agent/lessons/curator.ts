/**
 * Weekly lessons curator run: one Agent SDK query() with read-only record +
 * lesson tools as the in-process MCP server `pm`, structured output (zod →
 * JSON Schema), evidence.jsonl with cev-N ids. Same pattern as
 * pipeline/phase-runner.ts, which is typed to the 4 campaign phases. No
 * built-in tools at all (no files, no web), so no path guard is needed.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { z } from 'zod';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { PmPhase, PmToolCtx } from '../pm-agent.types';
import { PmToolDef, runPmTool } from '../tools/pm-tool';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LessonType = z.enum([
  'action_effect',
  'diagnosis_pattern',
  'creative_pattern',
  'season_effect',
  'segment_fact',
  'analyst_habit',
]);
const Verdict = z.enum(['worked', 'no_effect', 'hurt']);
const Claim = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action_effect'),
    action: z.object({
      type: z.string(),
      field: z.string().optional(),
      direction: z.enum(['up', 'down']).optional(),
      maxStep: z.number().optional(),
    }),
    expect: Verdict,
    effect: z
      .object({ metric: z.string(), median: z.number(), low: z.number(), high: z.number() })
      .optional(),
  }),
  z.object({ kind: z.literal('diagnosis_pattern'), category: z.string(), holds: z.boolean() }),
  z.object({
    kind: z.literal('measured'),
    metric: z.string(),
    median: z.number().optional(),
    low: z.number().optional(),
    high: z.number().optional(),
  }),
]);
const Case = z.object({
  ref: z.string(),
  supports: z.boolean(),
  campaignId: z.string(),
  at: Day,
});
const LessonDraft = z.object({
  type: LessonType.optional(),
  statement: z.string().optional(),
  because: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
  claim: Claim.optional(),
});
export const CuratorDelta = z.object({
  op: z.enum(['ADD', 'EDIT', 'ATTACH', 'MERGE', 'RETIRE']),
  /** EDIT / ATTACH / RETIRE target. */
  lessonId: z.string().optional(),
  /** MERGE sources. */
  mergeIds: z.array(z.string()).optional(),
  /** ADD / MERGE: the full lesson; EDIT: only the changed fields. */
  lesson: LessonDraft.optional(),
  /** ADD / ATTACH: cited cases. */
  cases: z.array(Case).optional(),
  why: z.string(),
});
export type CuratorDelta = z.infer<typeof CuratorDelta>;
export const CuratorOutput = z.object({
  summary: z.string(),
  deltas: z.array(CuratorDelta).max(25),
  markdown: z.string(),
});
export type CuratorOutput = z.infer<typeof CuratorOutput>;

/** evidence.jsonl of one curator week: ids cev-1, cev-2 … (resume-safe). */
export class CuratorEvidence {
  private last = 0;
  constructor(readonly file: string) {
    for (const e of this.read()) this.last = Math.max(this.last, Number(e.id.slice(4)) || 0);
  }
  record(tool: string, args: unknown, result: unknown): string {
    const id = `cev-${++this.last}`;
    appendFileSync(this.file, JSON.stringify({ id, at: new Date().toISOString(), tool, args, result }) + '\n');
    return id;
  }
  read(): { id: string; tool: string }[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const e = JSON.parse(l);
          return typeof e.id === 'string' ? [{ id: e.id as string, tool: String(e.tool) }] : [];
        } catch {
          return []; // a line cut by a crash mid-write
        }
      });
  }
}

export interface RunCuratorArgs {
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools: PmToolDef[];
  tenantId: string;
  week: string;
  date: string;
  /** lessons/<week>/ */
  dir: string;
  evidence: CuratorEvidence;
  /** curator.md — the JSON goes to `${file}.json`. */
  file: string;
}

const envNum = (key: string, def: number) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export async function runCurator(
  a: RunCuratorArgs,
): Promise<{ output: CuratorOutput; costUsd: number; reused: boolean }> {
  const saved = `${a.file}.json`;
  if (existsSync(saved)) {
    const r = CuratorOutput.safeParse(JSON.parse(readFileSync(saved, 'utf8')));
    if (r.success) return { output: r.data, costUsd: 0, reused: true };
  }
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  const ctx: PmToolCtx = {
    tenantId: a.tenantId,
    campaignId: '',
    date: a.date,
    dir: a.dir,
    // ponytail: PmToolCtx.phase has no 'curator' value; tools here ignore it.
    phase: 'curator' as PmPhase,
    round: 1,
    record: async (name, args, result) => a.evidence.record(name, args, result),
  };
  const server = createSdkMcpServer({
    name: 'pm',
    version: '1.0.0',
    tools: a.tools.map((d) => tool(d.name, d.description, d.shape, (args) => runPmTool(d, args, ctx))),
  });
  const jsonSchema = z.toJSONSchema(CuratorOutput, { target: 'draft-7' }) as Record<string, unknown>;
  const timeoutMs = envNum('PM_CURATOR_TIMEOUT_MIN', 40) * 60_000;

  let costUsd = 0;
  let prompt = a.userMessage;
  for (let attempt = 1; ; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const options: Options = {
      model: a.model,
      systemPrompt: a.systemPrompt,
      effort: 'high',
      outputFormat: { type: 'json_schema', schema: jsonSchema },
      mcpServers: { pm: server },
      tools: [],
      allowedTools: a.tools.map((d) => `mcp__pm__${d.name}`),
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'Agent'],
      permissionMode: 'dontAsk',
      settingSources: [],
      cwd: a.dir,
      persistSession: false,
      maxTurns: 120,
      maxBudgetUsd: envNum('PM_CURATOR_MAX_USD', 15),
      abortController: abort,
    };
    let structured: unknown;
    let failure = '';
    try {
      for await (const m of query({ prompt, options })) {
        if (m.type !== 'result') continue;
        costUsd += m.total_cost_usd ?? 0;
        if (m.subtype === 'success') structured = m.structured_output;
        else failure = `${m.subtype}: ${m.errors.join('; ')}`;
      }
    } catch (e) {
      failure = abort.signal.aborted ? `timed out after ${timeoutMs / 60_000} min` : (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    const structuredFailure = failure.startsWith('error_max_structured_output_retries');
    if (failure && !structuredFailure) throw new Error(`curator ${a.week}: ${failure} ($${costUsd.toFixed(2)} spent)`);
    const r = CuratorOutput.safeParse(structured);
    if (r.success) {
      writeFileSync(saved, JSON.stringify(r.data, null, 2));
      writeFileSync(
        a.file,
        [
          '---',
          `week: ${JSON.stringify(a.week)}`,
          `model: ${JSON.stringify(a.model)}`,
          `costUsd: ${Math.round(costUsd * 100) / 100}`,
          `deltas: ${r.data.deltas.length}`,
          '---',
          r.data.markdown.trim(),
          '',
        ].join('\n'),
      );
      return { output: r.data, costUsd, reused: false };
    }
    const why = structuredFailure ? failure : z.prettifyError(r.error);
    if (attempt >= 2) throw new Error(`curator ${a.week}: invalid structured output: ${why}`);
    prompt = `${a.userMessage}\n\nYour previous attempt's structured output was rejected:\n${why}\nReturn output that matches the schema exactly.`;
  }
}
