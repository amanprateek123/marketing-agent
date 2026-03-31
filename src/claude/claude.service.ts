import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AgentType,
  AgentResult,
  ClaudeModel,
  HAIKU_AGENTS,
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

  async runAgent(params: RunAgentParams): Promise<AgentResult> {
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

    for await (const message of query({
      prompt: params.userMessage,
      options: {
        systemPrompt,
        model,
        maxTurns: params.maxTurns ?? 10,
        cwd: process.cwd(),
        persistSession: false,
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        result = message.result;
        costUSD = message.total_cost_usd ?? 0;
        inputTokens = message.usage?.input_tokens ?? 0;
        outputTokens = message.usage?.output_tokens ?? 0;
      }
    }

    await this.logUsage({
      tenantId: params.tenantId,
      runId: params.runId,
      agent: params.agentType,
      claudeModel: model,
      inputTokens,
      outputTokens,
      costUSD,
    });

    return { content: result, inputTokens, outputTokens, costUSD };
  }

  getModel(agentType: AgentType): ClaudeModel {
    return HAIKU_AGENTS.includes(agentType)
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6';
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
