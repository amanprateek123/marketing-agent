import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { CuratorEvidence, CuratorOutput, runCurator } from './curator';

const calls: any[] = [];
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _d: string, _s: unknown, handler: (a: unknown) => unknown) => ({ name, handler }),
  createSdkMcpServer: (o: { tools: { name: string; handler: (a: unknown) => unknown }[] }) => o,
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    return (async function* () {
      // The "model" calls one tool, then answers.
      await options.mcpServers.pm.tools[0].handler({ metric: 'cvr' });
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.5,
        structured_output:
          calls.length === 1
            ? { summary: 'x' } // invalid first time → one retry
            : {
                summary: 'One new candidate.',
                deltas: [{ op: 'ADD', why: 'repeats', lesson: { type: 'segment_fact', statement: 'When…', scope: {}, claim: { kind: 'measured', metric: 'cvr' } }, cases: [{ ref: 'cev-1', supports: true, campaignId: 'c1', at: '2026-10-20' }] }],
                markdown: '- ADD segment fact (cev-1)',
              },
      };
    })();
  },
}));

describe('runCurator', () => {
  it('runs with only pm tools, logs cev evidence, retries bad output and saves curator.md(.json)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-cur-'));
    const evidence = new CuratorEvidence(join(dir, 'evidence.jsonl'));
    const args = {
      model: 'm',
      systemPrompt: 's',
      userMessage: 'u',
      tools: [{ name: 'measure_segment', description: 'd', shape: { metric: z.string() }, run: async () => ({ cvr: 2 }) }],
      tenantId: 't',
      week: '2026-W44',
      date: '2026-10-26',
      dir,
      evidence,
      file: join(dir, 'curator.md'),
    };
    const r = await runCurator(args);
    expect(r.reused).toBe(false);
    expect(r.costUsd).toBe(1);
    expect(CuratorOutput.parse(r.output).deltas).toHaveLength(1);
    expect(calls[0].options.tools).toEqual([]);
    expect(calls[0].options.allowedTools).toEqual(['mcp__pm__measure_segment']);
    expect(calls[0].options.settingSources).toEqual([]);
    expect(calls[1].prompt).toContain('rejected');
    expect(evidence.read()).toEqual([
      { id: 'cev-1', tool: 'measure_segment' },
      { id: 'cev-2', tool: 'measure_segment' },
    ]);
    expect(readFileSync(join(dir, 'curator.md'), 'utf8')).toContain('week: "2026-W44"');
    expect(existsSync(join(dir, 'curator.md.json'))).toBe(true);
    // Saved JSON is reused without calling the model again.
    const again = await runCurator(args);
    expect(again.reused).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
