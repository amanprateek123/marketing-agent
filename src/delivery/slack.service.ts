import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  async sendMessage(webhookUrl: string, tenantId: string, content: string): Promise<void> {
    if (!webhookUrl) {
      this.logger.warn(`No Slack webhook configured for tenant ${tenantId} — skipping`);
      return;
    }

    const chunks = this.splitIntoChunks(content, 2900);
    const blocks = chunks.map((chunk) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    }));

    try {
      await axios.post(webhookUrl, { blocks });
    } catch (err: any) {
      this.logger.error(`Slack send failed: tenantId=${tenantId} | ${err.message}`);
      // A failed tenant notification is itself an incident — approval requests
      // and audit digests silently vanishing is how campaigns sit in
      // pending_approval for days. Tell ops on the separate channel (different
      // webhook, so a broken tenant webhook doesn't take this down too).
      void this.sendOpsAlert(`Tenant Slack delivery FAILED (tenant=${tenantId}): ${err.message}`, {
        contentPreview: content.slice(0, 200),
      });
      throw err;
    }
  }

  /**
   * Operator alert channel for system failures — pipeline deaths, creative
   * production failures, stale-data audit skips, delivery failures. Uses
   * OPS_ALERT_WEBHOOK (env), NOT the per-tenant webhook: tenant channels are
   * for marketing output, this is for whoever runs the system.
   *
   * Never throws and never recurses — alerting must not break the thing it's
   * alerting about. Unset webhook degrades to an error log (still greppable).
   */
  async sendOpsAlert(message: string, context?: Record<string, any>): Promise<void> {
    const webhook = process.env.OPS_ALERT_WEBHOOK ?? '';
    const contextLine = context && Object.keys(context).length > 0
      ? `\n\`\`\`${JSON.stringify(context).slice(0, 1500)}\`\`\``
      : '';
    if (!webhook) {
      this.logger.error(`OPS ALERT (no OPS_ALERT_WEBHOOK configured): ${message}`);
      return;
    }
    try {
      await axios.post(webhook, {
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `🚨 *OPS ALERT*\n${message}${contextLine}`.slice(0, 2900) },
        }],
      }, { timeout: 10000 });
    } catch (err: any) {
      this.logger.error(`Ops alert delivery failed (original alert: ${message}): ${err.message}`);
    }
  }

  async sendDivider(webhookUrl: string, tenantId: string): Promise<void> {
    if (!webhookUrl) return;
    try {
      await axios.post(webhookUrl, { blocks: [{ type: 'divider' }] });
    } catch (err: any) {
      this.logger.error(`Slack divider failed: tenantId=${tenantId} | ${err.message}`);
    }
  }

  private splitIntoChunks(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt === -1) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }
}
