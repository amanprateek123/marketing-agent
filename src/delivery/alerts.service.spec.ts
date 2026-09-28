import { ConfigService } from '@nestjs/config';
import { AlertsService, plain } from './alerts.service';

function svc(call: jest.Mock) {
  const s = new AlertsService(
    new ConfigService({ brain: { url: 'http://brain', token: 't' } }),
  );
  (s as unknown as { brain: unknown }).brain = {
    isConfigured: () => true,
    call,
  };
  return s;
}

describe('AlertsService', () => {
  it('raises a brain alert instead of posting to Slack', async () => {
    const call = jest.fn().mockResolvedValue({ ok: true });
    await svc(call).raise({
      kind: 'campaign_paused',
      severity: 'critical',
      title: '🛑 *Paused*',
      body: 'Reason: `cap`',
      dedupeKey: 'k',
    });
    expect(call).toHaveBeenCalledWith('alert_raise', {
      kind: 'campaign_paused',
      severity: 'critical',
      title: 'Paused',
      body: 'Reason: cap',
      source: 'marketing_agent',
      dedupe_key: 'k',
    });
  });

  it('never throws, even when the brain has no alert_raise yet', async () => {
    const call = jest
      .fn()
      .mockRejectedValue(new Error('Unknown tool: alert_raise'));
    await expect(
      svc(call).opsAlert('pipeline_failed', 'The run failed', { run: 'r1' }),
    ).resolves.toBeUndefined();
  });

  it('turns an ops message into a title and a body with details', async () => {
    const call = jest.fn().mockResolvedValue({});
    await svc(call).opsAlert('x', 'First line\nmore', { tenant: 't1' }, 'warn');
    expect(call.mock.calls[0][1]).toMatchObject({
      severity: 'warn',
      title: 'First line',
      body: 'more\n\nDetails: tenant t1',
    });
  });

  it('strips Slack formatting', () => {
    expect(plain('✅ *Done* _now_ `x`')).toBe('Done now x');
  });
});
