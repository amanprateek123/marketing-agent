import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefDocument } from '../pipeline/schemas/creative-brief.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CoordinatorResult } from '../pipeline/coordinator.service';
import { IdeaPoolResult } from '../pipeline/idea-pool.service';

interface CliResult {
  result: string;
  total_cost_usd: number;
  num_turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Strategy Team — 2-agent debate (Strategist + Contrarian) via CLI.
 *
 * Replaces the single-agent Idea Pool + rule-based winner selection.
 * Both agents receive the FULL context (coordinator signals, competitor
 * research, market research, company learnings) and debate which ideas
 * to pursue and which one should win.
 *
 * Uses `claude -p` CLI because agent teams require tmux + InboxPoller.
 */
@Injectable()
export class StrategyTeamService {
  private readonly logger = new Logger(StrategyTeamService.name);

  constructor(
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 5;

    this.logger.log(`Strategy Team starting | tenant: ${tenantId} | run: ${runId}`);

    const prompt = this.buildPrompt(
      company, runId, coordinatorResult, competitorResearch, marketResearch, ideasPerRun,
    );

    const cliResult = await this.runTeamViaCli(prompt);

    // Log usage
    await this.usageLogModel.create({
      tenantId,
      runId,
      agent: AgentType.STRATEGY_TEAM_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(
      `Strategy Team completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns} | cost: $${cliResult.total_cost_usd?.toFixed(4)}`,
    );

    const parsed = this.parseOutput(cliResult.result);

    // Assign briefIds
    const briefs = parsed.briefs ?? [];
    briefs.forEach((b: any) => { b.briefId = uuidv4(); });

    const winnerId = briefs.find((b: any) => b.selected)?.briefId ?? briefs[0]?.briefId ?? '';
    const winner = briefs.find((b: any) => b.briefId === winnerId);

    if (!winner) {
      throw new Error(`Strategy Team returned no usable ideas for run ${runId}`);
    }

    // Persist intelligence briefs
    await this.intelligenceBriefModel.insertMany(
      briefs.map((b: any) => ({
        tenantId,
        runId,
        briefId: b.briefId,
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.hook ?? '',
        keyMessage: b.keyMessage ?? '',
        conversionBridge: b.conversionBridge ?? '',
        confidenceScore: 0,
        urgencyScore: b.urgent ? 10 : 5,
        finalScore: b.priorityScore ?? 0,
        sourcePlatforms: b.sourcePlatforms ?? [],
        suggestedBudget: b.suggestedBudget ?? 0,
        selected: b.briefId === winnerId,
      })),
    );

    // Persist winning creative brief with debate history
    await this.creativeBriefModel.create({
      tenantId,
      runId,
      briefId: winnerId,
      topic: winner.topic,
      angle: winner.angle,
      platform: winner.platform,
      format: winner.format,
      audience: winner.audience,
      hook: winner.hook,
      keyMessage: winner.keyMessage,
      conversionBridge: winner.conversionBridge,
      suggestedBudget: winner.suggestedBudget ?? 0,
      finalScore: winner.priorityScore ?? 0,
      selected: true,
      selectionReason: winner.selectionReason ?? parsed.debateRationale ?? '',
      debateRounds: parsed.debateRounds ?? null,
      debateLog: parsed.debateLog ?? null,
      debateRationale: parsed.debateRationale ?? null,
    });

    this.logger.log(
      `Strategy Team persisted: ${briefs.length} briefs, winner=${winnerId} | run: ${runId}`,
    );

    return {
      briefs: briefs.map((b: any) => ({
        briefId: b.briefId,
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.hook ?? '',
        keyMessage: b.keyMessage ?? '',
        conversionBridge: b.conversionBridge ?? '',
        suggestedBudget: b.suggestedBudget ?? 0,
        finalScore: b.priorityScore ?? 0,
      })),
      selectedBriefId: winnerId,
      selectionReason: winner.selectionReason ?? parsed.debateRationale ?? '',
    };
  }

  private buildPrompt(
    company: CompanyDocument,
    runId: string,
    coordinator: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
    ideasPerRun: number,
  ): string {
    const liveContext = this.liveContextBuilder.build(company);
    const learnings = company.learnings;

    const topSignals = coordinator.topSignals
      .slice(0, 7)
      .map((s, i) =>
        `Signal ${i + 1} (score: ${s.compositeScore}) — "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`,
      )
      .join('\n');

    const learningsContext = learnings ? `
PAST LEARNINGS (what worked and what didn't):
- Winning hooks: ${learnings.creative?.winningHooks?.join(', ') || 'none yet'}
- Losing hooks: ${learnings.creative?.losingHooks?.join(', ') || 'none yet'}
- Winning formats: ${learnings.creative?.winningFormats?.join(', ') || 'none yet'}
- Top audience scores: ${learnings.campaign?.audienceScores ? Object.entries(learnings.campaign.audienceScores).sort(([,a],[,b]) => b - a).slice(0, 3).map(([k,v]) => `${k}: ${v}`).join(', ') : 'none yet'}
- Causal insights: ${learnings.causalInsights?.slice(0, 3).map(c => c.finding).join('; ') || 'none yet'}
` : '';

    return `
You ARE the Strategist. You will debate with a Contrarian to decide the best ${ideasPerRun} campaign ideas for ${company.name}.

STEP 1: Call TeamCreate with team_name "strategy-${runId}"

STEP 2: Spawn the Contrarian via Agent tool with these EXACT parameters:
  - name: "contrarian"
  - team_name: "strategy-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Contrarian on the Strategy Team for ${company.name}. Your job is to challenge weak ideas and push for better ones.

DEBATE PROTOCOL:
- You will receive ideas from the Strategist via SendMessage.
- For each idea: CHALLENGE it (why it's weak/saturated/risky) or ENDORSE it (why it's strong).
- Be tough but fair. Give specific reasons, not vague criticism.
- When the Strategist pushes back on your challenges, EITHER concede if their argument is strong OR double down with a stronger counterpoint.
- Keep debating until you reach genuine agreement. Don't cave easily — but don't be stubborn for no reason either.
- When you and the Strategist agree on the winner, send a final message: {type: 'consensus', winner: 'topic name', reason: 'why we agreed'}.
- MAX 5 rounds of back-and-forth. If no consensus by round 5, send your final ranking and let the Strategist decide.
- Send all messages to 'team-lead'. Respond IMMEDIATELY when you receive a message."

STEP 3: Propose ${ideasPerRun} campaign ideas based on the data below. Send them to the Contrarian via SendMessage(to: "contrarian"). Label this as "ROUND 1".

STEP 4: The Contrarian will challenge or endorse each idea. When you receive their response:
  - If you AGREE with a challenge → kill or weaken that idea
  - If you DISAGREE → push back with a counter-argument: "I hear you, but here's why this still works..."
  - Send your response back to the Contrarian via SendMessage(to: "contrarian"). Label it "ROUND 2".

STEP 5: Continue the debate. The Contrarian may concede, double down, or propose alternatives.
  - Keep going until one of these happens:
    a) You both agree on the winner (consensus)
    b) You've done 5 rounds — make your final call
  - Each round: read their message, respond with counter-arguments or agreements

STEP 6: Once debate is settled, call TeamDelete to clean up.

STEP 7: Return ONLY this JSON (no markdown, no explanation):
{
  "briefs": [
    {
      "topic": "...",
      "angle": "...",
      "platform": "instagram|youtube|twitter|reddit",
      "format": "reel|carousel|thread|video|image",
      "audience": "...",
      "hook": "opening line or visual hook",
      "keyMessage": "what the audience should believe after seeing this",
      "conversionBridge": "how this leads to a sale or sign-up",
      "suggestedBudget": 0,
      "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight",
      "sourcePlatforms": ["instagram", "youtube"],
      "urgent": false,
      "priorityScore": 8.5,
      "selected": true/false,
      "selectionReason": "why this idea won or lost the debate",
      "contrariansVerdict": "what the contrarian said about this idea"
    }
  ],
  "debateRounds": 3,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed 5 ideas"},
    {"round": 1, "from": "contrarian", "summary": "challenged #3 and #5, endorsed #1"},
    {"round": 2, "from": "strategist", "summary": "defended #3 with new data, conceded #5"},
    {"round": 2, "from": "contrarian", "summary": "accepted #3 defense, agreed #1 is winner"},
    {"round": 3, "from": "both", "summary": "consensus reached on #1"}
  ],
  "debateRationale": "2-3 sentence summary of the full debate — what was argued, who pushed back on what, and why the winner won"
}

Mark exactly 1 brief as "selected": true — the winner.

═══════════════════════════════════════════════════════
DATA FOR IDEA GENERATION
═══════════════════════════════════════════════════════

COORDINATOR SIGNALS (cross-validated from 4 platforms):
${topSignals || coordinator.content.slice(0, 2000)}

FULL COORDINATOR SYNTHESIS:
${coordinator.content}

COMPETITOR RESEARCH:
${competitorResearch}

MARKET RESEARCH:
${marketResearch}

${learningsContext}

${liveContext}

RULES:
- Generate ideas from 3 sources: coordinator signals, competitor gaps, market insights
- At least 1 idea must exploit a competitor vulnerability
- At least 1 idea must be tied to the #1 coordinator signal
- The Contrarian MUST see all ideas before you pick a winner
- Do NOT pick the winner before the debate — let it emerge from the argument
    `.trim();
  }

  private runTeamViaCli(prompt: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'claude',
        [
          '-p', prompt,
          '--output-format', 'stream-json',
          '--verbose',
          '--permission-mode', 'bypassPermissions',
          '--dangerously-skip-permissions',
        ],
        {
          env: {
            ...process.env,
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          },
          cwd: process.cwd(),
        },
      );

      let lastResult: CliResult | null = null;
      let buffer = '';

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.logStreamMessage(msg);

            if (msg.type === 'result') {
              lastResult = {
                result: msg.result ?? '',
                total_cost_usd: msg.total_cost_usd ?? 0,
                num_turns: msg.num_turns ?? 0,
                usage: {
                  input_tokens: msg.usage?.input_tokens ?? 0,
                  output_tokens: msg.usage?.output_tokens ?? 0,
                },
              };
            }
          } catch {
            // non-JSON line
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) this.logger.warn(`[CLI stderr] ${text}`);
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Strategy Team timed out after 10 minutes'));
      }, 10 * 60 * 1000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.logger.log(`[Strategy Team] CLI process exited with code ${code}`);
        if (lastResult) {
          resolve(lastResult);
        } else {
          reject(new Error(`CLI exited with code ${code} and no result`));
        }
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (lastResult && !child.killed) {
          resolve(lastResult);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private logStreamMessage(msg: any): void {
    const type = msg.type;
    const subtype = msg.subtype ?? '';

    if (type === 'system' && subtype === 'init') {
      this.logger.log(`[Strategy] Session started | model: ${msg.model}`);
      return;
    }

    if (type === 'assistant') {
      const blocks: any[] = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          const input = JSON.stringify(block.input ?? {}).slice(0, 150);
          this.logger.log(`[Strategy] 🔧 ${block.name}(${input})`);
        }
        if (block.type === 'text' && block.text?.trim()) {
          this.logger.log(`[Strategy] 💬 ${block.text.slice(0, 250)}`);
        }
      }
      return;
    }

    if (type === 'user') {
      const toolResult = msg.tool_use_result;
      if (toolResult) {
        if (toolResult.team_name || toolResult.from) {
          this.logger.log(`[Strategy] 📨 ${JSON.stringify(toolResult).slice(0, 250)}`);
        }
      }
      return;
    }

    if (type === 'result') {
      this.logger.log(`[Strategy] 🏁 Result: turns=${msg.num_turns} cost=$${msg.total_cost_usd?.toFixed(4)} status=${subtype}`);
    }
  }

  private parseOutput(content: string): any {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      return JSON.parse(jsonStr);
    } catch {
      this.logger.error('Strategy Team output parse failed');
      throw new Error('Strategy Team returned invalid JSON');
    }
  }
}
