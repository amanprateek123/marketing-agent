import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';
import {
  METABASE_PAGE_SIZE,
  PmMetabaseClient,
} from '../clients/pm-metabase.client';
import { CUSTOMER_PAYMENT_TYPES, pmEnv, PmEnv, PmProduct } from '../pm.config';
import {
  EarlyEvent,
  isFirst,
  istDay,
  istDayBounds,
  netRevenueOf,
  refundOf,
  RefundRow,
  toAmount,
} from '../pm.logic';
import { PmOrder } from '../schemas/pm-order.schema';

interface RawOrder {
  id: string;
  userId?: string;
  transactionId?: string;
  title?: string;
  orderTotal?: string | number;
  discount?: number;
  couponCode?: string;
  status?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  source?: string;
  currency?: string;
  createdAt: string;
}

const $date = (d: Date) => ({ $date: d.toISOString() });
const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) =>
    xs.slice(i * n, i * n + n),
  );
/** ObjectId whose timestamp is `d` — lets us range-scan a collection on its _id index. */
const objectIdAt = (d: Date) => ({
  $oid:
    Math.floor(d.getTime() / 1000)
      .toString(16)
      .padStart(8, '0') + '0000000000000000',
});
const BATCH = 200;

/**
 * Copies 91astro orders through Metabase. Queries run one at a time and one
 * IST day at a time, so production Mongo only ever sees a small, date-bounded
 * read from us.
 */
@Injectable()
export class OrdersSync {
  constructor(
    private readonly metabase: PmMetabaseClient,
    @InjectModel(PmOrder.name) private readonly model: Model<PmOrder>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  /** Upserts every order of `product` created on IST `day`. Returns rows written. */
  async syncDay(product: PmProduct, day: string): Promise<number> {
    const { start, end } = istDayBounds(day);
    let written = 0;
    let after: { at: string; id: string } | null = null;
    for (;;) {
      const page = await this.fetchOrders(product, start, end, after);
      if (!page.length) break;
      written += await this.upsert(product, page);
      const last = page[page.length - 1];
      after = { at: last.createdAt, id: last.id };
      if (page.length < METABASE_PAGE_SIZE) break;
    }
    return written;
  }

  /** Orders that got a new REFUND transaction since `since` (found via the _id index). */
  async syncNewRefunds(since: Date): Promise<number> {
    const rows = await this.metabase.aggregate<{ orderId: string }>(
      'transactions',
      [
        { $match: { _id: { $gte: objectIdAt(since) }, type: 'REFUND' } },
        { $group: { _id: '$orderId' } },
        { $project: { _id: 0, orderId: '$_id' } },
      ],
    );
    return this.applyRefunds(rows.map((r) => r.orderId).filter(Boolean));
  }

  /**
   * Re-reads refunds for confirmed orders placed on these days. Catches refunds
   * recorded only as `refundedAt` on the original payment, which the _id scan
   * above cannot see.
   */
  async recheckRefunds(days: string[]): Promise<number> {
    const known = await this.model
      .find(
        { tenantId: this.env.tenantId, confirmed: true, day: { $in: days } },
        { orderId: 1 },
      )
      .lean();
    return this.applyRefunds(known.map((o) => o.orderId));
  }

  private async applyRefunds(orderIds: string[]): Promise<number> {
    const known = await this.model
      .find(
        { tenantId: this.env.tenantId, orderId: { $in: orderIds } },
        { orderId: 1, grossAmount: 1, confirmed: 1 },
      )
      .lean();
    if (!known.length) return 0;
    const refunds = await this.refundsFor(known.map((o) => o.orderId));
    await this.model.bulkWrite(
      known.map((o) => {
        const refund = refundOf(refunds.get(o.orderId) ?? []);
        return {
          updateOne: {
            filter: { tenantId: this.env.tenantId, orderId: o.orderId },
            update: {
              $set: {
                refund,
                netRevenue: netRevenueOf(o.confirmed, o.grossAmount, refund),
              },
            },
          },
        };
      }),
      { ordered: false },
    );
    return known.length;
  }

  private fetchOrders(
    product: PmProduct,
    from: Date,
    to: Date,
    after: { at: string; id: string } | null,
  ) {
    const range = { createdAt: { $gte: $date(from), $lt: $date(to) } };
    const cursor = after
      ? {
          $or: [
            { createdAt: { $gt: $date(new Date(after.at)) } },
            { createdAt: $date(new Date(after.at)), id: { $gt: after.id } },
          ],
        }
      : {};
    return this.metabase.aggregate<RawOrder>('orders', [
      { $match: { $and: [range, product.orderMatch, cursor] } },
      { $sort: { createdAt: 1, id: 1 } },
      { $limit: METABASE_PAGE_SIZE },
      {
        $project: {
          _id: 0,
          id: 1,
          userId: 1,
          transactionId: 1,
          title: { $arrayElemAt: ['$products.title', 0] },
          orderTotal: 1,
          discount: 1,
          couponCode: 1,
          status: 1,
          paymentStatus: 1,
          paymentMethod: 1,
          source: 1,
          currency: 1,
          createdAt: 1,
        },
      },
    ]);
  }

  private async upsert(product: PmProduct, orders: RawOrder[]) {
    const ops: AnyBulkWriteOperation<PmOrder>[] = [];
    for (const batch of chunk(orders, BATCH)) {
      const confirmed = batch.filter((o) => this.isConfirmed(o));
      const userIds = [
        ...new Set(confirmed.map((o) => o.userId).filter(Boolean)),
      ] as string[];
      // One query at a time against production.
      const refunds = await this.refundsFor(batch.map((o) => o.id));
      const payments = await this.earliest(
        'transactions',
        userIds,
        {
          transactionStatus: 'PAYMENT_SUCCESS',
          type: { $in: CUSTOMER_PAYMENT_TYPES },
        },
        ['orderId', 'transactionId'],
        { $toDate: '$_id' },
      );
      const productOrders = await this.earliest(
        'orders',
        userIds,
        {
          $and: [
            product.orderMatch,
            { status: 'ORDER_CONFIRMED', paymentStatus: 'SUCCESSFUL' },
          ],
        },
        ['id', 'transactionId'],
        '$createdAt',
      );
      for (const o of batch) {
        const at = new Date(o.createdAt);
        const gross = toAmount(o.orderTotal);
        const refund = refundOf(refunds.get(o.id) ?? []);
        const isConfirmed = this.isConfirmed(o);
        const own = [o.id, o.transactionId ?? ''];
        const first = (records: Map<string, EarlyEvent[]>) =>
          isConfirmed && o.userId
            ? isFirst(records.get(o.userId) ?? [], own, at.getTime())
            : null;
        ops.push({
          updateOne: {
            filter: { tenantId: this.env.tenantId, orderId: o.id },
            update: {
              // Attribution is owned by the attribution step and never overwritten here.
              $set: {
                transactionId: o.transactionId ?? '',
                product: product.id,
                productTitle: o.title ?? '',
                userId: o.userId ?? '',
                orderedAt: at,
                day: istDay(at),
                status: o.status ?? '',
                paymentStatus: o.paymentStatus ?? '',
                confirmed: isConfirmed,
                grossAmount: gross,
                netRevenue: netRevenueOf(isConfirmed, gross, refund),
                discount: toAmount(o.discount),
                couponCode: o.couponCode ?? '',
                paymentMethod: o.paymentMethod ?? '',
                adminCreated: o.paymentMethod === 'ADMIN_CREATED',
                currency: o.currency ?? '',
                source: o.source ?? '',
                refund,
                newToBusiness: first(payments),
                newToProduct: first(productOrders),
              },
            },
            upsert: true,
          },
        });
      }
    }
    if (ops.length) await this.model.bulkWrite(ops, { ordered: false });
    return ops.length;
  }

  private isConfirmed(o: RawOrder) {
    return o.status === 'ORDER_CONFIRMED' && o.paymentStatus === 'SUCCESSFUL';
  }

  private async refundsFor(orderIds: string[]) {
    const byOrder = new Map<string, RefundRow[]>();
    for (const ids of chunk(orderIds, BATCH)) {
      const rows = await this.metabase.aggregate<
        RefundRow & { orderId: string }
      >('transactions', [
        {
          $match: {
            orderId: { $in: ids },
            $or: [{ type: 'REFUND' }, { refundedAt: { $exists: true } }],
          },
        },
        {
          $project: {
            _id: 0,
            orderId: 1,
            type: 1,
            transactionStatus: 1,
            amount: 1,
            refundedAt: 1,
            refundStatus: '$refundInfo.refundStatus',
          },
        },
      ]);
      for (const r of rows)
        byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
    }
    return byOrder;
  }

  /**
   * Each user's two earliest qualifying records (two, so that excluding the
   * order's own record still leaves the earliest other one). A record carries
   * every id it can be known by, so the order's own payment is always excluded.
   */
  private async earliest(
    collection: 'orders' | 'transactions',
    userIds: string[],
    match: Record<string, unknown>,
    idFields: string[],
    at: unknown,
  ) {
    const byUser = new Map<string, EarlyEvent[]>();
    if (!userIds.length) return byUser;
    const ids = idFields.map((f) => ({ $ifNull: [`$${f}`, ''] }));
    const rows = await this.metabase.aggregate<{
      userId: string;
      first: { ids: string[]; at: string }[];
    }>(collection, [
      { $match: { $and: [{ userId: { $in: userIds } }, match] } },
      { $project: { _id: 0, userId: 1, ids, at } },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: '$userId',
          first: { $firstN: { n: 2, input: { ids: '$ids', at: '$at' } } },
        },
      },
      { $project: { _id: 0, userId: '$_id', first: 1 } },
    ]);
    for (const r of rows)
      byUser.set(
        r.userId,
        r.first.map((e) => ({ ids: e.ids, at: new Date(e.at).getTime() })),
      );
    return byUser;
  }
}
