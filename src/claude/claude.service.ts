import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AgentType,
  AgentResult,
  ClaudeModel,
  HAIKU_AGENTS,
  NO_TOOL_AGENTS,
  TEAM_LEAD_AGENTS,
  RunAgentParams,
} from './claude.types';
import { UsageLog } from './schemas/usage-log.schema';

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  constructor(
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  private static readonly RATE_LIMIT_PATTERNS = [
    /rate.?limit/i,
    /too many requests/i,
    /overloaded/i,
    /429/,
    /capacity/i,
  ];

  private static readonly MAX_RETRIES = 3;
  private static readonly QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  async runAgent(params: RunAgentParams): Promise<AgentResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= ClaudeService.MAX_RETRIES; attempt++) {
      try {
        return await this.executeQuery(params);
      } catch (err: any) {
        lastError = err;
        const isRateLimit = ClaudeService.RATE_LIMIT_PATTERNS.some(p => p.test(err.message));
        if (!isRateLimit || attempt === ClaudeService.MAX_RETRIES) throw err;

        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
        this.logger.warn(
          `[${params.agentType}] Rate limited (attempt ${attempt}/${ClaudeService.MAX_RETRIES}), retrying in ${backoffMs}ms`,
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError!;
  }

  private async executeQuery(params: RunAgentParams): Promise<AgentResult> {
    const model = params.model ?? this.getModel(params.agentType);
    const systemPrompt = params.liveContext
      ? `${params.systemPrompt}\n\n${params.liveContext}`
      : params.systemPrompt;

    this.logger.log(
      `Running agent: ${params.agentType} | tenant: ${params.tenantId} | model: ${model}`,
    );

    // Dynamic import required — @anthropic-ai/claude-agent-sdk is ESM-only
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let result = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUSD = 0;

    this.logger.log(`[${params.agentType}] Starting query()...`);

    // Timeout guard — prevents a stuck agent from blocking a BullMQ worker indefinitely
    const queryPromise = (async () => {
      for await (const message of query({
        prompt: params.userMessage,
        options: {
          systemPrompt,
          model,
          maxTurns: params.maxTurns ?? 10,
          cwd: process.cwd(),
          persistSession: false,
          allowedTools: NO_TOOL_AGENTS.includes(params.agentType)
            ? []
            : TEAM_LEAD_AGENTS.includes(params.agentType)
              ? ['TeamCreate', 'TeamDelete', 'Agent', 'SendMessage', 'TaskCreate', 'WebSearch', 'WebFetch']
              : ['WebSearch', 'WebFetch', 'Bash'],
        },
      })) {
        this.logger.log(`[${params.agentType}] Message: type=${message.type} subtype=${(message as any).subtype ?? '-'}`);

        if (message.type === 'assistant') {
          const blocks: any[] = Array.isArray(message.message?.content) ? message.message.content : [];
          const text = blocks.find((b) => b.type === 'text')?.text ?? '';
          if (text.length > 0) {
            this.logger.log(`[${params.agentType}] Generating... (${text.length} chars so far)`);
          }
        }
        if (message.type === 'result' && message.subtype === 'success') {
          result = message.result;
          costUSD = message.total_cost_usd ?? 0;
          inputTokens = message.usage?.input_tokens ?? 0;
          outputTokens = message.usage?.output_tokens ?? 0;
        }
      }
    })();

    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Agent ${params.agentType} timed out after ${ClaudeService.QUERY_TIMEOUT_MS / 1000}s`)),
        ClaudeService.QUERY_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([queryPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }

    this.logger.log(`[${params.agentType}] query() completed. result length: ${result.length}`);

    // Detect rate limit in result text — use specific patterns, not generic "limit" substring
    if (result.length < 100 && ClaudeService.RATE_LIMIT_PATTERNS.some(p => p.test(result))) {
      throw new Error(`Claude rate limit hit: ${result.trim()}`);
    }

    // Estimate cost from token counts (subscription doesn't return billing data)
    const estimatedCostUSD = this.estimateCost(model, inputTokens, outputTokens);
    const finalCostUSD = costUSD > 0 ? costUSD : estimatedCostUSD;

    await this.logUsage({
      tenantId: params.tenantId,
      runId: params.runId,
      agent: params.agentType,
      claudeModel: model,
      inputTokens,
      outputTokens,
      costUSD: finalCostUSD,
    });

    return { content: result, inputTokens, outputTokens, costUSD: finalCostUSD };
  }

  getModel(agentType: AgentType): ClaudeModel {
    return HAIKU_AGENTS.includes(agentType)
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6';
  }

  private estimateCost(model: ClaudeModel, inputTokens: number, outputTokens: number): number {
    // Pricing per million tokens (as of 2026)
    const pricing: Record<ClaudeModel, { input: number; output: number }> = {
      'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
      'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
    };
    const p = pricing[model];
    return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  }

  private async logUsage(data: {
    tenantId: string;
    runId?: string;
    agent: AgentType;
    claudeModel: ClaudeModel;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }): Promise<void> {
    await this.usageLogModel.create({ ...data, timestamp: new Date() });
  }
}
