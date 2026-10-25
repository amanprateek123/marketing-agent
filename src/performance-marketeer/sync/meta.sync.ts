import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';
import {
  isTooMuchData,
  PmMetaClient,
  PmMetaError,
} from '../clients/pm-meta.client';
import { pmEnv, PmEnv } from '../pm.config';
import { istDayBounds } from '../pm.logic';
import {
  PmBreakdown,
  PmMetaAccountDaily,
  PmMetaBreakdown,
  PmMetaChange,
  PmMetaDaily,
  PmMetaEntity,
} from '../schemas/pm-meta.schema';
import { PmVisitorDay } from '../schemas/pm-visitor-day.schema';
import {
  breakdownKey,
  dateChunks,
  landingUrlOf,
  adProduct,
  majorityProduct,
  metricsOf,
  rupees,
  targetingSummary,
} from './meta.logic';

const INSIGHT_FIELDS =
  'spend,impressions,reach,frequency,clicks,inline_link_clicks,actions,action_values';

export const BREAKDOWNS: Record<PmBreakdown, string[]> = {
  region: ['region'],
  age_gender: ['age', 'gender'],
  placement: ['publisher_platform', 'platform_position'],
  device: ['device_platform'],
};

// Days per insights request. Halved on "too much data".
const DAILY_CHUNK_DAYS = 7;
const BREAKDOWN_CHUNK_DAYS = 7;
const IDS_PER_CALL = 50;

const AD_FIELDS =
  'id,name,adset_id,campaign_id,status,effective_status,created_time,creative{id,object_type,title,body,thumbnail_url,image_url,video_id,call_to_action_type,object_story_spec,asset_feed_spec,link_url,object_url}';
const ADSET_FIELDS =
  'id,name,campaign_id,status,effective_status,created_time,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,promoted_object,targeting,learning_stage_info';
const CAMPAIGN_FIELDS =
  'id,name,status,effective_status,created_time,objective,daily_budget,lifetime_budget,bid_strategy,buying_type';

const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) =>
    xs.slice(i * n, i * n + n),
  );
const date = (v: unknown) => (v ? new Date(String(v)) : null);

/**
 * Copies Meta Ads data (read-only) for the configured ad accounts:
 * daily ad insights, daily ad-set breakdowns, entity settings and the change
 * log. Upserts everywhere, so any range can be re-synced.
 */
@Injectable()
export class MetaSync {
  private readonly logger = new Logger(MetaSync.name);

  constructor(
    private readonly meta: PmMetaClient,
    @InjectModel(PmMetaDaily.name) private readonly daily: Model<PmMetaDaily>,
    @InjectModel(PmMetaBreakdown.name)
    private readonly breakdowns: Model<PmMetaBreakdown>,
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmMetaChange.name)
    private readonly changes: Model<PmMetaChange>,
    @InjectModel(PmVisitorDay.name)
    private readonly visitors: Model<PmVisitorDay>,
    @InjectModel(PmMetaAccountDaily.name)
    private readonly accountDaily: Model<PmMetaAccountDaily>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  get accounts() {
    return this.meta.accountIds;
  }

  get configured() {
    return this.meta.configured;
  }

  private beat: (() => Promise<void>) | null = null;

  /** Lets the caller extend its lock: called per chunk and before every rate-limit wait. */
  setHeartbeat(beat: (() => Promise<void>) | null) {
    this.beat = beat;
    this.meta.onWait = beat;
  }

  /** Ad-level daily insights for one account. Returns the ad ids seen. */
  async syncDaily(
    accountId: string,
    from: string,
    to: string,
  ): Promise<{ rows: number; adIds: string[] }> {
    const tenantId = this.env.tenantId;
    const adIds = new Set<string>();
    let rows = 0;
    for (const range of dateChunks(from, to, DAILY_CHUNK_DAYS)) {
      await this.beat?.();
      const data = await this.insights(accountId, range, {
        level: 'ad',
        fields: `ad_id,adset_id,campaign_id,${INSIGHT_FIELDS}`,
      });
      const known = await this.productsByEntity(
        'ad',
        data.map((r) => r.ad_id),
      );
      const ops: AnyBulkWriteOperation<PmMetaDaily>[] = data.map((r) => {
        adIds.add(r.ad_id);
        const { metrics, actions, values } = metricsOf(r);
        return {
          updateOne: {
            filter: { tenantId, adId: r.ad_id, date: r.date_start },
            update: {
              $set: {
                accountId,
                adsetId: r.adset_id ?? '',
                campaignId: r.campaign_id ?? '',
                ...metrics,
                videoPlays3s: actions['video_view'] ?? 0,
                actions,
                actionValues: values,
                ...(known.has(r.ad_id) ? { product: known.get(r.ad_id) } : {}),
              },
            },
            upsert: true,
          },
        };
      });
      if (ops.length) await this.daily.bulkWrite(ops, { ordered: false });
      rows += ops.length;
      await this.syncAccountTotals(accountId, range);
    }
    return { rows, adIds: [...adIds] };
  }

  /**
   * Account totals per day, written only after that range's ad rows were
   * stored. Days Meta returns nothing for get an explicit 0, so a missing row
   * always means "not synced", never "no spend".
   */
  private async syncAccountTotals(
    accountId: string,
    range: { since: string; until: string },
  ) {
    const tenantId = this.env.tenantId;
    const data = await this.insights(accountId, range, {
      level: 'account',
      fields: 'spend,impressions',
    });
    const byDay = new Map(data.map((r) => [r.date_start as string, r]));
    const syncedAt = new Date();
    const ops: AnyBulkWriteOperation<PmMetaAccountDaily>[] = dateChunks(
      range.since,
      range.until,
      1,
    ).map(({ since: day }) => ({
      updateOne: {
        filter: { tenantId, accountId, date: day },
        update: {
          $set: {
            spend: Number(byDay.get(day)?.spend) || 0,
            impressions: Number(byDay.get(day)?.impressions) || 0,
            syncedAt,
          },
        },
        upsert: true,
      },
    }));
    await this.accountDaily.bulkWrite(ops, { ordered: false });
  }

  /** Ad-set daily breakdowns for one account, kept by date. */
  async syncBreakdowns(
    accountId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const tenantId = this.env.tenantId;
    let rows = 0;
    for (const [name, fields] of Object.entries(BREAKDOWNS) as [
      PmBreakdown,
      string[],
    ][]) {
      for (const range of dateChunks(from, to, BREAKDOWN_CHUNK_DAYS)) {
        await this.beat?.();
        const data = await this.insights(accountId, range, {
          level: 'adset',
          fields: `adset_id,campaign_id,${INSIGHT_FIELDS}`,
          breakdowns: fields.join(','),
        });
        const known = await this.productsByEntity(
          'adset',
          data.map((r) => r.adset_id),
        );
        const ops: AnyBulkWriteOperation<PmMetaBreakdown>[] = data.map((r) => ({
          updateOne: {
            filter: {
              tenantId,
              adsetId: r.adset_id,
              date: r.date_start,
              breakdown: name,
              key: breakdownKey(r, fields),
            },
            update: {
              $set: {
                accountId,
                campaignId: r.campaign_id ?? '',
                ...metricsOf(r).metrics,
                ...(known.has(r.adset_id)
                  ? { product: known.get(r.adset_id) }
                  : {}),
              },
            },
            upsert: true,
          },
        }));
        if (ops.length)
          await this.breakdowns.bulkWrite(ops, { ordered: false });
        rows += ops.length;
      }
    }
    return rows;
  }

  /**
   * Settings for these ads and their ad sets and campaigns, then the product
   * tag for each, pushed down onto the daily and breakdown rows.
   */
  async syncEntities(accountId: string, adIds: string[]): Promise<number> {
    if (!adIds.length) return 0;
    const ads = await this.byIds(adIds, AD_FIELDS);
    const adsetIds = [...new Set(ads.map((a) => a.adset_id).filter(Boolean))];
    const campaignIds = [
      ...new Set(ads.map((a) => a.campaign_id).filter(Boolean)),
    ];
    const adsets = await this.byIds(adsetIds, ADSET_FIELDS);
    const campaigns = await this.byIds(campaignIds, CAMPAIGN_FIELDS);
    const campaignName = new Map(
      campaigns.map((c) => [c.id, String(c.name ?? '')]),
    );

    // Ad product: a readable landing URL decides; traffic/name only without one.
    const traffic = await this.trafficProducts(ads.map((a) => a.id));
    const adProductOf = new Map(
      ads.map((a) => [
        a.id,
        adProduct(
          landingUrlOf(a.creative),
          traffic.get(a.id),
          `${campaignName.get(a.campaign_id) ?? ''} ${a.name ?? ''}`,
        ),
      ]),
    );
    const tenantId = this.env.tenantId;
    const upsert = (
      level: PmMetaEntity['level'],
      entityId: string,
      set: Partial<PmMetaEntity>,
    ): AnyBulkWriteOperation<PmMetaEntity> => ({
      updateOne: {
        filter: { tenantId, level, entityId },
        update: { $set: { accountId, ...set } },
        upsert: true,
      },
    });
    const ops: AnyBulkWriteOperation<PmMetaEntity>[] = [
      ...campaigns.map((c) => {
        const hasBudget = Boolean(
          Number(c.daily_budget) || Number(c.lifetime_budget),
        );
        return upsert('campaign', c.id, {
          name: c.name ?? '',
          campaignId: c.id,
          status: c.status ?? '',
          effectiveStatus: c.effective_status ?? '',
          createdTime: date(c.created_time),
          objective: c.objective ?? '',
          dailyBudget: rupees(c.daily_budget),
          lifetimeBudget: rupees(c.lifetime_budget),
          bidStrategy: c.bid_strategy ?? '',
          buyingType: c.buying_type ?? '',
          budgetLevel: hasBudget ? 'campaign' : 'adset',
        });
      }),
      ...adsets.map((s) => {
        const campaignBudget = campaigns.find((c) => c.id === s.campaign_id);
        const cbo = Boolean(
          Number(campaignBudget?.daily_budget) ||
          Number(campaignBudget?.lifetime_budget),
        );
        return upsert('adset', s.id, {
          name: s.name ?? '',
          campaignId: s.campaign_id ?? '',
          adsetId: s.id,
          status: s.status ?? '',
          effectiveStatus: s.effective_status ?? '',
          createdTime: date(s.created_time),
          dailyBudget: rupees(s.daily_budget),
          lifetimeBudget: rupees(s.lifetime_budget),
          bidStrategy: s.bid_strategy ?? '',
          budgetLevel: cbo ? 'campaign' : 'adset',
          optimizationGoal: s.optimization_goal ?? '',
          billingEvent: s.billing_event ?? '',
          promotedObject: s.promoted_object ?? null,
          targeting: s.targeting ?? null,
          targetingSummary: targetingSummary(s.targeting),
          learningStage: s.learning_stage_info?.status ?? '',
        });
      }),
      ...ads.map((a) => {
        const c = a.creative ?? {};
        const { product, source } = adProductOf.get(a.id)!;
        return upsert('ad', a.id, {
          name: a.name ?? '',
          campaignId: a.campaign_id ?? '',
          adsetId: a.adset_id ?? '',
          status: a.status ?? '',
          effectiveStatus: a.effective_status ?? '',
          createdTime: date(a.created_time),
          product,
          productSource: source,
          creative: {
            id: c.id,
            title: c.title ?? c.asset_feed_spec?.titles?.[0]?.text,
            body: c.body ?? c.asset_feed_spec?.bodies?.[0]?.text,
            cta:
              c.call_to_action_type ??
              c.asset_feed_spec?.call_to_action_types?.[0],
            linkUrl: landingUrlOf(c),
            imageUrl: c.image_url,
            thumbnailUrl: c.thumbnail_url,
            videoId: c.video_id,
            objectType: c.object_type,
          },
        });
      }),
    ];
    if (ops.length) await this.entities.bulkWrite(ops, { ordered: false });
    await this.retagParents(adsetIds, campaignIds);
    return ops.length;
  }

  /**
   * Re-derive every product tag from stored data only (no Meta calls): ads
   * from their saved landing URL / traffic / name, then parents, then the
   * daily and breakdown rows. Safe to run any time.
   */
  async retagAll(): Promise<number> {
    const tenantId = this.env.tenantId;
    const ads = await this.entities
      .find(
        { tenantId, level: 'ad' },
        { entityId: 1, name: 1, campaignId: 1, 'creative.linkUrl': 1 },
      )
      .lean();
    const campaigns = await this.entities
      .find({ tenantId, level: 'campaign' }, { entityId: 1, name: 1 })
      .lean();
    const campaignName = new Map(campaigns.map((c) => [c.entityId, c.name]));
    const traffic = await this.trafficProducts(ads.map((a) => a.entityId));
    const ops: AnyBulkWriteOperation<PmMetaEntity>[] = ads.map((a) => {
      const { product, source } = adProduct(
        a.creative?.linkUrl ?? '',
        traffic.get(a.entityId),
        `${campaignName.get(a.campaignId) ?? ''} ${a.name ?? ''}`,
      );
      return {
        updateOne: {
          filter: { tenantId, level: 'ad', entityId: a.entityId },
          update: { $set: { product, productSource: source } },
        },
      };
    });
    if (ops.length) await this.entities.bulkWrite(ops, { ordered: false });
    const adsetIds: string[] = await this.entities.distinct('entityId', {
      tenantId,
      level: 'adset',
    });
    const campaignIds = campaigns.map((c) => c.entityId);
    await this.retagParents(adsetIds, campaignIds);
    return ops.length;
  }

  private async retagParents(adsetIds: string[], campaignIds: string[]) {
    for (const ids of chunk(adsetIds, 500)) await this.tagParents('adset', ids);
    for (const ids of chunk(campaignIds, 500))
      await this.tagParents('campaign', ids);
    await this.pushDownProducts();
  }

  /** A parent's product = the product most of its ads' spend went to (over every ad we know). */
  private async tagParents(level: 'adset' | 'campaign', ids: string[]) {
    if (!ids.length) return;
    const tenantId = this.env.tenantId;
    const field = level === 'adset' ? 'adsetId' : 'campaignId';
    const ads = await this.entities
      .find(
        { tenantId, level: 'ad', [field]: { $in: ids } },
        { entityId: 1, product: 1, adsetId: 1, campaignId: 1 },
      )
      .lean();
    const spend = await this.spendByAd(ads.map((a) => a.entityId));
    await this.entities.bulkWrite(
      ids.map((id) => ({
        updateOne: {
          filter: { tenantId, level, entityId: id },
          update: {
            $set: {
              product: majorityProduct(
                ads
                  .filter((a) => a[field] === id)
                  .map((a) => ({
                    product: a.product,
                    spend: spend.get(a.entityId) ?? 0,
                  })),
              ),
              productSource: 'children',
            },
          },
        },
      })),
      { ordered: false },
    );
  }

  /** Meta's activity log for one account. */
  async syncChanges(
    accountId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const tenantId = this.env.tenantId;
    const rows = await this.meta.getAll<Record<string, any>>(
      `act_${accountId}/activities`,
      {
        fields:
          'event_time,event_type,translated_event_type,object_id,object_name,object_type,extra_data,actor_name',
        // Bare dates make Meta drop the last day; use the IST bounds of the whole range.
        since: Math.floor(istDayBounds(from).start.getTime() / 1000),
        until: Math.floor(istDayBounds(to).end.getTime() / 1000),
        limit: 500,
      },
    );
    const ops: AnyBulkWriteOperation<PmMetaChange>[] = rows.map((r) => {
      const key = createHash('sha1')
        .update(
          `${accountId}|${r.event_time}|${r.object_id}|${r.event_type}|${r.extra_data ?? ''}`,
        )
        .digest('hex');
      return {
        updateOne: {
          filter: { tenantId, key },
          update: {
            $set: {
              accountId,
              eventTime: new Date(r.event_time),
              eventType: r.event_type ?? '',
              translatedEventType: r.translated_event_type ?? '',
              objectType: r.object_type ?? '',
              objectId: String(r.object_id ?? ''),
              objectName: r.object_name ?? '',
              actorName: r.actor_name ?? '',
              extraData: String(r.extra_data ?? '').slice(0, 4000),
            },
          },
          upsert: true,
        },
      };
    });
    if (ops.length) await this.changes.bulkWrite(ops, { ordered: false });
    return ops.length;
  }

  /** Ads of one account that spent in range: all of them, or only those without a settings row yet. */
  async adsToRefresh(
    accountId: string,
    from: string,
    to: string,
    which: 'missing' | 'all',
  ): Promise<string[]> {
    const tenantId = this.env.tenantId;
    const spent: string[] = await this.daily.distinct('adId', {
      tenantId,
      accountId,
      date: { $gte: from, $lte: to },
      spend: { $gt: 0 },
    });
    if (which === 'all') return spent;
    const have = new Set<string>(
      await this.entities.distinct('entityId', {
        tenantId,
        level: 'ad',
        entityId: { $in: spent },
      }),
    );
    return spent.filter((id) => !have.has(id));
  }

  /** Insights for one account and date range; halves the range when Meta says it's too much data. */
  private async insights(
    accountId: string,
    range: { since: string; until: string },
    params: Record<string, string>,
  ): Promise<Record<string, any>[]> {
    try {
      return await this.meta.getAll<Record<string, any>>(
        `act_${accountId}/insights`,
        {
          ...params,
          time_range: { since: range.since, until: range.until },
          time_increment: 1,
          use_unified_attribution_setting: true,
          // No status filter: Meta rejects one on insights, and without it
          // ad-level spend already adds up to the account total (checked on
          // Aug 2026 for all three accounts). Pages of 100 avoid "too much data".
          limit: 100,
        },
      );
    } catch (e) {
      const tooMuch =
        e instanceof PmMetaError && isTooMuchData(e.code, e.message);
      if (!tooMuch || range.since === range.until) throw e;
      const days = dateChunks(range.since, range.until, 1);
      const mid = Math.ceil(days.length / 2);
      this.logger.warn(
        `Meta: too much data for ${range.since}..${range.until}, splitting`,
      );
      const newer = { since: days[mid - 1].since, until: range.until };
      const older = { since: range.since, until: days[mid].until };
      return [
        ...(await this.insights(accountId, newer, params)),
        ...(await this.insights(accountId, older, params)),
      ];
    }
  }

  private async byIds(
    ids: string[],
    fields: string,
  ): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = [];
    for (const batch of chunk(ids, IDS_PER_CALL)) {
      await this.beat?.();
      try {
        const res = await this.meta.get<Record<string, Record<string, any>>>(
          '',
          { ids: batch.join(','), fields },
        );
        out.push(...Object.values(res));
      } catch (e) {
        // Only an unknown/deleted object (code 100) fails a whole batch for one bad id;
        // anything else (rate limit, token, permission) is rethrown, not multiplied by 50.
        if (!(e instanceof PmMetaError) || e.code !== 100 || batch.length === 1)
          throw e;
        for (const id of batch) {
          try {
            out.push(await this.meta.get<Record<string, any>>(id, { fields }));
          } catch (err) {
            this.logger.warn(`Meta: skipped ${id}: ${(err as Error).message}`);
          }
        }
      }
    }
    return out;
  }

  private async productsByEntity(level: 'ad' | 'adset', ids: string[]) {
    const rows = await this.entities
      .find(
        {
          tenantId: this.env.tenantId,
          level,
          entityId: { $in: [...new Set(ids)] },
        },
        { entityId: 1, product: 1 },
      )
      .lean();
    return new Map(rows.map((r) => [r.entityId, r.product]));
  }

  /** Ad id → product its OpenPanel visitors landed on (majority), for ads without a parsable URL. */
  private async trafficProducts(adIds: string[]) {
    const rows = await this.visitors.aggregate<{
      _id: { ad: string; product: string };
      n: number;
    }>([
      {
        $match: {
          tenantId: this.env.tenantId,
          'metaAd.last.adId': { $in: adIds },
        },
      },
      {
        $group: {
          _id: { ad: '$metaAd.last.adId', product: '$product' },
          n: { $sum: 1 },
        },
      },
    ]);
    const best = new Map<string, { product: string; n: number }>();
    for (const r of rows) {
      const cur = best.get(r._id.ad);
      if (!cur || r.n > cur.n)
        best.set(r._id.ad, { product: r._id.product, n: r.n });
    }
    return new Map([...best].map(([ad, v]) => [ad, v.product]));
  }

  private async spendByAd(adIds: string[]) {
    const rows = await this.daily.aggregate<{ _id: string; spend: number }>([
      { $match: { tenantId: this.env.tenantId, adId: { $in: adIds } } },
      { $group: { _id: '$adId', spend: { $sum: '$spend' } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.spend]));
  }

  /** Copy each entity's product onto its daily / breakdown rows (one update per product). */
  private async pushDownProducts() {
    const tenantId = this.env.tenantId;
    const tag = async (
      level: 'ad' | 'adset',
      model: Model<any>,
      field: string,
    ) => {
      const groups = await this.entities.aggregate<{
        _id: string;
        ids: string[];
      }>([
        { $match: { tenantId, level } },
        { $group: { _id: '$product', ids: { $push: '$entityId' } } },
      ]);
      for (const g of groups) {
        for (const ids of chunk(g.ids, 5000)) {
          await model.updateMany(
            { tenantId, [field]: { $in: ids }, product: { $ne: g._id } },
            { $set: { product: g._id } },
          );
        }
      }
    };
    await tag('ad', this.daily, 'adId');
    await tag('adset', this.breakdowns, 'adsetId');
  }
}
