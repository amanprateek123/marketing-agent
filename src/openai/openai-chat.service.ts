import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AgentType } from '../claude/claude.types';
import { UsageLog } from '../claude/schemas/usage-log.schema';

export interface OpenAIChatParams {
  tenantId: string;
  agentType: AgentType;
  systemPrompt: string;
  userMessage: string;
  /** Set for calls whose prompt asks for a JSON response — forces OpenAI's native JSON mode instead of relying on prompt text alone. */
  expectJson?: boolean;
  model?: string;
  runId?: string;
}

export interface OpenAIChatResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface OpenAIStructuredParams<T> {
  tenantId: string;
  agentType: AgentType;
  systemPrompt: string;
  userMessage: string;
  /** Short snake_case name recorded by OpenAI for the JSON-schema format. */
  schemaName: string;
  /** Strict JSON Schema for the complete response object. */
  schema: Record<string, unknown>;
  model?: string;
  runId?: string;
  /** Compile-time marker only; parsing and domain validation happen at runtime. */
  _output?: T;
}

export interface OpenAIStructuredResult<T> extends OpenAIChatResult {
  data: T;
  model: string;
  responseId?: string;
}

/**
 * Plain one-shot text-completion equivalent of ClaudeService.runAgent(), used
 * by the creative copy/prompt-writing pipeline. Unlike the Claude Agent SDK's
 * query() (a multi-turn agentic session with tool access and an 8-minute
 * timeout), this is a single request/response call — no tool-use loop, so
 * there's no failure mode where the model waits on a tool nothing answers.
 */
@Injectable()
export class OpenAIChatService {
  private readonly logger = new Logger(OpenAIChatService.name);

  private static readonly TIMEOUT_MS = 90_000; // one-shot completion, not an agentic session
  private static readonly MAX_ATTEMPTS = 3;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  async runChat(params: OpenAIChatParams): Promise<OpenAIChatResult> {
    const apiKey = this.configService.get<string>('openai.apiKey');
    const model =
      params.model ??
      this.configService.get<string>('openai.chatModel') ??
      'gpt-5.1';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    this.logger.log(
      `[${params.agentType}] Calling OpenAI chat: tenantId=${params.tenantId} model=${model}`,
    );

    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= OpenAIChatService.MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model,
            messages: [
              { role: 'system', content: params.systemPrompt },
              { role: 'user', content: params.userMessage },
            ],
            ...(params.expectJson
              ? { response_format: { type: 'json_object' } }
              : {}),
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: OpenAIChatService.TIMEOUT_MS,
          },
        );

        const content = response.data?.choices?.[0]?.message?.content ?? '';
        const inputTokens = response.data?.usage?.prompt_tokens ?? 0;
        const outputTokens = response.data?.usage?.completion_tokens ?? 0;
        const costUSD = this.estimateCost(model, inputTokens, outputTokens);

        this.logger.log(
          `[${params.agentType}] OpenAI chat completed: tenantId=${params.tenantId} contentLength=${content.length}`,
        );

        await this.logUsage({
          tenantId: params.tenantId,
          runId: params.runId,
          agent: params.agentType,
          model,
          inputTokens,
          outputTokens,
          costUSD,
        });

        return { content, inputTokens, outputTokens, costUSD };
      } catch (err) {
        lastError = err;
        const status = (err as any)?.response?.status;
        const code = (err as any)?.code;
        const retriable =
          code === 'ECONNABORTED' ||
          code === 'ETIMEDOUT' ||
          (typeof status === 'number' && status >= 500);
        if (!retriable || attempt === OpenAIChatService.MAX_ATTEMPTS) throw err;

        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 15_000);
        this.logger.warn(
          `[${params.agentType}] OpenAI chat attempt ${attempt} failed (code=${code} status=${status}); retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastError;
  }

  /**
   * One-shot, strict structured output through the Responses API.
   *
   * This transport only guarantees syntactically schema-shaped JSON. Callers
   * must still validate every evidence reference and immutable decision field
   * against their own allow-listed input before trusting the result.
   */
  async runStructured<T>(
    params: OpenAIStructuredParams<T>,
  ): Promise<OpenAIStructuredResult<T>> {
    const apiKey = this.configService.get<string>('openai.apiKey');
    const model =
      params.model ??
      this.configService.get<string>('openai.chatModel') ??
      'gpt-5.1';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    this.logger.log(
      `[${params.agentType}] Calling OpenAI Responses API: tenantId=${params.tenantId} model=${model} schema=${params.schemaName}`,
    );

    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= OpenAIChatService.MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/responses',
          {
            model,
            store: false,
            instructions: params.systemPrompt,
            input: [
              {
                role: 'user',
                content: [{ type: 'input_text', text: params.userMessage }],
              },
            ],
            text: {
              format: {
                type: 'json_schema',
                name: params.schemaName,
                strict: true,
                schema: params.schema,
              },
            },
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: OpenAIChatService.TIMEOUT_MS,
          },
        );

        const content = extractResponsesText(response.data);
        if (!content) {
          throw new Error('OpenAI Responses API returned no output_text');
        }

        let data: T;
        try {
          data = JSON.parse(content) as T;
        } catch (err) {
          throw new Error(
            `OpenAI structured output was not valid JSON: ${(err as Error).message}`,
          );
        }

        const inputTokens = response.data?.usage?.input_tokens ?? 0;
        const outputTokens = response.data?.usage?.output_tokens ?? 0;
        const costUSD = this.estimateCost(model, inputTokens, outputTokens);

        try {
          await this.logUsage({
            tenantId: params.tenantId,
            runId: params.runId,
            agent: params.agentType,
            model,
            inputTokens,
            outputTokens,
            costUSD,
          });
        } catch (err) {
          // Usage telemetry must not turn a successfully validated analyst
          // response into a failed intelligence cycle.
          this.logger.warn(
            `[${params.agentType}] Usage logging failed: ${(err as Error).message}`,
          );
        }

        return {
          data,
          content,
          model,
          responseId:
            typeof response.data?.id === 'string'
              ? response.data.id
              : undefined,
          inputTokens,
          outputTokens,
          costUSD,
        };
      } catch (err) {
        lastError = err;
        const status = (err as any)?.response?.status;
        const code = (err as any)?.code;
        const retriable =
          code === 'ECONNABORTED' ||
          code === 'ETIMEDOUT' ||
          status === 408 ||
          status === 409 ||
          status === 429 ||
          (typeof status === 'number' && status >= 500);
        if (!retriable || attempt === OpenAIChatService.MAX_ATTEMPTS) throw err;

        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 15_000);
        this.logger.warn(
          `[${params.agentType}] OpenAI Responses attempt ${attempt} failed (code=${code} status=${status}); retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastError;
  }

  private estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    // Pricing per million tokens — placeholder estimates, verify against
    // OpenAI's current pricing page; these drift over time.
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-5.1': { input: 5.0, output: 15.0 },
      'gpt-5.1-mini': { input: 0.5, output: 2.0 },
    };
    const p = pricing[model] ?? pricing['gpt-5.1'];
    return (
      (inputTokens / 1_000_000) * p.input +
      (outputTokens / 1_000_000) * p.output
    );
  }

  private async logUsage(data: {
    tenantId: string;
    runId?: string;
    agent: AgentType;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }): Promise<void> {
    // claudeModel is a legacy field name on UsageLog (widened to `string`) —
    // shared usage-log collection across both Claude- and OpenAI-backed calls.
    await this.usageLogModel.create({
      tenantId: data.tenantId,
      runId: data.runId,
      agent: data.agent,
      claudeModel: data.model,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      costUSD: data.costUSD,
      timestamp: new Date(),
    });
  }
}

/** REST responses expose content in `output`; some clients also add the
 * convenience `output_text` field. Accept both without weakening validation. */
function extractResponsesText(body: unknown): string {
  const response = body as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
  };
  if (typeof response?.output_text === 'string') return response.output_text;

  for (const item of response?.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return '';
}
