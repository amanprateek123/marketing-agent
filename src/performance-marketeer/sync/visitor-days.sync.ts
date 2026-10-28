import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PmClickhouseClient } from '../clients/pm-clickhouse.client';
import { META_AD_ID_RE, pmEnv, PmEnv, PmProduct } from '../pm.config';
import { classifyChannel, localeOf } from '../pm.logic';
import { PmVisitorDay } from '../schemas/pm-visitor-day.schema';

/**
 * One row per device for one product and one IST day. Extends astro_be's
 * product-insights query with traffic source, Meta ad ids, device/OS/browser,
 * cart engagement and every funnel step. `p` is the page path (page_time
 * carries it in properties.path).
 */
export function visitorDaySql(product: PmProduct) {
  const steps = product.steps
    .map((s, i) => {
      const cond =
        `name = {se${i}:String}` +
        (s.pathRe ? ` AND match(p, {sr${i}:String})` : '');
      return `countIf(${cond}) AS s${i}_n, toUnixTimestamp64Milli(minIf(created_at, ${cond})) AS s${i}_at`;
    })
    .join(',\n  ');
  const utm = (k: string) => `properties['__query.${k}']`;
  const adTuple = `tuple(${utm('utm_content')}, ${utm('utm_term')}, ${utm('utm_id')}, toUnixTimestamp64Milli(created_at))`;
  const isAd = `match(${utm('utm_content')}, {adRe:String})`;
  return `
WITH if(properties['path'] != '', properties['path'], path) AS p
SELECT
  device_id AS deviceId,
  toUnixTimestamp64Milli(min(created_at)) AS firstAt,
  toUnixTimestamp64Milli(max(created_at)) AS lastAt,
  uniqExact(session_id) AS sessions,
  countIf(name = 'screen_view' AND match(p, {landing:String})) AS landingViews,
  countIf(name = 'screen_view' AND match(p, {cart:String})) AS cartViews,
  argMinIf(p, created_at, name = 'screen_view' AND match(p, {landing:String})) AS landingPath,
  maxIf(toUInt8OrZero(properties['percent']), name = 'scroll_depth' AND match(p, {landing:String})) AS maxScroll,
  maxIf(toFloat64OrZero(properties['active_seconds']), name = 'page_time' AND match(p, {landing:String})) AS activeSecondsLanding,
  maxIf(toFloat64OrZero(properties['active_seconds']), name = 'page_time' AND match(p, {cart:String})) AS activeSecondsCart,
  anyIf(city, city != '') AS city,
  anyIf(region, region != '') AS region,
  anyIf(country, country != '') AS country,
  anyIf(device, device != '' AND sdk_name != 'node') AS device,
  anyIf(os, os != '' AND sdk_name != 'node') AS os,
  anyIf(browser, browser != '' AND sdk_name != 'node') AS browser,
  argMinIf(tuple(referrer, referrer_name, referrer_type), created_at, sdk_name != 'node') AS ref,
  argMinIf(tuple(${utm('utm_source')}, ${utm('utm_medium')}, ${utm('utm_campaign')}, ${utm('utm_content')}, ${utm('utm_term')}, ${utm('utm_id')}),
           created_at, ${utm('utm_source')} != '' OR ${utm('utm_content')} != '') AS utm,
  max(${utm('fbclid')} != '') AS hasFbclid,
  max(${utm('gclid')} != '' OR ${utm('gbraid')} != '' OR ${utm('wbraid')} != '' OR ${utm('gad_source')} != '') AS hasGoogleClickId,
  argMinIf(${adTuple}, created_at, ${isAd}) AS firstAd,
  argMaxIf(${adTuple}, created_at, ${isAd}) AS lastAd,
  uniqExactIf(${utm('utm_content')}, ${isAd}) AS metaAdCount,
  ${steps},
  groupArrayIf((toUnixTimestamp64Milli(created_at), properties['order_id']), name = {payment:String}) AS payments,
  groupArrayIf((toUnixTimestamp64Milli(created_at), properties['order_id']), name = {purchase:String}) AS purchases
FROM openpanel.events
WHERE project_id = {project:String}
  AND device_id != ''
  AND created_at >= toDateTime64({day:String} || ' 00:00:00', 3, 'Asia/Kolkata')
  AND created_at < toDateTime64({day:String} || ' 00:00:00', 3, 'Asia/Kolkata') + INTERVAL 1 DAY
  AND (match(p, {landing:String}) OR match(p, {cart:String}) OR name IN {events:Array(String)})
GROUP BY device_id
HAVING landingViews > 0 OR cartViews > 0 OR length(payments) > 0 OR length(purchases) > 0`;
}

export function visitorDayParams(
  product: PmProduct,
  day: string,
  project: string,
) {
  const params: Record<string, unknown> = {
    project,
    day,
    landing: product.landingRe,
    cart: product.cartRe,
    adRe: META_AD_ID_RE,
    payment: product.paymentEvent,
    // '' never matches an event name, so products without a usable server event skip it.
    purchase: product.purchaseEvent ?? '',
    events: [
      ...new Set(
        [
          ...product.steps.map((s) => s.event),
          product.paymentEvent,
          product.purchaseEvent,
        ].filter(Boolean),
      ),
    ],
  };
  product.steps.forEach((s, i) => {
    params[`se${i}`] = s.event;
    if (s.pathRe) params[`sr${i}`] = s.pathRe;
  });
  return params;
}

type Row = Record<string, any>;
// Tuples arrive as JSON arrays; tolerate named tuples (objects) too.
const tuple = (v: unknown): any[] =>
  Array.isArray(v) ? v : Object.values((v as object) ?? {});
const ms = (v: unknown) => new Date(Number(v));
const adClick = ([adId, adsetId, campaignId, at]: [
  string,
  string,
  string,
  number,
]) => ({ adId, adsetId, campaignId, at: ms(at) });

/** ClickHouse row → pm_visitor_days document. Exported for tests. */
export function toVisitorDay(
  r: Row,
  product: PmProduct,
  day: string,
  tenantId: string,
): PmVisitorDay {
  const [utmSource, utmMedium, utmCampaign, utmContent, utmTerm, utmId] = tuple(
    r.utm,
  ) as string[];
  const [referrer, referrerName, referrerType] = tuple(r.ref) as string[];
  const metaAdCount = Number(r.metaAdCount) || 0;
  const hasFbclid = Boolean(Number(r.hasFbclid));
  const hasGoogleClickId = Boolean(Number(r.hasGoogleClickId));
  const steps: PmVisitorDay['steps'] = {};
  product.steps.forEach((s, i) => {
    const count = Number(r[`s${i}_n`]) || 0;
    steps[s.key] = { count, firstAt: count ? ms(r[`s${i}_at`]) : null };
  });
  return {
    tenantId,
    product: product.id,
    day,
    deviceId: r.deviceId,
    firstAt: ms(r.firstAt),
    lastAt: ms(r.lastAt),
    sessions: Number(r.sessions) || 0,
    landingViews: Number(r.landingViews) || 0,
    cartViews: Number(r.cartViews) || 0,
    landingPath: r.landingPath || '',
    locale: localeOf(r.landingPath),
    maxScroll: Number(r.maxScroll) || 0,
    activeSecondsLanding: Number(r.activeSecondsLanding) || 0,
    activeSecondsCart: Number(r.activeSecondsCart) || 0,
    geo: {
      city: r.city || undefined,
      region: r.region || undefined,
      country: r.country || undefined,
    },
    tech: {
      device: r.device || undefined,
      os: r.os || undefined,
      browser: r.browser || undefined,
    },
    traffic: {
      channel: classifyChannel({
        utmSource,
        utmMedium,
        utmContent,
        referrerName,
        hasFbclid,
        hasGoogleClickId,
        metaAdCount,
      }),
      referrer: referrer || undefined,
      referrerName: referrerName || undefined,
      referrerType: referrerType || undefined,
      utmSource: utmSource || undefined,
      utmMedium: utmMedium || undefined,
      utmCampaign: utmCampaign || undefined,
      utmContent: utmContent || undefined,
      utmTerm: utmTerm || undefined,
      utmId: utmId || undefined,
      hasFbclid,
      hasGoogleClickId,
    },
    metaAd: metaAdCount
      ? {
          first: adClick(tuple(r.firstAd) as any),
          last: adClick(tuple(r.lastAd) as any),
          distinctAds: metaAdCount,
        }
      : null,
    steps,
    payments: (r.payments as [number, string][]).map(([at, ref]) => ({
      at: ms(at),
      ref: ref || '',
    })),
    purchases: (r.purchases as [number, string][]).map(([at, orderId]) => ({
      at: ms(at),
      orderId: orderId || '',
    })),
  };
}

@Injectable()
export class VisitorDaysSync {
  constructor(
    private readonly clickhouse: PmClickhouseClient,
    @InjectModel(PmVisitorDay.name) private readonly model: Model<PmVisitorDay>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  /** Replaces one product-day, so any day can be re-synced safely. Returns rows written. */
  async syncDay(product: PmProduct, day: string): Promise<number> {
    const rows = await this.clickhouse.query<Row>(
      visitorDaySql(product),
      visitorDayParams(product, day, this.clickhouse.project),
    );
    const docs = rows.map((r) =>
      toVisitorDay(r, product, day, this.env.tenantId),
    );
    await this.model.deleteMany({
      tenantId: this.env.tenantId,
      product: product.id,
      day,
    });
    if (docs.length) await this.model.insertMany(docs, { ordered: false });
    return docs.length;
  }
}
