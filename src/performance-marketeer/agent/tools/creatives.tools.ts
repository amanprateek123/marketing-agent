import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import axios from 'axios';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Model } from 'mongoose';
import { z } from 'zod';
import { addDays, ratio, relChange } from '../../analysis/pm-stats';
import { PmMetaClient } from '../../clients/pm-meta.client';
import { pmEnv, PmEnv } from '../../pm.config';
import { dayRange } from '../../pm.logic';
import { PmMetaDaily, PmMetaEntity } from '../../schemas/pm-meta.schema';
import { PmOrder } from '../../schemas/pm-order.schema';
import { PmProxyClient } from '../competitors/proxy.client';
import { PM_FILES, PmToolCtx } from '../pm-agent.types';
import { PmToolDef } from './pm-tool';

const run = promisify(execFile);

/** Media cache (Meta URLs expire): var/pm-agent/cache, gitignored. */
const CREATIVES = {
  cacheDir: () =>
    resolve(process.env.PM_AGENT_CACHE_DIR ?? 'var/pm-agent/cache'),
  ffmpeg: () => process.env.FFMPEG_PATH ?? 'ffmpeg',
  maxImages: 6,
  maxVideos: 2,
  hookFrames: 6, // fps=2 over the first 3 s
  sceneFrames: 6,
  sceneThreshold: 0.35,
  maxSide: 1024,
  maxVideoBytes: 300 * 1024 * 1024,
};
const SCALE = `scale=w='min(${CREATIVES.maxSide},iw)':h='min(${CREATIVES.maxSide},ih)':force_original_aspect_ratio=decrease`;

/** CTR change first half → second half below this (and enough impressions) = fatigue signal. */
const FATIGUE_CTR_DROP = -0.2;
const MIN_HALF_IMPRESSIONS = 1000;

type Daily = Pick<
  PmMetaDaily,
  | 'adId'
  | 'date'
  | 'spend'
  | 'impressions'
  | 'linkClicks'
  | 'frequency'
  | 'videoPlays3s'
  | 'thruPlays'
>;
type OrderDay = { adId: string; day: string; orders: number; revenue: number };

const r4 = (v: number | null) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

/** One ad over from..to (inclusive). Pure; exported for tests. */
export function creativeWindow(
  rows: Daily[],
  orders: OrderDay[],
  from: string,
  to: string,
  video = true,
) {
  const inRange = <T extends { date?: string; day?: string }>(x: T) => {
    const d = (x.date ?? x.day)!;
    return d >= from && d <= to;
  };
  const days = rows.filter(inRange);
  const sum = (rs: Daily[], k: keyof Daily) =>
    rs.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const spend = sum(days, 'spend');
  const impressions = sum(days, 'impressions');
  const linkClicks = sum(days, 'linkClicks');
  const plays3s = sum(days, 'videoPlays3s');
  const thru = sum(days, 'thruPlays');
  const o = orders.filter(inRange);
  const nOrders = o.reduce((s, x) => s + x.orders, 0);
  const revenue = o.reduce((s, x) => s + x.revenue, 0);
  const all = dayRange(from, to);
  const mid = all[Math.floor(all.length / 2)];
  const first = days.filter((r) => r.date < mid);
  const second = days.filter((r) => r.date >= mid);
  const ctrOf = (rs: Daily[]) =>
    ratio(sum(rs, 'linkClicks'), sum(rs, 'impressions'));
  const freqOf = (rs: Daily[]) =>
    ratio(
      rs.reduce((s, r) => s + r.frequency * r.impressions, 0),
      sum(rs, 'impressions'),
    );
  const ctrFirst = ctrOf(first);
  const ctrSecond = ctrOf(second);
  const ctrTrend = relChange(ctrSecond, ctrFirst);
  const enough =
    sum(first, 'impressions') >= MIN_HALF_IMPRESSIONS &&
    sum(second, 'impressions') >= MIN_HALF_IMPRESSIONS;
  return {
    from,
    to,
    activeDays: days.filter((r) => r.impressions > 0).length,
    spend: r2(spend),
    impressions,
    linkClicks,
    ctr: r4(ratio(linkClicks, impressions)),
    cpm: r2(ratio(spend * 1000, impressions)),
    frequency: r2(freqOf(days)),
    /** 3-s video plays ÷ impressions (null for non-video ads). */
    hookRate: video ? r4(ratio(plays3s, impressions)) : null,
    /** ThruPlays ÷ impressions. */
    holdRate: video ? r4(ratio(thru, impressions)) : null,
    firstPartyOrders: nOrders,
    firstPartyRevenue: r2(revenue),
    firstPartyRoas: r2(ratio(revenue, spend)),
    ctrFirstHalf: r4(ctrFirst),
    ctrSecondHalf: r4(ctrSecond),
    ctrTrendPct: r4(ctrTrend),
    frequencyFirstHalf: r2(freqOf(first)),
    frequencySecondHalf: r2(freqOf(second)),
    fatigue: !enough
      ? ('not_enough_data' as const)
      : ctrTrend != null && ctrTrend <= FATIGUE_CTR_DROP
        ? ('ctr_falling' as const)
        : ('stable' as const),
  };
}

interface GraphCreative {
  object_type?: string;
  image_hash?: string;
  image_url?: string;
  thumbnail_url?: string;
  video_id?: string;
  asset_feed_spec?: {
    images?: { hash?: string }[];
    videos?: { video_id?: string; thumbnail_url?: string }[];
  };
  object_story_spec?: {
    link_data?: {
      image_hash?: string;
      picture?: string;
      child_attachments?: {
        image_hash?: string;
        picture?: string;
        video_id?: string;
      }[];
    };
    video_data?: { video_id?: string; image_url?: string };
  };
}

@Injectable()
export class PmCreativeTools {
  constructor(
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmMetaDaily.name) private readonly daily: Model<PmMetaDaily>,
    @InjectModel(PmOrder.name) private readonly orders: Model<PmOrder>,
    private readonly meta: PmMetaClient,
    private readonly proxy: PmProxyClient,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  defs(): PmToolDef[] {
    return [
      {
        name: 'list_creatives',
        description:
          "Ads of this campaign with their creative (title, body, CTA, link), type, status, created time and spend over the last 14 days. Type 'other' = carousel / dynamic / placement-customised creative — get_creative resolves its assets.",
        shape: {},
        run: (_a, ctx) => this.listCreatives(ctx),
      },
      {
        name: 'get_creative',
        description:
          "Downloads one ad's image(s), or for a video its frames (first 3 s = the hook, plus scene changes) and a transcript when available, into this campaign's helpers/creatives/ folder. Returns the file paths: use the Read tool on them to look at the creative.",
        shape: { adId: z.string().regex(/^\d+$/).describe('Meta ad id') },
        run: (a: { adId: string }, ctx) => this.getCreative(a.adId, ctx),
      },
      {
        name: 'creative_metrics',
        description:
          'Per ad over the last 7 and 14 days (to the day before the run date): impressions, CTR (link clicks ÷ impressions), CPM, frequency (impression-weighted daily), hook rate (3-s plays ÷ impressions), hold rate (ThruPlays ÷ impressions), first-party orders / revenue / ROAS (last-click ad, 7-day device attribution, net of GST), and CTR first half vs second half of each window — a fall of 20%+ is flagged as a fatigue signal. Omit adId for every ad of this campaign.',
        shape: {
          adId: z.string().regex(/^\d+$/).optional().describe('Meta ad id'),
        },
        run: (a: { adId?: string }, ctx) => this.creativeMetrics(ctx, a.adId),
      },
    ];
  }

  // ---------- list ----------

  private async listCreatives(ctx: PmToolCtx) {
    const t = this.env.tenantId;
    const from = addDays(ctx.date, -14);
    const to = addDays(ctx.date, -1);
    const [ads, spend] = await Promise.all([
      this.entities
        .find({ tenantId: t, level: 'ad', campaignId: ctx.campaignId })
        .lean(),
      this.daily.aggregate<{ _id: string; spend: number }>([
        {
          $match: {
            tenantId: t,
            campaignId: ctx.campaignId,
            date: { $gte: from, $lte: to },
          },
        },
        { $group: { _id: '$adId', spend: { $sum: '$spend' } } },
      ]),
    ]);
    const byAd = new Map(spend.map((s) => [s._id, s.spend]));
    return {
      range: { from, to },
      ads: ads
        .map((a) => {
          const c = a.creative ?? {};
          return {
            adId: a.entityId,
            name: a.name,
            adsetId: a.adsetId,
            status: a.status,
            effectiveStatus: a.effectiveStatus,
            created: a.createdTime,
            type: c.videoId ? 'video' : c.imageUrl ? 'image' : 'other',
            title: c.title ?? '',
            body: c.body ?? '',
            cta: c.cta ?? '',
            linkUrl: c.linkUrl ?? '',
            spend14d: Math.round((byAd.get(a.entityId) ?? 0) * 100) / 100,
          };
        })
        .sort((x, y) => y.spend14d - x.spend14d),
    };
  }

  // ---------- metrics ----------

  private async creativeMetrics(ctx: PmToolCtx, adId?: string) {
    const t = this.env.tenantId;
    const to = addDays(ctx.date, -1);
    const from = addDays(ctx.date, -14);
    const from7 = addDays(ctx.date, -7);
    const scope = adId ? { adId } : { campaignId: ctx.campaignId };
    const rows = await this.daily
      .find(
        { tenantId: t, ...scope, date: { $gte: from, $lte: to } },
        {
          adId: 1,
          date: 1,
          spend: 1,
          impressions: 1,
          linkClicks: 1,
          frequency: 1,
          videoPlays3s: 1,
          thruPlays: 1,
        },
      )
      .lean<Daily[]>();
    const adIds = [...new Set(rows.map((r) => r.adId))];
    const [ords, names] = await Promise.all([
      this.orders.aggregate<{
        _id: { adId: string; day: string };
        orders: number;
        revenue: number;
      }>([
        {
          $match: {
            tenantId: t,
            day: { $gte: from, $lte: to },
            confirmed: true,
            adminCreated: false,
            'attribution.metaLast.adId': { $in: adIds },
          },
        },
        {
          $group: {
            _id: { adId: '$attribution.metaLast.adId', day: '$day' },
            orders: { $sum: 1 },
            revenue: { $sum: '$netRevenue' },
          },
        },
      ]),
      this.entities
        .find(
          { tenantId: t, level: 'ad', entityId: { $in: adIds } },
          { entityId: 1, name: 1, 'creative.videoId': 1 },
        )
        .lean(),
    ]);
    const orderDays: OrderDay[] = ords.map((o) => ({ ...o._id, ...o }));
    const name = new Map(names.map((n) => [n.entityId, n.name]));
    const isVideo = new Set(
      names.filter((n) => n.creative?.videoId).map((n) => n.entityId),
    );
    const ads = adIds.map((id) => {
      const rs = rows.filter((r) => r.adId === id);
      const os = orderDays.filter((o) => o.adId === id);
      return {
        adId: id,
        name: name.get(id) ?? '',
        d7: creativeWindow(rs, os, from7, to, isVideo.has(id)),
        d14: creativeWindow(rs, os, from, to, isVideo.has(id)),
      };
    });
    ads.sort((a, b) => (b.d14.spend ?? 0) - (a.d14.spend ?? 0));
    return {
      attribution: 'first_party_device_7d_click (last-click Meta ad)',
      ads,
    };
  }

  // ---------- media ----------

  private async getCreative(adId: string, ctx: PmToolCtx) {
    const ad = await this.entities
      .findOne({ tenantId: this.env.tenantId, level: 'ad', entityId: adId })
      .lean();
    if (!ad?.creative?.id)
      throw new Error(`ad ${adId} not found or has no creative`);
    const outDir = join(ctx.dir, PM_FILES.helpers, 'creatives');
    await mkdir(outDir, { recursive: true });
    // Fresh from Meta: stored URLs expire, and asset-feed creatives keep their assets here only.
    const g = await this.meta.get<GraphCreative>(ad.creative.id, {
      fields:
        'object_type,image_hash,image_url,thumbnail_url,video_id,asset_feed_spec{images,videos},object_story_spec{link_data{image_hash,picture,child_attachments{image_hash,picture,video_id}},video_data{video_id,image_url}}',
    });
    const oss = g.object_story_spec ?? {};
    const kids = oss.link_data?.child_attachments ?? [];
    const uniq = (xs: (string | undefined)[]) => [
      ...new Set(xs.filter(Boolean) as string[]),
    ];
    const hashes = uniq([
      g.image_hash,
      oss.link_data?.image_hash,
      ...kids.map((k) => k.image_hash),
      ...(g.asset_feed_spec?.images ?? []).map((i) => i.hash),
    ]).slice(0, CREATIVES.maxImages);
    const videoIds = uniq([
      g.video_id,
      oss.video_data?.video_id,
      ...kids.map((k) => k.video_id),
      ...(g.asset_feed_spec?.videos ?? []).map((v) => v.video_id),
    ]).slice(0, CREATIVES.maxVideos);
    const type =
      kids.length > 1
        ? 'carousel'
        : videoIds.length
          ? 'video'
          : (g.asset_feed_spec?.images?.length ?? 0) > 1
            ? 'image_set'
            : 'image';

    const notes: string[] = [];
    const images: string[] = [];
    if (hashes.length) {
      const urls = await this.imageUrls(ad.accountId, hashes).catch((e) => {
        notes.push(`adimages lookup failed: ${(e as Error).message}`);
        return new Map<string, string>();
      });
      for (const [i, h] of hashes.entries()) {
        const url = urls.get(h);
        if (!url) continue;
        const cached = await this.cachedJpg(`images/${h}.jpg`, url);
        images.push(
          await this.copyOut(
            cached,
            outDir,
            `${adId}${i ? `-${i + 1}` : ''}.jpg`,
          ),
        );
      }
    }
    if (!images.length && !videoIds.length) {
      const url = g.image_url || oss.link_data?.picture || g.thumbnail_url;
      if (url) {
        const cached = await this.cachedJpg(
          `images/creative-${ad.creative.id}.jpg`,
          url,
        );
        images.push(await this.copyOut(cached, outDir, `${adId}.jpg`));
        if (!g.image_url)
          notes.push('only the creative thumbnail was available');
      }
    }

    const videos: unknown[] = [];
    for (const [i, vid] of videoIds.entries())
      videos.push(
        await this.video(vid, i ? `${adId}-v${i + 1}` : adId, outDir, notes),
      );

    return {
      adId,
      type,
      text: {
        title: ad.creative.title ?? '',
        body: ad.creative.body ?? '',
        cta: ad.creative.cta ?? '',
        linkUrl: ad.creative.linkUrl ?? '',
      },
      images,
      videos,
      notes,
      howToView: 'Use the Read tool on each path to see the image/frame.',
    };
  }

  /** `prefix` = output file prefix: the ad id (…-v2 for a second video in the same ad). */
  private async video(
    videoId: string,
    prefix: string,
    outDir: string,
    notes: string[],
  ) {
    const v = await this.meta.get<{
      source?: string;
      length?: number;
      picture?: string;
    }>(videoId, { fields: 'source,length,picture' });
    const lengthSec = v.length ?? null;
    const frames: string[] = [];
    let transcript: unknown = null;
    let frameKind: 'timed' | 'meta_thumbnails' = 'timed';
    const cache = CREATIVES.cacheDir();
    const frameDir = join(cache, 'frames', videoId);
    if (v.source) {
      if (!existsSync(join(frameDir, 'done'))) {
        const mp4 = join(cache, 'videos', `${videoId}.mp4`);
        if (!existsSync(mp4)) await this.download(v.source, mp4);
        await this.extractFrames(mp4, frameDir);
      }
      try {
        const t = await this.proxy.cached(
          `analyze_ad_video:meta-video:${videoId}`,
          'analyze_ad_video',
          { media_url: v.source, ad_id: videoId },
        );
        transcript = t.result;
      } catch (e) {
        notes.push(`transcript failed (frames only): ${(e as Error).message}`);
      }
    } else {
      // ads_read can't read `source` for page-owned videos: fall back to Meta's own thumbnails.
      frameKind = 'meta_thumbnails';
      notes.push(
        `video ${videoId}: Meta did not return the video file to this token (ads_read) — frames are Meta's auto-picked thumbnails (not timed, the hook may be missing) and there is no transcript`,
      );
      if (!existsSync(join(frameDir, 'done'))) {
        const th = await this.meta.get<{
          data: { uri: string; is_preferred?: boolean }[];
        }>(`${videoId}/thumbnails`, { fields: 'uri,is_preferred' });
        const list = [...(th.data ?? [])]
          .sort((a, b) => Number(!!b.is_preferred) - Number(!!a.is_preferred))
          .slice(0, CREATIVES.hookFrames);
        if (!list.length && v.picture) list.push({ uri: v.picture });
        await mkdir(frameDir, { recursive: true });
        for (const [i, t] of list.entries())
          await this.toJpg(
            t.uri,
            join(frameDir, `t${String(i + 1).padStart(2, '0')}.jpg`),
          );
        await this.touch(join(frameDir, 'done'));
      }
    }
    for (const f of (await readdir(frameDir))
      .filter((f) => f.endsWith('.jpg'))
      .sort())
      frames.push(
        await this.copyOut(join(frameDir, f), outDir, `${prefix}-${f}`),
      );
    return { videoId, lengthSec, frameKind, frames, transcript };
  }

  /** f01–f06: first 3 s at 2 fps (the hook); f07…: scene changes. */
  private async extractFrames(mp4: string, dir: string) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const ff = CREATIVES.ffmpeg();
    await run(
      ff,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-t',
        '3',
        '-i',
        mp4,
        '-vf',
        `fps=2,${SCALE}`,
        '-frames:v',
        String(CREATIVES.hookFrames),
        '-q:v',
        '3',
        join(dir, 'h%02d.jpg'),
      ],
      { timeout: 120_000 },
    );
    await run(
      ff,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '3',
        '-i',
        mp4,
        '-vf',
        `select='gt(scene,${CREATIVES.sceneThreshold})',${SCALE}`,
        '-fps_mode',
        'vfr',
        '-frames:v',
        String(CREATIVES.sceneFrames),
        '-q:v',
        '3',
        join(dir, 's%02d.jpg'),
      ],
      { timeout: 300_000 },
    );
    // Rename to one sequence: hook first, then scenes.
    const files = (await readdir(dir)).sort();
    const ordered = [
      ...files.filter((f) => f.startsWith('h')),
      ...files.filter((f) => f.startsWith('s')),
    ];
    for (const [i, f] of ordered.entries())
      await copyFile(
        join(dir, f),
        join(dir, `f${String(i + 1).padStart(2, '0')}.jpg`),
      );
    for (const f of files) await rm(join(dir, f));
    await this.touch(join(dir, 'done'));
  }

  private async imageUrls(accountId: string, hashes: string[]) {
    const rows = await this.meta.getAll<{ hash: string; url?: string }>(
      `act_${accountId}/adimages`,
      { hashes, fields: 'hash,url' },
    );
    return new Map(rows.filter((r) => r.url).map((r) => [r.hash, r.url!]));
  }

  /** Download once into the cache as a ≤1024 px jpg. */
  private async cachedJpg(rel: string, url: string) {
    const file = join(CREATIVES.cacheDir(), rel);
    if (!existsSync(file)) await this.toJpg(url, file);
    return file;
  }

  private async toJpg(url: string, file: string) {
    const raw = `${file}.raw`;
    await this.download(url, raw);
    try {
      await run(
        CREATIVES.ffmpeg(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          raw,
          '-vf',
          SCALE,
          '-frames:v',
          '1',
          '-q:v',
          '3',
          file,
        ],
        { timeout: 60_000 },
      );
    } finally {
      await rm(raw, { force: true });
    }
  }

  private async download(url: string, file: string) {
    await mkdir(dirname(file), { recursive: true });
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 180_000,
      maxContentLength: CREATIVES.maxVideoBytes,
    });
    const tmp = `${file}.part`;
    await pipeline(res.data, createWriteStream(tmp));
    await rename(tmp, file);
  }

  private async copyOut(src: string, dir: string, name: string) {
    const out = join(dir, name);
    await copyFile(src, out);
    return out;
  }

  private touch(file: string) {
    return writeFile(file, '');
  }
}
