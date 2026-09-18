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
  SnapshotAdEntity,
  SnapshotAdSetEntity,
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
      entities: this.buildEntities(input.bundle),
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
    const base = this.baseMetrics(raw.insights, raw.metricProvenance);
    base.revenue = this.computeRevenue(
      raw.insights,
      products,
      raw.metricProvenance,
    );
    base.cvr = this.safeDiv(base.purchases, base.clicks);
    base.aov = this.safeDiv(base.revenue, base.purchases);
    base.roas = this.safeDiv(base.revenue, base.spend);
    return base;
  }

  private normalizeAdSet(
    raw: RawMetaAdSet,
    products: ProductForRevenue[],
  ): MetricSet {
    const base = this.baseMetrics(raw.insights, raw.metricProvenance);
    base.revenue = this.computeRevenue(
      raw.insights,
      products,
      raw.metricProvenance,
    );
    base.cvr = this.safeDiv(base.purchases, base.clicks);
    base.aov = this.safeDiv(base.revenue, base.purchases);
    base.roas = this.safeDiv(base.revenue, base.spend);
    this.assignOptionalMetric(base, 'landingPageViews', raw.landingPageViews);
    this.assignOptionalMetric(base, 'inlineLinkClicks', raw.inlineLinkClicks);
    this.assignOptionalMetric(base, 'thruplay', raw.thruplay);
    return base;
  }

  private normalizeAd(
    raw: RawMetaAd,
    products: ProductForRevenue[],
  ): AdMetricSet {
    const base = this.baseMetrics(raw.insights, raw.metricProvenance);
    base.revenue = this.computeRevenue(
      raw.insights,
      products,
      raw.metricProvenance,
    );
    base.cvr = this.safeDiv(base.purchases, base.clicks);
    base.aov = this.safeDiv(base.revenue, base.purchases);
    base.roas = this.safeDiv(base.revenue, base.spend);
    this.assignOptionalMetric(base, 'landingPageViews', raw.landingPageViews);
    this.assignOptionalMetric(base, 'inlineLinkClicks', raw.inlineLinkClicks);
    this.assignOptionalMetric(base, 'outboundClicks', raw.outboundClicks);
    this.assignOptionalMetric(base, 'video3s', raw.video3s);
    this.assignOptionalMetric(base, 'thruplay', raw.thruplay);
    const last7d = raw.last7d
      ? this.normalizePartialWindow(
          raw.last7d,
          products,
          raw.last7dMetricProvenance,
        )
      : undefined;
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
      last7d: last7d && Object.keys(last7d).length > 0 ? last7d : undefined,
    };
  }

  private baseMetrics(
    insights?: RawMetaCampaign['insights'],
    provenance?: MetricSet['provenance'],
  ): MetricSet {
    const canonicalConversions = this.numberOrUndefined(
      provenance?.canonicalConversions,
    );
    const metrics: MetricSet = {
      spend: this.toNumber(insights?.spend),
      revenue: 0, // filled by computeRevenue
      impressions: this.toNumber(insights?.impressions),
      reach: this.toNumber(insights?.reach),
      clicks: this.toNumber(insights?.clicks),
      ctr: this.toNumber(insights?.ctr),
      cpc: this.toNumber(insights?.cpc),
      cpm: this.toNumber(insights?.cpm),
      cvr: 0,
      purchases:
        canonicalConversions ?? this.actionValue(insights?.actions, 'purchase'),
      addToCart: this.actionValue(insights?.actions, 'add_to_cart'),
      initiateCheckout: this.actionValue(
        insights?.actions,
        'initiate_checkout',
      ),
      roas: 0,
      aov: 0,
      frequency: this.toNumber(insights?.frequency),
      ...(provenance ? { provenance: this.copyProvenance(provenance) } : {}),
    };
    const landingPageViews = this.actionValueOptional(
      insights?.actions,
      'landing_page_view',
    );
    if (landingPageViews !== undefined) {
      metrics.landingPageViews = landingPageViews;
    }
    return metrics;
  }

  /**
   * A comparison window is intentionally partial: only values present in the
   * source row are emitted. This prevents a missing 7-day metric from being
   * presented to later engines as an observed zero.
   */
  private normalizePartialWindow(
    insights: RawMetaCampaign['insights'],
    products: ProductForRevenue[],
    provenance?: MetricSet['provenance'],
  ): Partial<MetricSet> {
    const metrics: Partial<MetricSet> = provenance
      ? { provenance: this.copyProvenance(provenance) }
      : {};
    this.assignRawNumber(metrics, 'spend', insights?.spend);
    this.assignRawNumber(metrics, 'impressions', insights?.impressions);
    this.assignRawNumber(metrics, 'reach', insights?.reach);
    this.assignRawNumber(metrics, 'clicks', insights?.clicks);
    this.assignRawNumber(metrics, 'ctr', insights?.ctr);
    this.assignRawNumber(metrics, 'cpc', insights?.cpc);
    this.assignRawNumber(metrics, 'cpm', insights?.cpm);
    this.assignRawNumber(metrics, 'frequency', insights?.frequency);

    const purchases =
      this.numberOrUndefined(provenance?.canonicalConversions) ??
      this.actionValueOptional(insights?.actions, 'purchase');
    const addToCart = this.actionValueOptional(
      insights?.actions,
      'add_to_cart',
    );
    const initiateCheckout = this.actionValueOptional(
      insights?.actions,
      'initiate_checkout',
    );
    const landingPageViews = this.actionValueOptional(
      insights?.actions,
      'landing_page_view',
    );
    if (purchases !== undefined) metrics.purchases = purchases;
    if (addToCart !== undefined) metrics.addToCart = addToCart;
    if (initiateCheckout !== undefined) {
      metrics.initiateCheckout = initiateCheckout;
    }
    if (landingPageViews !== undefined) {
      metrics.landingPageViews = landingPageViews;
    }

    const revenue = this.computeRevenueOptional(insights, products, provenance);
    if (revenue !== undefined) metrics.revenue = revenue;
    if (purchases !== undefined && metrics.clicks !== undefined) {
      metrics.cvr = this.safeDiv(purchases, metrics.clicks);
    }
    if (revenue !== undefined && purchases !== undefined) {
      metrics.aov = this.safeDiv(revenue, purchases);
    }
    if (revenue !== undefined && metrics.spend !== undefined) {
      metrics.roas = this.safeDiv(revenue, metrics.spend);
    }
    return metrics;
  }

  private buildEntities(
    bundle: RawMetaBundle,
  ): NonNullable<SnapshotData['entities']> {
    const campaign = bundle.campaign;
    const adSets: Record<string, SnapshotAdSetEntity> = {};
    for (const [key, raw] of Object.entries(bundle.adSets ?? {})) {
      adSets[key] = {
        id: this.cleanText(raw.id) ?? key,
        name: this.cleanText(raw.name) ?? '',
        status: this.cleanText(raw.status),
        effectiveStatus: this.cleanText(raw.effectiveStatus),
        audienceType: this.cleanText(raw.audienceType),
        optimizationGoal: this.cleanText(raw.optimizationGoal),
      };
    }

    const ads: Record<string, SnapshotAdEntity> = {};
    for (const [key, raw] of Object.entries(bundle.ads ?? {})) {
      const creative: NonNullable<SnapshotAdEntity['creative']> = {
        id: this.cleanText(raw.creativeId),
        name: this.cleanText(raw.creativeName),
        body: this.cleanText(raw.creativeBody),
        title: this.cleanText(raw.creativeTitle),
        cta: this.cleanText(raw.creativeCta),
        linkUrl: this.cleanText(raw.creativeLinkUrl),
        videoId: this.cleanText(raw.creativeVideoId),
        imageHash: this.cleanText(raw.creativeImageHash),
        thumbnailUrl: this.cleanText(raw.thumbnailUrl),
        isDynamic: raw.isDynamicCreative,
      };
      const hasCreativeEvidence = Object.values(creative).some(
        (value) => value !== undefined,
      );
      ads[key] = {
        id: this.cleanText(raw.id) ?? key,
        adSetId: this.cleanText(raw.adSetId),
        name: this.cleanText(raw.name) ?? '',
        status: this.cleanText(raw.status),
        effectiveStatus: this.cleanText(raw.effectiveStatus),
        creative: hasCreativeEvidence ? creative : undefined,
      };
    }

    return {
      campaign: {
        id: this.cleanText(campaign.id) ?? '',
        name: this.cleanText(campaign.name) ?? '',
        productName: this.cleanText(campaign.productName),
        objective: this.cleanText(campaign.objective),
        budgetModel: campaign.budgetModel,
        status: this.cleanText(campaign.status),
        effectiveStatus: this.cleanText(campaign.effective_status),
      },
      adSets,
      ads,
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
    provenance?: MetricSet['provenance'],
  ): number {
    const canonicalRevenueNet = this.numberOrUndefined(
      provenance?.canonicalRevenueNet,
    );
    if (canonicalRevenueNet !== undefined) {
      return this.round2(canonicalRevenueNet);
    }
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

  private computeRevenueOptional(
    insights: RawMetaCampaign['insights'],
    products: ProductForRevenue[],
    provenance?: MetricSet['provenance'],
  ): number | undefined {
    const canonicalRevenueNet = this.numberOrUndefined(
      provenance?.canonicalRevenueNet,
    );
    if (canonicalRevenueNet !== undefined) {
      return this.round2(canonicalRevenueNet);
    }
    const rawRevenue = this.actionValueOptional(
      insights?.action_values,
      'purchase',
    );
    const product = products[0];
    const refundHaircut = product?.refundRatePercent
      ? Math.max(0, 1 - product.refundRatePercent / 100)
      : 1;
    // Unlike the lifetime canonical row, a comparison window must not fill a
    // missing Meta action_value from configured product price: that would turn
    // an unknown observed return into estimated evidence without provenance.
    return rawRevenue === undefined
      ? undefined
      : this.round2(rawRevenue * refundHaircut);
  }

  private actionValue(
    actions: Array<{ action_type: string; value: number | string }> | undefined,
    kind: string,
  ): number {
    if (!actions?.length) return 0;
    const hit = actions.find((a) => a.action_type === kind);
    return hit ? this.toNumber(hit.value) : 0;
  }

  private actionValueOptional(
    actions: Array<{ action_type: string; value: number | string }> | undefined,
    kind: string,
  ): number | undefined {
    const hit = actions?.find((action) => action.action_type === kind);
    if (!hit) return undefined;
    return this.numberOrUndefined(hit.value);
  }

  private assignOptionalMetric<K extends keyof MetricSet>(
    metrics: MetricSet,
    key: K,
    value: number | undefined,
  ): void {
    if (this.numberOrUndefined(value) !== undefined) {
      metrics[key] = value as MetricSet[K];
    }
  }

  private assignRawNumber<K extends keyof MetricSet>(
    metrics: Partial<MetricSet>,
    key: K,
    value: number | string | undefined,
  ): void {
    const parsed = this.numberOrUndefined(value);
    if (parsed !== undefined) metrics[key] = parsed as MetricSet[K];
  }

  private cleanText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private copyProvenance(
    provenance: NonNullable<MetricSet['provenance']>,
  ): NonNullable<MetricSet['provenance']> {
    return {
      ...provenance,
      metricsSyncedAt: provenance.metricsSyncedAt
        ? new Date(provenance.metricsSyncedAt)
        : undefined,
      metricsLastAttemptedAt: provenance.metricsLastAttemptedAt
        ? new Date(provenance.metricsLastAttemptedAt)
        : undefined,
      revenueAttributionActionTypes: provenance.revenueAttributionActionTypes
        ? [...provenance.revenueAttributionActionTypes]
        : undefined,
      goalResultInputs: provenance.goalResultInputs
        ? {
            actionCounts: provenance.goalResultInputs.actionCounts
              ? { ...provenance.goalResultInputs.actionCounts }
              : undefined,
            actionValuesGross: provenance.goalResultInputs.actionValuesGross
              ? { ...provenance.goalResultInputs.actionValuesGross }
              : undefined,
          }
        : undefined,
    };
  }

  private detectMissingFields(
    campaign: MetricSet,
    adSets: Record<string, MetricSet>,
  ): string[] {
    const missing: string[] = [];
    if (campaign.provenance?.rowObserved === false) {
      missing.push('campaign_metrics_row');
    }
    if (campaign.spend === 0 && campaign.impressions === 0)
      missing.push('spend');
    if (campaign.impressions === 0) missing.push('impressions');
    if (campaign.frequency === 0 && campaign.impressions > 0)
      missing.push('frequency');
    if (Object.keys(adSets).length === 0) missing.push('ad_set_breakdown');
    for (const [adSetId, metrics] of Object.entries(adSets)) {
      if (metrics.provenance?.rowObserved === false) {
        missing.push(`ad_set_metrics_row:${adSetId}`);
      }
    }
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

  private numberOrUndefined(
    value: number | string | undefined,
  ): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
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
