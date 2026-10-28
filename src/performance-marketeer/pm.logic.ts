/**
 * Pure calculations for the Performance Marketeer data layer. No I/O here, so
 * every rule is unit-tested in pm.logic.spec.ts. Definitions follow
 * docs/performance-marketeer/07-definitions.md.
 */
import {
  ATTRIBUTION_WINDOW_DAYS,
  DAY_MS,
  GST_RATE,
  IST_OFFSET_MS,
} from './pm.config';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** IST calendar day (YYYY-MM-DD) of an instant. */
export const istDay = (at: Date | number) =>
  new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** IST day `offset` days from today. */
export const istDayFromToday = (offset = 0) =>
  istDay(Date.now() + offset * DAY_MS);

/** UTC instants bounding an IST day: [start, end). */
export const istDayBounds = (day: string) => {
  const start = Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
};

export const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** Every IST day from..to inclusive. Throws on bad input or ranges over maxDays. */
export function dayRange(from: string, to: string, maxDays = 200): string[] {
  if (!DAY_RE.test(from ?? '') || !DAY_RE.test(to ?? '') || from > to) {
    throw new Error('from and to must be YYYY-MM-DD, from on or before to');
  }
  const days: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) {
    days.push(d);
    if (days.length > maxDays)
      throw new Error(`Pick a range of ${maxDays} days or less`);
  }
  return days;
}

/** Money as stored in 91astro (orderTotal is a string, GST-inclusive). */
export const toAmount = (v: unknown): number => {
  const n =
    typeof v === 'number'
      ? v
      : parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Definition 2: revenue ex-GST, rounded to paise. */
export const netOfGst = (gross: number) =>
  Math.round((gross / (1 + GST_RATE)) * 100) / 100;

/** Landing-page locale from its path: /hi/nadi-report → 'hi', /nadi-report → 'en'. */
export const localeOf = (path: string) =>
  /^\/([a-z]{2})\//.exec(path ?? '')?.[1] ?? 'en';

export type Channel =
  | 'meta_ad'
  | 'meta_other'
  | 'google_ads'
  | 'google_organic'
  | 'quora'
  | 'chatgpt'
  | 'other_utm'
  | 'referral'
  | 'direct';

export interface TrafficRaw {
  utmSource: string;
  utmMedium: string;
  utmContent: string;
  referrerName: string;
  hasFbclid: boolean;
  hasGoogleClickId: boolean;
  metaAdCount: number;
}

/**
 * Where a visitor-day came from. Raw fields are stored too, so the agent can
 * re-bucket; this is only the default view. Note `utm_source=social` is used
 * for Quora and ChatGPT ads (utm_medium tells them apart), not for Meta.
 */
export function classifyChannel(t: TrafficRaw): Channel {
  const src = t.utmSource.toLowerCase();
  const med = t.utmMedium.toLowerCase();
  const ref = t.referrerName.toLowerCase();
  if (t.metaAdCount > 0) return 'meta_ad';
  if (med === 'quora' || src === 'quora' || ref === 'quora') return 'quora';
  if (med === 'chatgpt' || src === 'chatgpt' || ref.includes('chatgpt'))
    return 'chatgpt';
  if (
    t.hasFbclid ||
    ['fb', 'facebook', 'ig', 'instagram', 'meta'].includes(src) ||
    ['fb', 'facebook', 'ig', 'instagram'].includes(med) ||
    ['facebook', 'instagram'].includes(ref)
  ) {
    return 'meta_other';
  }
  if (t.hasGoogleClickId || src.startsWith('google')) return 'google_ads';
  if (ref === 'google') return 'google_organic';
  if (src) return 'other_utm';
  if (ref) return 'referral';
  return 'direct';
}

export interface MetaTouch {
  at: number; // epoch ms
  adId: string;
  adsetId: string;
  campaignId: string;
}

/**
 * Definition 4: last (and first) Meta ad click within the window before the
 * order, across all of the buyer's matched devices.
 */
export function pickMetaClicks(
  touches: MetaTouch[],
  orderAt: number,
  windowDays = ATTRIBUTION_WINDOW_DAYS,
) {
  const from = orderAt - windowDays * DAY_MS;
  const inWindow = touches
    .filter((t) => t.at >= from && t.at <= orderAt)
    .sort((a, b) => a.at - b.at);
  return {
    first: inWindow[0] ?? null,
    last: inWindow[inWindow.length - 1] ?? null,
    distinctAds: new Set(inWindow.map((t) => t.adId)).size,
  };
}

export interface EarlyEvent {
  /** Every id this record can be known by (e.g. a payment's orderId and transactionId). */
  ids: string[];
  at: number; // epoch ms
}

/**
 * Definition 5. `earliest` = the user's earliest qualifying records (at least
 * the first two, so excluding the order's own record still leaves one).
 * New = no other qualifying record before this order. Throws on an unreadable
 * date rather than silently calling every buyer "returning".
 */
export function isFirst(
  earliest: EarlyEvent[],
  ownIds: string[],
  orderAt: number,
): boolean {
  if (earliest.some((e) => Number.isNaN(e.at)) || Number.isNaN(orderAt)) {
    throw new Error('isFirst: unreadable date');
  }
  const own = new Set(ownIds.filter(Boolean));
  const prior = earliest
    .filter((e) => !e.ids.some((id) => own.has(id)))
    .sort((a, b) => a.at - b.at)[0];
  return !prior || prior.at >= orderAt;
}

export interface RefundRow {
  type?: string;
  transactionStatus?: string;
  amount?: number;
  refundedAt?: string | Date | null;
  refundStatus?: string | null;
}

export type RefundState = 'none' | 'pending' | 'refunded';

const FAILED = /FAIL|CANCEL|REJECT|ERROR/i;

/**
 * Refund for one order. Refunded = a completed REFUND row, or `refundedAt` on
 * the original payment (set when the refund is issued). Pending = a REFUND row
 * still in flight. Failed / cancelled refund rows are ignored.
 */
export function refundOf(rows: RefundRow[]) {
  const refundRows = rows.filter(
    (r) =>
      r.type === 'REFUND' &&
      !FAILED.test(r.transactionStatus ?? '') &&
      !FAILED.test(r.refundStatus ?? ''),
  );
  const done = refundRows.filter(
    (r) =>
      r.transactionStatus === 'PAYMENT_SUCCESS' ||
      (r.refundStatus ?? '').toUpperCase() === 'SUCCESS',
  );
  const original = rows.find((r) => r.type !== 'REFUND' && r.refundedAt);
  const state: RefundState =
    done.length || original
      ? 'refunded'
      : refundRows.length
        ? 'pending'
        : 'none';
  const dates = [...refundRows.map((r) => r.refundedAt), original?.refundedAt]
    .filter(Boolean)
    .map((d) => new Date(d as string));
  return {
    state,
    // Amount of the refund rows (completed first); 0 = unknown, treat as full.
    amount: (done.length ? done : refundRows).reduce(
      (s, r) => s + toAmount(r.amount),
      0,
    ),
    at: dates.length
      ? new Date(Math.min(...dates.map((d) => d.getTime())))
      : null,
  };
}

/** Definition 2: ex-GST for confirmed orders, minus a completed refund; 0 otherwise. */
export function netRevenueOf(
  confirmed: boolean,
  gross: number,
  refund: { state: string; amount: number },
) {
  if (!confirmed) return 0;
  const net = netOfGst(gross);
  return refund.state === 'refunded'
    ? Math.max(0, net - netOfGst(refund.amount || gross))
    : net;
}

/**
 * Nearest unlinked payment event to an order, inside the window an order's
 * payment event fires in (same rule as astro_be product-insights).
 */
export function nearestPayment<T extends { at: number }>(
  payments: T[],
  orderAt: number,
  beforeMs = 30_000,
  afterMs = 180_000,
): T | null {
  let hit: T | null = null;
  for (const p of payments) {
    const d = p.at - orderAt;
    if (d < -beforeMs || d > afterMs) continue;
    if (!hit || Math.abs(d) < Math.abs(hit.at - orderAt)) hit = p;
  }
  return hit;
}
