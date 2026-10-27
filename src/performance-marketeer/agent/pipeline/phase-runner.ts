/**
 * Runs one pipeline phase as one Agent SDK query() (docs/performance-marketeer/09):
 * our read-only tools as an in-process MCP server `pm`, structured output
 * validated with zod, then the phase .md (front-matter + narrative + items)
 * and its raw .json written by code. The orchestrator only ever reads the JSON.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { z } from 'zod';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  InvestigateOutput,
  Issue,
  PHASE_SCHEMAS,
  PlanOutput,
  PlanVerifyOutput,
  PmEvidence,
  PmPhase,
  PmToolCtx,
  VerifyOutput,
} from '../pm-agent.types';
import { PmToolDef, runPmTool } from '../tools/pm-tool';

export type PhaseOutput<P extends PmPhase> = z.infer<(typeof PHASE_SCHEMAS)[P]>;

const BUILTIN_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
];
const BLOCKED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit'];
const MAX_TURNS = 120;
const envNum = (key: string, def: number) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** Thrown when a phase fails; carries what was spent so the run can still log it. */
export class PmPhaseError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
  }
}

/**
 * evidence.jsonl of one campaign run: ids ev-1, ev-2 … shared by every phase
 * and round, numbering continues from the existing file (resume-safe).
 * Appends are synchronous so parallel tool calls never share an id.
 */
export class EvidenceLog {
  private last = 0;
  constructor(readonly file: string) {
    for (const e of readEvidence(file))
      this.last = Math.max(this.last, Number(e.id.slice(3)) || 0);
  }
  record(
    phase: PmEvidence['phase'],
    round: number,
    tool: string,
    args: unknown,
    result: unknown,
  ) {
    const line: PmEvidence = {
      id: `ev-${++this.last}`,
      at: new Date().toISOString(),
      phase,
      round,
      tool,
      args,
      result,
    };
    appendFileSync(this.file, JSON.stringify(line) + '\n');
    return line.id;
  }
}

export function readEvidence(file: string): Pick<PmEvidence, 'id' | 'tool'>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as PmEvidence;
        return typeof e.id === 'string' ? [{ id: e.id, tool: e.tool }] : [];
      } catch {
        return []; // a line cut by a crash mid-write
      }
    });
}

export interface PathScope {
  /** campaigns/<campaignId>/ — any date folder up to `date` is readable. */
  campaignRoot: string;
  date: string;
  /** day/<date>/ */
  dayDir: string;
}

/** Read/Glob/Grep only inside this campaign's folders up to the run date, and day/<date>/. */
export function pathAllowed(p: string, scope: PathScope): boolean {
  const inside = (root: string) => {
    const r = relative(root, p);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  if (inside(scope.dayDir)) return true;
  if (!inside(scope.campaignRoot)) return false;
  const first = relative(scope.campaignRoot, p).split(sep)[0];
  return (
    first === '' || (/^\d{4}-\d{2}-\d{2}$/.test(first) && first <= scope.date)
  );
}

function guardHook(scope: PathScope, cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const a = (input.tool_input ?? {}) as Record<string, unknown>;
    const str = (k: string) =>
      typeof a[k] === 'string' ? (a[k] as string) : undefined;
    const paths: string[] = [];
    if (input.tool_name === 'Read') paths.push(str('file_path') ?? '');
    else {
      paths.push(str('path') ?? cwd);
      // A Glob pattern can itself be absolute or climb out with '..': check its fixed prefix.
      const pat = input.tool_name === 'Glob' ? str('pattern') : str('glob');
      if (pat && (isAbsolute(pat) || pat.includes('..')))
        paths.push(pat.split(/[*?[{]/)[0] || '/');
    }
    const bad = paths
      .map((p) => resolve(cwd, p))
      .find((p) => !pathAllowed(p, scope));
    if (!bad) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${bad} is outside this campaign's folders and day/${scope.date}/`,
      },
    };
  };
}

export interface RunPhaseArgs<P extends PmPhase> {
  phase: P;
  round: number;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools: PmToolDef[];
  ctx: Omit<PmToolCtx, 'record' | 'phase' | 'round'>;
  evidence: EvidenceLog;
  scope: PathScope;
  /** Absolute path of the phase .md; the JSON goes to `${file}.json`. */
  file: string;
}

export interface PhaseResult<P extends PmPhase> {
  output: PhaseOutput<P>;
  costUsd: number;
  reused: boolean;
}

/** Run one phase, or reuse its saved JSON from an earlier attempt of the same date/round. */
export async function runPhase<P extends PmPhase>(
  a: RunPhaseArgs<P>,
): Promise<PhaseResult<P>> {
  const schema = PHASE_SCHEMAS[a.phase] as unknown as z.ZodType<PhaseOutput<P>>;
  const saved = `${a.file}.json`;
  if (existsSync(saved)) {
    const r = schema.safeParse(JSON.parse(readFileSync(saved, 'utf8')));
    if (r.success) return { output: r.data, costUsd: 0, reused: true };
  }
  // Dynamic import — @anthropic-ai/claude-agent-sdk is ESM-only.
  const { query, tool, createSdkMcpServer } =
    await import('@anthropic-ai/claude-agent-sdk');
  const ctx: PmToolCtx = {
    ...a.ctx,
    phase: a.phase,
    round: a.round,
    record: async (name, args, result) =>
      a.evidence.record(a.phase, a.round, name, args, result),
  };
  const server = createSdkMcpServer({
    name: 'pm',
    version: '1.0.0',
    tools: a.tools.map((d) =>
      tool(d.name, d.description, d.shape, (args) => runPmTool(d, args, ctx)),
    ),
  });
  const timeoutMs = envNum('PM_AGENT_PHASE_TIMEOUT_MIN', 40) * 60_000;
  const jsonSchema = z.toJSONSchema(PHASE_SCHEMAS[a.phase], {
    target: 'draft-7',
  }) as Record<string, unknown>;

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
      tools: BUILTIN_TOOLS,
      allowedTools: [
        ...a.tools.map((d) => `mcp__pm__${d.name}`),
        ...BUILTIN_TOOLS,
      ],
      disallowedTools: BLOCKED_TOOLS,
      permissionMode: 'dontAsk',
      hooks: {
        PreToolUse: [
          { matcher: 'Read|Glob|Grep', hooks: [guardHook(a.scope, a.ctx.dir)] },
        ],
      },
      settingSources: [],
      cwd: a.ctx.dir,
      persistSession: false,
      maxTurns: MAX_TURNS,
      maxBudgetUsd: envNum('PM_AGENT_MAX_USD_PER_PHASE', 15),
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
      failure = abort.signal.aborted
        ? `timed out after ${timeoutMs / 60_000} min`
        : (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    const structuredFailure = failure.startsWith(
      'error_max_structured_output_retries',
    );
    if (failure && !structuredFailure)
      throw new PmPhaseError(`${a.phase} v${a.round}: ${failure}`, costUsd);
    const r = schema.safeParse(structured);
    if (r.success) {
      writeFileSync(saved, JSON.stringify(r.data, null, 2));
      return { output: r.data, costUsd, reused: false };
    }
    const why = structuredFailure ? failure : z.prettifyError(r.error);
    if (attempt >= 2)
      throw new PmPhaseError(
        `${a.phase} v${a.round}: invalid structured output: ${why}`,
        costUsd,
      );
    prompt = `${a.userMessage}\n\nYour previous attempt's structured output was rejected:\n${why}\nRedo the phase and return output that matches the schema exactly.`;
  }
}

// ---------------------------------------------------------------- phase .md

export interface PhaseFileMeta {
  phase: PmPhase;
  campaignId: string;
  round: number;
  model: string;
  costUsd: number;
  /** Verify phases: code's send-back decision. */
  verdict?: 'pass' | 'send_back';
}

const evs = (ids: string[]) => (ids.length ? ` [${ids.join(', ')}]` : '');
const issueLine = (i: Issue) =>
  `- ${i.id} · ${i.severity}${i.target ? ` · on ${i.target}` : ''} — ${i.claim} Checked: ${i.checked} Required: ${i.requiredChange}${evs(i.evidence)}`;
const replies = (r: InvestigateOutput['issueReplies']) =>
  r.length
    ? [
        '',
        '### Issue replies',
        ...r.map(
          (x) => `- ${x.issueId} · ${x.reply} — ${x.note}${evs(x.evidence)}`,
        ),
      ]
    : [];
const list = (title: string, xs: string[]) =>
  xs.length ? ['', `### ${title}`, ...xs.map((x) => `- ${x}`)] : [];
const lessons = (ids: string[]) =>
  ids.length ? ` · lessons ${ids.join(', ')}` : '';
const contradicted = (xs: InvestigateOutput['lessonsContradicted']) =>
  list(
    'Lessons contradicted',
    xs.map((x) => `${x.id} — ${x.note}${evs(x.evidence)}`),
  );

function items(phase: PmPhase, o: unknown): string[] {
  switch (phase) {
    case 'investigate': {
      const x = o as InvestigateOutput;
      return [
        '### Causes',
        ...x.causes.map(
          (c) =>
            `- ${c.id} · ${c.category} · conf ${c.confidence} · ₹${Math.round(c.impactRupeesPerDay)}/day (${c.impactEvidence}) · ${c.evidenceStrength}${lessons(c.lessonIds)} — ${c.title}${evs(c.evidence)}`,
        ),
        ...list(
          'Ruled out',
          x.ruledOut.map((r) => `${r.title}${evs(r.evidence)}`),
        ),
        ...replies(x.issueReplies),
        ...list('Data gaps', x.dataGaps),
        ...contradicted(x.lessonsContradicted),
      ];
    }
    case 'verify': {
      const x = o as VerifyOutput;
      return [
        ...list('Blind list (before reading the investigation)', x.blindList),
        '',
        '### Cause verdicts',
        ...x.causeVerdicts.map(
          (v) =>
            `- ${v.causeId} · ${v.verdict} · conf ${v.confidence} — ${v.note}${evs(v.evidence)}`,
        ),
        ...list(
          'Added causes',
          x.addedCauses.map(
            (c) =>
              `${c.id} · ${c.category} · conf ${c.confidence} · ₹${Math.round(c.impactRupeesPerDay)}/day${lessons(c.lessonIds)} — ${c.title}${evs(c.evidence)}`,
          ),
        ),
        ...(x.issues.length
          ? ['', '### Issues', ...x.issues.map(issueLine)]
          : []),
        ...list('Confirmed right', x.confirmedRight),
        ...contradicted(x.lessonsContradicted),
      ];
    }
    case 'plan': {
      const x = o as PlanOutput;
      return [
        `Path to target: ${x.pathToTarget}`,
        '',
        '### Actions',
        ...x.actions.map(
          (a) =>
            `- ${a.id} · ${a.type} · ${a.entityLevel} "${a.entityName}" (${a.entityId}) · ${a.change.field}: ${a.change.from} → ${a.change.to} · conf ${a.confidence} · ₹${Math.round(a.impactRupeesPerDay)}/day · causes ${a.causeIds.join(', ') || '-'} · judge ${a.judgeOn}${lessons(a.lessonIds)} — ${a.title}`,
        ),
        ...replies(x.issueReplies),
        ...contradicted(x.lessonsContradicted),
      ];
    }
    case 'plan_verify': {
      const x = o as PlanVerifyOutput;
      return [
        '### Action verdicts',
        ...x.actionVerdicts.map(
          (v) => `- ${v.actionId} · ${v.verdict} — ${v.note}${evs(v.evidence)}`,
        ),
        ...(x.issues.length
          ? ['', '### Issues', ...x.issues.map(issueLine)]
          : []),
        ...list('Confirmed right', x.confirmedRight),
        ...contradicted(x.lessonsContradicted),
      ];
    }
  }
}

/** Writes the phase .md: front-matter, the model's narrative, then its items with ids. */
export function writePhaseFile(
  file: string,
  meta: PhaseFileMeta,
  output: PhaseOutput<PmPhase>,
) {
  const fm: Record<string, string | number> = {
    phase: meta.phase,
    campaign: meta.campaignId,
    round: meta.round,
    model: meta.model,
  };
  if ('issues' in output) {
    const sev = (s: string) =>
      output.issues.filter((i) => i.severity === s).length;
    if (meta.verdict) fm.verdict = meta.verdict;
    fm.blockers = sev('blocker');
    fm.majors = sev('major');
    fm.minors = sev('minor');
  }
  fm.costUsd = Math.round(meta.costUsd * 100) / 100;
  const text = [
    '---',
    ...Object.entries(fm).map(
      ([k, v]) => `${k}: ${typeof v === 'number' ? v : JSON.stringify(v)}`,
    ),
    '---',
    output.markdown.trim(),
    '',
    '## Items',
    ...items(meta.phase, output),
    '',
  ].join('\n');
  writeFileSync(file, text);
}
