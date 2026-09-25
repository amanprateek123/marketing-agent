import { ConflictException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mapBudgetAuthority, mapCampaignRun } from './campaign-run.mapper';
import { CreativeImageService } from './creative-image.service';
import { GateDecisionDto } from './dto/gate-decision.dto';
import {
  chooseUserTurnIndex,
  FoundryBridgeService,
  mapDecisionResult,
} from './foundry-bridge.service';

type Call = { tool: string; args: Record<string, unknown> };

/** A stand-in MCP client: records every call and answers from a per-tool script. */
function fakeClient(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const answer = (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const a = answers[tool];
    return typeof a === 'function'
      ? (a as (x: Record<string, unknown>) => unknown)(args)
      : a;
  };
  return {
    calls,
    isConfigured: () => true,
    call: jest.fn((tool: string, args: Record<string, unknown> = {}) =>
      Promise.resolve(answer(tool, args)),
    ),
    tryCall: jest.fn((tool: string, args: Record<string, unknown> = {}) =>
      Promise.resolve(answer(tool, args)),
    ),
  };
}

function makeService(
  brainAnswers: Record<string, unknown>,
  foundryAnswers: Record<string, unknown> = {},
) {
  const values: Record<string, unknown> = {
    'brain.approvalActorSlackId': 'U_TEST',
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  const service = new FoundryBridgeService(
    config,
    {} as unknown as CreativeImageService,
  );
  const brain = fakeClient(brainAnswers);
  const foundry = fakeClient({
    run_agent: { run_id: 'run_foundry_1' },
    ...foundryAnswers,
  });
  Object.assign(service as unknown as Record<string, unknown>, {
    brain,
    foundry,
  });
  return { service, brain, foundry };
}

describe('chooseUserTurnIndex', () => {
  it('pins a resend of the unanswered question to its own index', () => {
    const tail = { role: 'user', turn_index: 4, content: 'Should we pause X?' };
    expect(chooseUserTurnIndex(tail, 4, '  Should we pause X?  ')).toEqual({
      turnIndex: 4,
      isResend: true,
    });
  });

  it('puts a DIFFERENT message after an unanswered one on the next index', () => {
    // Pinning it to 4 would be absorbed by ON CONFLICT DO NOTHING: the new text would never be
    // written, and the run would answer the old question.
    const tail = { role: 'user', turn_index: 4, content: 'Should we pause X?' };
    expect(chooseUserTurnIndex(tail, 4, 'Actually, what about Y?')).toEqual({
      turnIndex: 5,
      isResend: false,
    });
  });

  it('never treats a clipped tail as equal', () => {
    const tail = {
      role: 'user',
      turn_index: 4,
      content: 'Should we pause X?',
      content_clipped: true,
    };
    expect(chooseUserTurnIndex(tail, 4, 'Should we pause X?').isResend).toBe(
      false,
    );
  });

  it('uses lastTurn + 1 after an answered exchange, and null when the thread was unreadable', () => {
    expect(
      chooseUserTurnIndex(
        { role: 'brain', turn_index: 4, content: 'x' },
        4,
        'x',
      ),
    ).toEqual({ turnIndex: 5, isResend: false });
    expect(chooseUserTurnIndex(null, null, 'x')).toEqual({
      turnIndex: null,
      isResend: false,
    });
  });
});

describe('sendConversationMessage', () => {
  it('mints a correlation id, passes it and the turn index to the Brain run, and returns it', async () => {
    const { service, foundry } = makeService({
      conversation_read: { last_turn: 2, turns: [] },
      conversation_append: { turn_index: 3, deduplicated: false },
    });

    const out = await service.sendConversationMessage(
      'sess-1',
      ' hello ',
      'review',
    );

    const run = foundry.calls.find((c) => c.tool === 'run_agent');
    const inputs = run?.args.inputs as Record<string, unknown>;
    expect(inputs).toMatchObject({
      message: 'hello',
      session_id: 'sess-1',
      mode: 'review',
      turn_index: 3,
    });
    expect(typeof inputs.correlation_id).toBe('string');
    expect(out).toEqual({
      runId: 'run_foundry_1',
      correlationId: inputs.correlation_id,
      sessionId: 'sess-1',
    });
  });

  it('omits turn_index when neither the read nor the append produced one', async () => {
    const { service, foundry } = makeService({
      conversation_read: null,
      conversation_append: { deduplicated: false },
    });
    await service.sendConversationMessage('sess-1', 'hello');
    const inputs = foundry.calls.find((c) => c.tool === 'run_agent')?.args
      .inputs as Record<string, unknown>;
    expect(inputs).not.toHaveProperty('turn_index');
    expect(inputs).toHaveProperty('correlation_id');
  });

  it('accepts a deduplicated append when it is a resend of the pending question', async () => {
    const { service, brain, foundry } = makeService({
      conversation_read: {
        last_turn: 4,
        turns: [{ role: 'user', turn_index: 4, content: 'same question' }],
      },
      conversation_append: { turn_index: 4, deduplicated: true },
    });
    await service.sendConversationMessage('sess-1', 'same question');
    const append = brain.calls.find((c) => c.tool === 'conversation_append');
    expect(append?.args.turn_index).toBe(4);
    expect(foundry.calls.some((c) => c.tool === 'run_agent')).toBe(true);
  });

  it('refuses, and starts no run, when a fresh index turns out to be taken', async () => {
    const { service, foundry } = makeService({
      conversation_read: { last_turn: 4, turns: [] },
      conversation_append: { turn_index: 5, deduplicated: true },
    });
    await expect(
      service.sendConversationMessage('sess-1', 'new question'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(foundry.calls.some((c) => c.tool === 'run_agent')).toBe(false);
  });
});

describe('gate decisions with an amount', () => {
  it('GateDecisionDto keeps amountOverrideInr through the whitelist', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const out = (await pipe.transform(
      { action: 'approve', amountOverrideInr: 6000 },
      { type: 'body', metatype: GateDecisionDto },
    )) as GateDecisionDto;
    expect(out.amountOverrideInr).toBe(6000);
  });

  it('forwards the amount and returns what the brain did with it', async () => {
    const { service, brain } = makeService({
      approval_record: {
        recorded: true,
        budget_rescale: [
          {
            pipeline_run_id: 94,
            source: 'approval:48',
            authorised_daily_budget_inr: 6000,
            contract_total_before_inr: 5000,
            contract_total_inr: 6000,
            rescaled: true,
            exceeds_adset_cap: {
              cap_inr: 5000,
              entries: ['nadi-lal'],
              note: 'split it',
            },
          },
        ],
        budget_rescale_skipped: null,
      },
    });

    const out = await service.decideGate('approval:48', {
      action: 'approve',
      amountOverrideInr: 6000,
    });

    expect(
      brain.calls.find((c) => c.tool === 'approval_record')?.args,
    ).toMatchObject({
      id: 48,
      decision: 'approved',
      amount_override_inr: 6000,
    });
    expect(out).toEqual({
      ok: true,
      budgetRescale: [
        {
          pipelineRunId: '94',
          source: 'approval:48',
          authorisedDailyBudgetInr: 6000,
          contractTotalBeforeInr: 5000,
          contractTotalInr: 6000,
          rescaled: true,
          why: null,
          exceedsAdsetCap: {
            capInr: 5000,
            entries: ['nadi-lal'],
            note: 'split it',
          },
        },
      ],
      budgetRescaleSkipped: null,
    });
  });

  it('carries the skip reason, and says nothing when the brain said nothing', () => {
    expect(
      mapDecisionResult({
        recorded: true,
        budget_rescale: [],
        budget_rescale_skipped: 'plan gate 50 names no pipeline_run_id',
      }),
    ).toEqual({
      ok: true,
      budgetRescale: [],
      budgetRescaleSkipped: 'plan gate 50 names no pipeline_run_id',
    });
    expect(mapDecisionResult({ recorded: true })).toEqual({
      ok: true,
      budgetRescale: null,
      budgetRescaleSkipped: null,
    });
  });
});

describe('budget_authority', () => {
  const authority = {
    authorised_daily_budget_inr: 6000,
    source: 'approval:48',
    contract_total_inr: 5000,
    consistent: false,
    why: 'contract total 5000 != authorised 6000',
  };

  it('maps the brain’s statement, including why it is inconsistent', () => {
    expect(mapBudgetAuthority(authority)).toEqual({
      authorisedDailyBudgetInr: 6000,
      source: 'approval:48',
      sourceLabel: 'The amount approved on gate 48',
      contractTotalInr: 5000,
      consistent: false,
      why: 'contract total 5000 != authorised 6000',
    });
    expect(mapBudgetAuthority(undefined)).toBeNull();
  });

  it('the run view shows the authorised budget, not the sum of the audiences', () => {
    const run = mapCampaignRun({
      id: 94,
      stage: 'launching',
      status: 'open',
      offering_slug: 'golu_devta_arzi',
      creative_contract: {
        audience_plan: [{ budget_value_inr: 2500 }, { budget_value_inr: 2500 }],
      },
      budget_authority: authority,
    });
    const daily = run?.brief.find((f) => f.label === 'Daily budget');
    expect(daily?.value).toBe('₹6,000 a day');
    expect(run?.budgetAuthority?.consistent).toBe(false);
  });

  it('with no budget_authority, the run view does not invent a budget by summing', () => {
    const run = mapCampaignRun({
      id: 94,
      stage: 'launching',
      status: 'open',
      creative_contract: { audience_plan: [{ budget_value_inr: 2500 }] },
    });
    expect(run?.brief.find((f) => f.label === 'Daily budget')).toBeUndefined();
    expect(run?.budgetAuthority).toBeNull();
  });
});

describe('gate decisions carry the Brain login principal', () => {
  it('sends the principal and display name, and still the Slack id until migration 049', async () => {
    const { service, brain } = makeService({
      approval_record: { recorded: true },
    });
    await service.decideGate(
      'approval:9',
      { action: 'reject', note: 'no' },
      { principal: 'dash:brain:owner', displayName: 'owner' },
    );
    expect(
      brain.calls.find((c) => c.tool === 'approval_record')?.args,
    ).toMatchObject({
      id: 9,
      decision: 'rejected',
      decided_by_slack_id: 'U_TEST',
      decided_by_name: 'owner',
      decided_by_principal: 'dash:brain:owner',
    });
  });
});
