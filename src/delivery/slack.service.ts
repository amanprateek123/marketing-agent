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
      throw err;
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
