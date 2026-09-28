import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreativeImageService } from './creative-image.service';
import { FoundryBridgeService } from './foundry-bridge.service';

function service(slackId = '', answer: Record<string, unknown> = { recorded: true }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call = (tool: string, args: Record<string, unknown> = {}) => {
    calls.push({ tool, args });
    return Promise.resolve(answer);
  };
  const svc = new FoundryBridgeService(
    { get: (k: string) => (k === 'brain.approvalActorSlackId' ? slackId : undefined) } as unknown as ConfigService,
    {} as unknown as CreativeImageService,
  );
  Object.assign(svc as unknown as Record<string, unknown>, {
    brain: { isConfigured: () => true, call, tryCall: call },
  });
  return { svc, calls };
}

const actor = { principal: 'dash:brain:ujjwal', displayName: 'ujjwal' };

describe('gate decisions are recorded under the Brain login', () => {
  it('sends the principal and no Slack id when none is configured', async () => {
    const { svc, calls } = service();
    await svc.decideGate('approval:12', { action: 'approve' }, actor);
    expect(calls[0].tool).toBe('approval_record');
    expect(calls[0].args).toMatchObject({ id: 12, decision: 'approved', decided_by_principal: 'dash:brain:ujjwal', decided_by_name: 'ujjwal' });
    expect(calls[0].args).not.toHaveProperty('decided_by_slack_id');
  });

  it('still sends the transitional Slack id while it is configured', async () => {
    const { svc, calls } = service('U0LEGACY1');
    await svc.decideGate('approval:12', { action: 'reject', note: 'too much' }, actor);
    expect(calls[0].args).toMatchObject({ decided_by_principal: 'dash:brain:ujjwal', decided_by_slack_id: 'U0LEGACY1', decision: 'rejected' });
  });

  it('approves some products only via scope_slugs', async () => {
    const { svc, calls } = service();
    await svc.decideGate('approval:12', { action: 'approve', scopeSlugs: [' saathi_report ', ''] }, actor);
    expect(calls[0].args.scope_slugs).toEqual(['saathi_report']);
  });

  it('refuses a product scope on a rejection, and a decision with no principal', async () => {
    const { svc } = service();
    await expect(svc.decideGate('approval:12', { action: 'reject', scopeSlugs: ['a'] }, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.decideGate('approval:12', { action: 'approve' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('shows an authorization failure and keeps the gate open', async () => {
    const { svc } = service('', { recorded: false, authorization_failed: true, why: 'dash:brain:ujjwal is not in APPROVAL_PRINCIPALS' });
    await expect(svc.decideGate('approval:12', { action: 'approve' }, actor)).rejects.toThrow(/not recorded and the gate is still open/);
  });
});
