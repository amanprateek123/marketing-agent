import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';
import { PmClickhouseClient } from '../clients/pm-clickhouse.client';
import {
  ATTRIBUTION_WINDOW_DAYS,
  DAY_MS,
  META_AD_ID_RE,
  pmEnv,
  PmEnv,
} from '../pm.config';
import { MetaTouch, nearestPayment, pickMetaClicks } from '../pm.logic';
import { PmOrder } from '../schemas/pm-order.schema';
import { PmVisitorDay } from '../schemas/pm-visitor-day.schema';

/**
 * One row per (device, session, ad): the Meta ad clicks those devices made in
 * the window. An ad click lands as a page view carrying the ad ids in its URL
 * (session_start too, when it opens a new session); other events are skipped.
 * Bounded by an explicit device list and time range so it stays inside
 * insights_reader's limits.
 */
const META_TOUCHES_SQL = `
SELECT
  device_id AS deviceId,
  toUnixTimestamp64Milli(min(created_at)) AS at,
  properties['__query.utm_content'] AS adId,
  properties['__query.utm_term'] AS adsetId,
  properties['__query.utm_id'] AS campaignId
FROM openpanel.events
WHERE project_id = {project:String}
  AND device_id IN {devices:Array(String)}
  AND device_id != ''
  AND created_at >= fromUnixTimestamp64Milli({from:Int64})
  AND created_at <= fromUnixTimestamp64Milli({to:Int64})
  AND name IN ('session_start', 'screen_view')
  AND match(properties['__query.utm_content'], {adRe:String})
GROUP BY device_id, session_id, adId, adsetId, campaignId`;

const DEVICE_BATCH = 300;
const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) =>
    xs.slice(i * n, i * n + n),
  );

type OrderLite = Pick<
  PmOrder,
  'orderId' | 'transactionId' | 'product' | 'orderedAt' | 'day'
>;
type VisitorLite = Pick<
  PmVisitorDay,
  'deviceId' | 'product' | 'payments' | 'purchases'
>;

@Injectable()
export class AttributionSync {
  constructor(
    private readonly clickhouse: PmClickhouseClient,
    @InjectModel(PmOrder.name) private readonly orders: Model<PmOrder>,
    @InjectModel(PmVisitorDay.name)
    private readonly visitors: Model<PmVisitorDay>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  /** (Re)computes attribution for orders placed on IST days from..to. Returns orders written. */
  async attributeDays(
    days: string[],
  ): Promise<{ orders: number; withDevice: number; withMetaClick: number }> {
    const tenantId = this.env.tenantId;
    const orders: OrderLite[] = await this.orders
      .find(
        { tenantId, day: { $in: days } },
        { orderId: 1, transactionId: 1, product: 1, orderedAt: 1, day: 1 },
      )
      .lean();
    if (!orders.length) return { orders: 0, withDevice: 0, withMetaClick: 0 };

    // Visitor rows on the order day or the day before (late-night checkouts).
    const dayBefore = (d: string) =>
      new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS)
        .toISOString()
        .slice(0, 10);
    const visitorDays = [
      ...new Set(orders.flatMap((o) => [o.day, dayBefore(o.day)])),
    ];
    const visitors: VisitorLite[] = await this.visitors
      .find(
        {
          tenantId,
          day: { $in: visitorDays },
          $or: [
            { 'payments.0': { $exists: true } },
            { 'purchases.0': { $exists: true } },
          ],
        },
        { deviceId: 1, product: 1, payments: 1, purchases: 1 },
      )
      .lean();

    const byRef = new Map<string, Set<string>>();
    const add = (ref: string, deviceId: string) => {
      if (!ref) return;
      if (!byRef.has(ref)) byRef.set(ref, new Set());
      byRef.get(ref)!.add(deviceId);
    };
    const unlinked: { at: number; deviceId: string; product: string }[] = [];
    for (const v of visitors) {
      if (!v.deviceId) continue; // never link through an unknown device
      for (const p of v.payments) {
        add(p.ref, v.deviceId);
        if (!p.ref)
          unlinked.push({
            at: new Date(p.at).getTime(),
            deviceId: v.deviceId,
            product: v.product,
          });
      }
      for (const p of v.purchases) add(p.orderId, v.deviceId);
    }

    const linked = orders.map((o) => {
      const devices = new Set([
        ...(byRef.get(o.orderId) ?? []),
        ...(byRef.get(o.transactionId) ?? []),
      ]);
      let matchedBy: 'order_ref' | 'time_window' | 'none' = devices.size
        ? 'order_ref'
        : 'none';
      if (!devices.size) {
        // Older payment events carried no order reference: fall back to timing.
        const hit = nearestPayment(
          unlinked.filter((u) => u.product === o.product),
          new Date(o.orderedAt).getTime(),
        );
        if (hit) {
          unlinked.splice(unlinked.indexOf(hit), 1); // each payment event links one order
          devices.add(hit.deviceId);
          matchedBy = 'time_window';
        }
      }
      return { order: o, deviceIds: [...devices], matchedBy };
    });

    const touches = await this.metaTouches(linked);
    const now = new Date();
    let withMetaClick = 0;
    const ops: AnyBulkWriteOperation<PmOrder>[] = linked.map(
      ({ order, deviceIds, matchedBy }) => {
        const picked = pickMetaClicks(
          deviceIds.flatMap((d) => touches.get(d) ?? []),
          new Date(order.orderedAt).getTime(),
        );
        if (picked.last) withMetaClick += 1;
        const click = (t: MetaTouch | null) =>
          t
            ? {
                adId: t.adId,
                adsetId: t.adsetId,
                campaignId: t.campaignId,
                at: new Date(t.at),
              }
            : null;
        return {
          updateOne: {
            filter: { tenantId, orderId: order.orderId },
            update: {
              $set: {
                attribution: {
                  deviceIds,
                  matchedBy,
                  metaLast: click(picked.last),
                  metaFirst: click(picked.first),
                  metaDistinctAds: picked.distinctAds,
                  method: 'first_party_device_7d_click',
                  computedAt: now,
                },
              },
            },
          },
        };
      },
    );
    await this.orders.bulkWrite(ops, { ordered: false });
    return {
      orders: ops.length,
      withDevice: linked.filter((l) => l.deviceIds.length).length,
      withMetaClick,
    };
  }

  /** Meta ad touches per device, over the window before the earliest to the latest order. */
  private async metaTouches(
    linked: { order: OrderLite; deviceIds: string[] }[],
  ) {
    const byDevice = new Map<string, MetaTouch[]>();
    const withDevices = linked.filter((l) => l.deviceIds.length);
    if (!withDevices.length) return byDevice;
    const times = withDevices.map((l) => new Date(l.order.orderedAt).getTime());
    const from = Math.min(...times) - ATTRIBUTION_WINDOW_DAYS * DAY_MS;
    const to = Math.max(...times);
    const devices = [...new Set(withDevices.flatMap((l) => l.deviceIds))];
    for (const batch of chunk(devices, DEVICE_BATCH)) {
      const rows = await this.clickhouse.query<{
        deviceId: string;
        at: string;
        adId: string;
        adsetId: string;
        campaignId: string;
      }>(META_TOUCHES_SQL, {
        project: this.clickhouse.project,
        devices: batch,
        from,
        to,
        adRe: META_AD_ID_RE,
      });
      for (const r of rows) {
        const touch = {
          at: Number(r.at),
          adId: r.adId,
          adsetId: r.adsetId,
          campaignId: r.campaignId,
        };
        byDevice.set(r.deviceId, [...(byDevice.get(r.deviceId) ?? []), touch]);
      }
    }
    return byDevice;
  }
}
