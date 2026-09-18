import {
  CampaignCopilotRecommendations,
  CampaignCopilotSessionStatus,
  emptyCampaignCopilotBuildState,
  emptyCampaignCopilotPlan,
} from './campaign-copilot.contracts';
import { CampaignCopilotService } from './campaign-copilot.service';

const recommendations: CampaignCopilotRecommendations = {
  budget: null,
  audience: null,
  accountId: 'act_123',
  objective: 'sales_purchase',
  creativeFormat: 'image',
};

async function runTurn(input: {
  message: string;
  planPatch: Record<string, unknown>;
}) {
  const plan = emptyCampaignCopilotPlan();
  plan.accountId = 'act_123';
  const locked = {
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    status: CampaignCopilotSessionStatus.COLLECTING,
    messages: [],
    plan,
    recommendations,
    readiness: null,
    build: emptyCampaignCopilotBuildState(),
    turnNumber: 1,
    turnInProgress: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
  const updated = { ...locked, turnInProgress: false };
  const sessionModel = {
    findOneAndUpdate: jest
      .fn()
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(locked) })
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(updated) }),
  };
  const openaiChat = {
    runChat: jest.fn().mockResolvedValue({
      content: JSON.stringify({
        reply: 'Which product?',
        planPatch: input.planPatch,
      }),
    }),
  };
  const service = new CampaignCopilotService(
    sessionModel as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    openaiChat as any,
  );
  const runtime = {
    company: {
      tenantId: 'tenant-1',
      name: 'Example',
      industry: 'ecommerce',
      targetAudience: 'Adults',
      customerLanguage: ['english'],
      tone: 'clear',
      uniqueValue: 'Useful',
      geography: 'India',
      language: 'english',
      primaryObjective: 'conversions',
      preferredFormats: ['image'],
      weeklyBudgetCap: 14_000,
      maxBudgetPerCampaign: 3_000,
      products: [],
      meta: {
        accountId: 'act_123',
        accountIds: ['act_123', 'act_456'],
        accessToken: 'secret',
      },
    },
    currentWeeklySpend: 0,
    accountAudiences: [],
    accountAudiencesVerified: true,
    pages: [],
    pagesVerified: true,
  };
  const loadRuntimeContext = jest
    .spyOn(service as any, 'loadRuntimeContext')
    .mockResolvedValue(runtime);

  await (service as any).runConversationTurn(
    { ...locked, turnInProgress: false },
    input.message,
    'message-1',
    false,
  );
  return loadRuntimeContext;
}

describe('CampaignCopilotService runtime context', () => {
  it('reuses the verified runtime context when the account did not change', async () => {
    const loadRuntimeContext = await runTurn({
      message: 'Help me prepare a campaign.',
      planPatch: {},
    });

    expect(loadRuntimeContext).toHaveBeenCalledTimes(1);
    expect(loadRuntimeContext).toHaveBeenCalledWith('tenant-1', 'act_123');
  });

  it('loads and verifies a fresh runtime context when the account changes', async () => {
    const loadRuntimeContext = await runTurn({
      message: 'Use account act_456.',
      planPatch: { accountId: 'act_456' },
    });

    expect(loadRuntimeContext).toHaveBeenCalledTimes(2);
    expect(loadRuntimeContext).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      'act_456',
    );
  });
});
