import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { istDay } from '../../pm.logic';
import {
  PmProxyCache,
  PmProxyUsage,
} from '../../schemas/pm-competitor-ad.schema';

/** useproxy.dev hosted MCP (Meta Ad Library incl. Indian commercial ads). Secrets: never log them. */
/** Read at call time (not import time), so .env loaded later still counts. */
export const pmProxyEnv = () => ({
  url: process.env.PROXY_MCP_URL ?? '',
  authorization: process.env.PROXY_MCP_AUTHORIZATION ?? '',
  /** Hard daily cap, counted per IST day in pm_proxy_usage — below the plan's own daily budget. */
  dailyCredits: parseInt(process.env.PM_PROXY_DAILY_CREDITS ?? '30', 10),
});
const PROXY_CONTEXT =
  'Track Indian astrology and puja competitors Meta ads daily for a performance marketing analyst.';

/** Credits a call will use (the server's published prices; unknown tools count 1). */
export function proxyCost(name: string, args: Record<string, any>): number {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 1);
  switch (name) {
    case 'get_credit_balance':
      return 0;
    case 'get_meta_ads':
      return Math.ceil((args.limit ?? 100) / 25) * n(args.platform_ids);
    case 'get_meta_platform_id':
      return n(args.brand_names);
    default:
      return 1;
  }
}

export class PmProxyCapError extends Error {}

@Injectable()
export class PmProxyClient implements OnModuleDestroy {
  private readonly logger = new Logger(PmProxyClient.name);
  private client: Promise<Client> | null = null;
  private conversationId: string | undefined;

  constructor(
    @InjectModel(PmProxyUsage.name)
    private readonly usage: Model<PmProxyUsage>,
    @InjectModel(PmProxyCache.name)
    private readonly cache: Model<PmProxyCache>,
  ) {}

  get configured() {
    return Boolean(pmProxyEnv().url && pmProxyEnv().authorization);
  }

  /** Credits used today (IST) by our code. */
  async usedToday(): Promise<number> {
    const d = await this.usage.findById(istDay(Date.now())).lean();
    return d?.credits ?? 0;
  }

  /** Call one proxy tool; reserves its credits against the daily cap first. Returns parsed JSON (or text). */
  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    if (!this.configured)
      throw new Error('Proxy MCP is not configured (PROXY_MCP_URL)');
    await this.reserve(name, proxyCost(name, args));
    const client = await this.connect();
    let res: Awaited<ReturnType<Client['callTool']>>;
    try {
      res = await client.callTool(
        {
          name,
          arguments: {
            context: PROXY_CONTEXT,
            ...(this.conversationId
              ? { conversation_id: this.conversationId }
              : {}),
            ...args,
          },
        },
        undefined,
        { timeout: 300_000 },
      );
    } catch (e) {
      this.client = null; // reconnect next time
      throw e;
    }
    // Data comes as structuredContent; content holds a prose rendering + a conversation_id block.
    const texts = ((res.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '');
    if (res.isError)
      throw new Error(`proxy ${name}: ${texts.join(' ').slice(0, 500)}`);
    let out: any = res.structuredContent;
    for (const t of texts) {
      try {
        const j = JSON.parse(t);
        if (j?.conversation_id) this.conversationId = String(j.conversation_id);
        else out ??= j;
      } catch {
        /* prose block */
      }
    }
    out ??= texts.join('\n');
    const conv = out?._mcp_instructions?.conversation_id;
    if (typeof conv === 'string') this.conversationId = conv;
    if (out && typeof out === 'object') delete out._mcp_instructions;
    if (out && typeof out === 'object' && out.success === false)
      throw new Error(
        `proxy ${name}: ${String(out.error ?? out.message ?? 'failed').slice(0, 500)}`,
      );
    return out;
  }

  /** callTool, cached forever in pm_proxy_cache by key (analyses, transcripts). */
  async cached(key: string, name: string, args: Record<string, any>) {
    const hit = await this.cache.findById(key).lean();
    if (hit) return { cached: true, result: hit.result };
    const result = await this.callTool(name, args);
    await this.cache.updateOne(
      { _id: key },
      { $set: { tool: name, result } },
      { upsert: true },
    );
    return { cached: false, result };
  }

  /** Atomic: the filter only matches while under the cap; a full day makes the upsert collide (E11000). */
  private async reserve(name: string, cost: number) {
    if (!cost) return;
    const cap = pmProxyEnv().dailyCredits;
    const day = istDay(Date.now());
    if (cost > cap)
      throw new PmProxyCapError(
        `proxy ${name} needs ${cost} credits, daily cap is ${cap}`,
      );
    try {
      await this.usage.updateOne(
        { _id: day, credits: { $lte: cap - cost } },
        { $inc: { credits: cost, [`byTool.${name}`]: cost } },
        { upsert: true },
      );
    } catch (e) {
      if ((e as { code?: number }).code === 11000)
        throw new PmProxyCapError(
          `proxy daily credit cap reached (${cap}/day, PM_PROXY_DAILY_CREDITS) — ${name} not called`,
        );
      throw e;
    }
  }

  private connect(): Promise<Client> {
    if (!this.client) {
      this.client = (async () => {
        const env = pmProxyEnv();
        const client = new Client({ name: 'pm-agent', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(env.url), {
          requestInit: { headers: { Authorization: env.authorization } },
        });
        await client.connect(transport);
        return client;
      })().catch((e) => {
        this.client = null;
        // The URL/header may carry secrets: only the message.
        throw new Error(`proxy connect failed: ${(e as Error).message}`);
      });
    }
    return this.client;
  }

  async onModuleDestroy() {
    const c = this.client;
    this.client = null;
    await c?.then((x) => x.close()).catch(() => undefined);
  }
}
