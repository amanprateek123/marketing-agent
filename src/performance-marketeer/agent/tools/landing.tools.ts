import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import axios from 'axios';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Model } from 'mongoose';
import { z } from 'zod';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { PmMetaDaily, PmMetaEntity } from '../../schemas/pm-meta.schema';
import { PM_FILES, PmToolCtx } from '../pm-agent.types';
import { PmToolDef } from './pm-tool';

const run = promisify(execFile);

/** Only our own site. Anything else goes through WebFetch (untrusted). */
const OWN_HOST = /^(www\.)?91astrology\.com$/;
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 PM-Analyst';
const MAX_TEXT = 15_000;

/**
 * Screenshots load the page's JavaScript. These hosts are made unresolvable so
 * the analyst never adds a fake visit to OpenPanel, GTM/GA, the Meta pixel or
 * other trackers (our first-party funnel is built from those events).
 */
const BLOCKED_HOSTS = [
  'apiopenpanel.91astrology.com',
  '*.openpanel.dev',
  'openpanel.dev',
  '*.googletagmanager.com',
  '*.google-analytics.com',
  '*.analytics.google.com',
  '*.doubleclick.net',
  'connect.facebook.net',
  '*.facebook.com',
  '*.datadoghq.com',
  '*.nitrocommerce.ai',
  '*.clarity.ms',
  '*.hotjar.com',
];

/** Strip tags in reading order; keep it plain text. */
export function pageText(html: string) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|section|button|a)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

const inner = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))]
    .map((m) => pageText(m[1]))
    .filter(Boolean);

/** Structured read of one of our landing pages (server-rendered HTML). */
export function parseLanding(html: string) {
  const text = pageText(html);
  const meta = (name: string) =>
    html.match(
      new RegExp(
        `<meta[^>]+(?:name|property)="${name}"[^>]+content="([^"]*)"`,
        'i',
      ),
    )?.[1];
  return {
    title: inner(html, 'title')[0] ?? '',
    description: decode(meta('description') ?? meta('og:description') ?? ''),
    headings: {
      h1: inner(html, 'h1'),
      h2: inner(html, 'h2'),
      h3: [...new Set(inner(html, 'h3'))].slice(0, 40),
    },
    /** Every ₹ amount in page order (offer price, struck price, add-ons …). */
    prices: [...text.matchAll(/₹\s?[\d,]+(?:\.\d+)?/g)].map((m) => m[0]),
    buttons: [
      ...new Set([...inner(html, 'button'), ...inner(html, 'a')]),
    ]
      .filter((t) => t.length > 1 && t.length < 60)
      .slice(0, 40),
    images: [...html.matchAll(/<img\b[^>]*alt="([^"]+)"[^>]*>/gi)]
      .map((m) => decode(m[1]))
      .slice(0, 30),
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text,
    words: text.split(/\s+/).length,
  };
}

/** Our own URL without tracking params, or null if it isn't our site. */
export function ownUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!OWN_HOST.test(u.hostname) || u.protocol !== 'https:') return null;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Our live landing pages, as the campaign's ads send people to them: full
 * text, price and offer, headings, buttons, FAQ, and a mobile screenshot the
 * model can look at with Read.
 */
@Injectable()
export class PmLandingTools {
  constructor(
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmMetaDaily.name)
    private readonly daily: Model<PmMetaDaily>,
  ) {}

  defs(): PmToolDef[] {
    return [
      {
        name: 'landing_pages',
        description:
          "The landing pages this campaign's ads send people to (our site only), with 14-day spend per page. Use landing_page to read one.",
        shape: {},
        run: (_args, ctx: PmToolCtx) => this.pagesFor(ctx),
      },
      {
        name: 'landing_page',
        description:
          "Read one of OUR live landing pages (91astrology.com only) as a mobile visitor sees it now: title, headings, every ₹ price in order (offer, struck-out price, add-ons), buttons/CTAs, image alt texts, full visible text (incl. FAQ), word count. Default url = the campaign's top-spend landing page. screenshot=true also saves a 390px-wide full-page mobile screenshot into helpers/ and returns its path — open it with Read to see above-the-fold, hierarchy and trust signals. Tracking scripts are blocked, so this never counts as a visit. The page shows today's version; it may differ from what ran earlier in the period.",
        shape: {
          url: z.string().optional(),
          screenshot: z.boolean().optional(),
        },
        run: (a: { url?: string; screenshot?: boolean }, ctx: PmToolCtx) =>
          this.read(a, ctx),
      },
    ];
  }

  private async pagesFor(ctx: PmToolCtx) {
    const from = addDays(ctx.date, -14);
    const to = addDays(ctx.date, -1);
    const [ads, spend] = await Promise.all([
      this.entities
        .find(
          { tenantId: this.env.tenantId, level: 'ad', campaignId: ctx.campaignId },
          { entityId: 1, 'creative.linkUrl': 1 },
        )
        .lean(),
      this.daily.aggregate<{ _id: string; spend: number }>([
        {
          $match: {
            tenantId: this.env.tenantId,
            campaignId: ctx.campaignId,
            date: { $gte: from, $lte: to },
          },
        },
        { $group: { _id: '$adId', spend: { $sum: '$spend' } } },
      ]),
    ]);
    const spendOf = new Map(spend.map((s) => [s._id, s.spend]));
    const pages = new Map<string, { url: string; ads: number; spend: number }>();
    for (const a of ads) {
      const url = ownUrl(a.creative?.linkUrl ?? '');
      if (!url) continue;
      const p = pages.get(url) ?? { url, ads: 0, spend: 0 };
      p.ads += 1;
      p.spend += spendOf.get(a.entityId) ?? 0;
      pages.set(url, p);
    }
    return {
      range: { from, to },
      pages: [...pages.values()]
        .map((p) => ({ ...p, spend: Math.round(p.spend) }))
        .sort((x, y) => y.spend - x.spend),
    };
  }

  private async read(a: { url?: string; screenshot?: boolean }, ctx: PmToolCtx) {
    const url = a.url
      ? ownUrl(a.url)
      : (await this.pagesFor(ctx)).pages[0]?.url ?? null;
    if (!url)
      throw new Error(
        a.url
          ? 'only https://91astrology.com pages can be read with this tool; use WebFetch for other sites'
          : 'no landing page found for this campaign; pass url',
      );
    const res = await axios.get<string>(url, {
      timeout: 20_000,
      headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-IN,hi;q=0.8' },
      responseType: 'text',
      maxContentLength: 5_000_000,
      validateStatus: () => true,
    });
    const out: Record<string, unknown> = {
      url,
      status: res.status,
      fetchedAt: new Date().toISOString(),
      ...(res.status === 200 ? parseLanding(res.data) : {}),
    };
    if (a.screenshot) out.screenshot = await this.screenshot(url, ctx);
    return out;
  }

  /**
   * ponytail: shells out to a local headless Chrome (PM_CHROME_PATH). On a
   * server without one, the tool returns text only and says so.
   */
  private async screenshot(url: string, ctx: PmToolCtx) {
    const chrome = process.env.PM_CHROME_PATH ?? '';
    if (!chrome || !existsSync(chrome))
      return { error: 'no headless Chrome configured (PM_CHROME_PATH); text only' };
    const dir = join(ctx.dir, PM_FILES.helpers, 'landing');
    await mkdir(dir, { recursive: true });
    const slug = new URL(url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
    const file = join(dir, `${slug}.png`);
    await run(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=390,2400',
        '--virtual-time-budget=8000',
        `--user-agent=${MOBILE_UA}`,
        `--host-resolver-rules=${BLOCKED_HOSTS.map((h) => `MAP ${h} ~NOTFOUND`).join(', ')}`,
        `--screenshot=${file}`,
        url,
      ],
      { timeout: 60_000 },
    );
    return { path: file, note: 'first 2400px of the page at 390px wide (mobile); open with Read' };
  }
}
