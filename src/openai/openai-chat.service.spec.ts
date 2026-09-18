import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { AgentType } from '../claude/claude.types';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { OpenAIChatService } from './openai-chat.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OpenAIChatService.runStructured', () => {
  const usageLogModel = {
    create: jest.fn().mockResolvedValue({}),
  } as unknown as Model<UsageLog>;
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'openai.apiKey') return 'test-key';
      if (key === 'openai.chatModel') return 'gpt-test';
      return undefined;
    }),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the Responses API strict schema and parses output content', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'resp_123',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"verdict":"support"}' }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });

    const service = new OpenAIChatService(configService, usageLogModel);
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    };

    const result = await service.runStructured<{ verdict: string }>({
      tenantId: 'tenant-1',
      agentType: AgentType.INTELLIGENCE_REVIEWER,
      systemPrompt: 'Review only the supplied evidence.',
      userMessage: '{"evidence":[]}',
      schemaName: 'meridian_review',
      schema,
      runId: 'cycle-1',
    });

    expect(result.data).toEqual({ verdict: 'support' });
    expect(result.model).toBe('gpt-test');
    expect(result.responseId).toBe('resp_123');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        model: 'gpt-test',
        store: false,
        text: {
          format: expect.objectContaining({
            type: 'json_schema',
            name: 'meridian_review',
            strict: true,
            schema,
          }),
        },
      }),
      expect.objectContaining({ timeout: 90_000 }),
    );
  });

  it('rejects a response that contains no parseable JSON', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { output_text: 'not-json', usage: {} },
    });

    const service = new OpenAIChatService(configService, usageLogModel);
    await expect(
      service.runStructured({
        tenantId: 'tenant-1',
        agentType: AgentType.INTELLIGENCE_REVIEWER,
        systemPrompt: 'Review.',
        userMessage: '{}',
        schemaName: 'meridian_review',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow('not valid JSON');
  });
});
