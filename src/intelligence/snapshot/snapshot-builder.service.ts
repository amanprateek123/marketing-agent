import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AdMetricSet,
  MetricSet,
  ProductForRevenue,
  RawMetaAd,
  RawMetaAdSet,
  RawMetaBundle,
  RawMetaCampaign,
  SnapshotData,
} from './snapshot.types';

/**
 * Pure function: raw Meta payload + company product → SnapshotData.
 * No I/O. Every calculation here is deterministic; SnapshotValidator
 * separately reports which fields are missing.
 */
@Injectable()
export class SnapshotBuilder {
  build(input: {
    bundle: RawMetaBundle;
    products: ProductForRevenue[];
    now?: Date;
  }): SnapshotData {
    const now = input.now ?? new Date();
    const snapshotId = `snap-${randomUUID()}`;
    const campaignMetrics = this.normalizeCampaign(
      input.bundle.campaign,
      input.products,
    );
    const adSetMetrics: Record<string, MetricSet> = {};
    for (const [id, raw] of Object.entries(input.bundle.adSets ?? {})) {
      adSetMetrics[id] = this.normalizeAdSet(raw, input.products);
    }
    const adMetrics: Record<string, AdMetricSet> = {};
    for (const [id, raw] of Object.entries(input.bundle.ads ?? {})) {
      adMetrics[id] = this.normalizeAd(raw, input.products);
    }
    const freshnessSource =
      input.bundle.sourceMetricsSyncedAt === null
        ? undefined
        : (input.bundle.sourceMetricsSyncedAt ?? input.bundle.metaWindowEnd);
    const freshnessSourceMs = freshnessSource?.getTime();
    const freshnessSec = Number.isFinite(freshnessSourceMs)
      ? Math.max(0, Math.round((now.getTime() - freshnessSourceMs!) / 1000))
      : -1;
    return {
      snapshotId,
      collectedAt: now,
      freshnessSec,
      metrics: {
        campaignLevel: campaignMetrics,
        adSetLevel: adSetMetrics,
        adLevel: adMetrics,
      },
      meta: {
        learningStage: this.mapLearningStage(
          input.bundle.campaign.learning_stage,
        ),
        deliveryStatus: input.bundle.campaign.effective_status,
        accountId: input.bundle.campaign.account_id ?? '',
        objective: input.bundle.campaign.objective || undefined,
        metricScope: input.bundle.metricScope,
      },
      missingFields: this.detectMissingFields(campaignMetrics, adSetMetrics),
    };
  }

  private normalizeCampaign(
    raw: RawMetaCampaign,
    products: ProductForRevenue[],
  ): MetricSet {
    const base = this.baseMetrics(raw.insights);
    base.revenue = this.computeRevenue(raw.insights, products);
    base.cvr = this.safeDiv(base.purchases, base.clicks);
    base.aov = this.safeDiv(base.revenue, base.purchases);
    base.roas = this.safeDiv(base.revenue, base.spend);
    return base;
  }

  private normalizeAdSet(
    raw: RawMetaAdSet,
    products: ProductForRevenue[],
  ): MetricSet {
    const base = this.baseMetrics(raw.insights);
    base.revenue = this.computeRevenue(raw.insights, products);
    base.roas = this.safeDiv(base.revenue, base.spend);
    // CVR intentionally not computed at adset level without a click floor.
    return base;
  }

  private normalizeAd(
    raw: RawMetaAd,
    products: ProductForRevenue[],
  ): AdMetricSet {
    const base = this.baseMetrics(raw.insights);
    base.revenue = this.computeRevenue(raw.insights, products);
    base.roas = this.safeDiv(base.revenue, base.spend);
    return {
      ...base,
      hookStyle: raw.hookStyle,
      format: raw.format,
      copyVariantIndex: raw.copyVariantIndex,
      qualityRanking: this.mapRanking(raw.quality_ranking),
      engagementRanking: this.mapRanking(raw.engagement_ranking),
      conversionRanking: this.mapRanking(raw.conversion_ranking),
      videoP25: this.pickFirstValue(raw.insights?.video_p25_watched_actions),
      videoP50: this.pickFirstValue(raw.insights?.video_p50_watched_actions),
      videoP75: this.pickFirstValue(raw.insights?.video_p75_watched_actions),
      videoP100: this.pickFirstValue(raw.insights?.video_p100_watched_actions),
    };
  }

  private baseMetrics(insights?: RawMetaCampaign['insights']): MetricSet {
    return {
      spend: this.toNumber(insights?.spend),
      revenue: 0, // filled by computeRevenue
      impressions: this.toNumber(insights?.impressions),
      reach: this.toNumber(insights?.reach),
      clicks: this.toNumber(insights?.clicks),
      ctr: this.toNumber(insights?.ctr),
      cpc: this.toNumber(insights?.cpc),
      cpm: this.toNumber(insights?.cpm),
      cvr: 0,
      purchases: this.actionValue(insights?.actions, 'purchase'),
      addToCart: this.actionValue(insights?.actions, 'add_to_cart'),
      initiateCheckout: this.actionValue(
        insights?.actions,
        'initiate_checkout',
      ),
      roas: 0,
      aov: 0,
      frequency: this.toNumber(insights?.frequency),
    };
  }

  /**
   * Revenue = raw purchase action_value * (1 - refund haircut).
   * Falls back to purchases × product.conversionValue when Meta omits
   * action_values (common when the tenant hasn't wired the Meta pixel).
   * If no product info, revenue is 0 (SnapshotValidator flags this).
   */
  private computeRevenue(
    insights: RawMetaCampaign['insights'],
    products: ProductForRevenue[],
  ): number {
    const rawRevenue = this.actionValue(insights?.action_values, 'purchase');
    const product = products[0];
    const refundHaircut = product?.refundRatePercent
      ? Math.max(0, 1 - product.refundRatePercent / 100)
      : 1;
    if (rawRevenue > 0) return this.round2(rawRevenue * refundHaircut);
    if (!product?.conversionValue) return 0;
    const purchases = this.actionValue(insights?.actions, 'purchase');
    return this.round2(purchases * product.conversionValue * refundHaircut);
  }

  private actionValue(
    actions: Array<{ action_type: string; value: number | string }> | undefined,
    kind: string,
  ): number {
    if (!actions?.length) return 0;
    const hit = actions.find((a) => a.action_type === kind);
    return hit ? this.toNumber(hit.value) : 0;
  }

  private detectMissingFields(
    campaign: MetricSet,
    adSets: Record<string, MetricSet>,
  ): string[] {
    const missing: string[] = [];
    if (campaign.spend === 0 && campaign.impressions === 0)
      missing.push('spend');
    if (campaign.impressions === 0) missing.push('impressions');
    if (campaign.frequency === 0 && campaign.impressions > 0)
      missing.push('frequency');
    if (Object.keys(adSets).length === 0) missing.push('ad_set_breakdown');
    return missing;
  }

  private mapLearningStage(
    raw?: string,
  ): SnapshotData['meta']['learningStage'] {
    if (!raw) return undefined;
    const upper = raw.toUpperCase();
    if (
      upper === 'LEARNING' ||
      upper === 'LEARNING_LIMITED' ||
      upper === 'ACTIVE' ||
      upper === 'NOT_DELIVERING'
    ) {
      return upper;
    }
    return undefined;
  }

  private mapRanking(raw?: string): AdMetricSet['qualityRanking'] {
    if (!raw) return undefined;
    const upper = raw.toUpperCase();
    if (
      upper === 'ABOVE_AVERAGE' ||
      upper === 'AVERAGE' ||
      upper === 'BELOW_AVERAGE'
    ) {
      return upper;
    }
    return undefined;
  }

  private pickFirstValue(
    arr?: Array<{ value: number | string }>,
  ): number | undefined {
    if (!arr?.length) return undefined;
    return this.toNumber(arr[0].value);
  }

  private toNumber(v: number | string | undefined): number {
    if (v === undefined || v === null) return 0;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  private safeDiv(a: number, b: number): number {
    if (b === 0) return 0;
    const r = a / b;
    return Number.isFinite(r) ? this.round4(r) : 0;
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private round4(n: number): number {
    return Math.round(n * 10000) / 10000;
  }
}
