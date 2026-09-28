import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpClient } from '../foundry-bridge/mcp.client';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface AlertInput {
  /** What kind of thing happened (`pipeline_failed`, `campaign_paused`, …). */
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Defaults to `marketing_agent`. */
  source?: string;
  /** Same key twice = one alert, not two. */
  dedupeKey?: string;
}

/**
 * Every notification this service used to post to Slack, now raised as a Brain alert.
 *
 * Alerts land in the dashboard's "Waiting on you" page and the header bell (brain `alerts` table,
 * via `alert_raise`). There is no Slack webhook, tenant or ops, anywhere in this process.
 *
 * NEVER THROWS. Alerting must not break the thing it is alerting about: an unreachable brain, or a
 * brain that does not have `alert_raise` yet, degrades to an error log that still carries the whole
 * message — the same fallback the old ops webhook had when it was unset.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly brain: McpClient;

  constructor(config: ConfigService) {
    this.brain = new McpClient(
      (config.get<string>('brain.url') ?? '').trim(),
      (config.get<string>('brain.token') ?? '').trim(),
      config.get<number>('brain.timeoutMs') ?? 30000,
      'brain',
    );
  }

  async raise(alert: AlertInput): Promise<void> {
    const payload = {
      kind: alert.kind,
      severity: alert.severity,
      title: plain(alert.title).slice(0, 200) || 'Something needs a look',
      body: plain(alert.body).slice(0, 4000),
      source: alert.source ?? 'marketing_agent',
      ...(alert.dedupeKey ? { dedupe_key: alert.dedupeKey } : {}),
    };
    if (!this.brain.isConfigured()) {
      this.logger.error(
        `ALERT (brain not configured) [${payload.severity}] ${payload.title} — ${payload.body}`,
      );
      return;
    }
    try {
      await this.brain.call('alert_raise', payload);
    } catch (err) {
      this.logger.error(
        `ALERT not raised (${(err as Error).message}) [${payload.severity}] ${payload.title} — ${payload.body}`,
      );
    }
  }

  /**
   * A system failure for whoever runs the system: pipeline deaths, failed creative production,
   * audits skipped on bad data. Was OPS_ALERT_WEBHOOK.
   */
  async opsAlert(
    kind: string,
    message: string,
    context?: Record<string, unknown>,
    severity: AlertSeverity = 'critical',
  ): Promise<void> {
    const [first, ...rest] = message.split('\n');
    const detail =
      context && Object.keys(context).length
        ? `\n\nDetails: ${Object.entries(context)
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(', ')}`
        : '';
    await this.raise({
      kind,
      severity,
      title: first,
      body: `${rest.join('\n')}${detail}`.trim() || first,
    });
  }
}

/** Slack mrkdwn → plain text: no *bold*, _italic_, `code`, or leading status emoji. */
export function plain(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/^[\p{Extended_Pictographic}️\s]+/u, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
