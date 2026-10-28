/**
 * Pure parsing rules for Meta Marketing API responses (tested in
 * meta.logic.spec.ts). No I/O.
 */
import { PM_PRODUCTS } from '../pm.config';

type ActionList = { action_type: string; value: string }[] | undefined;

/** Meta action list → { action_type: number }. */
export const actionMap = (list: ActionList): Record<string, number> =>
  Object.fromEntries(
    (list ?? []).map((a) => [a.action_type, Number(a.value) || 0]),
  );

/**
 * Meta reports the same conversion under several names (omni_ = all
 * surfaces, then the pixel name). Take the first present, never the sum, so
 * nothing is double counted.
 */
export const pickAction = (m: Record<string, number>, names: string[]) => {
  for (const n of names) if (n in m) return m[n];
  return 0;
};

export const PURCHASE = [
  'omni_purchase',
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
];
export const ADD_TO_CART = [
  'omni_add_to_cart',
  'add_to_cart',
  'offsite_conversion.fb_pixel_add_to_cart',
];
export const INITIATE_CHECKOUT = [
  'omni_initiated_checkout',
  'initiate_checkout',
  'offsite_conversion.fb_pixel_initiate_checkout',
];
export const LANDING_PAGE_VIEW = [
  'landing_page_view',
  'omni_landing_page_view',
];

/** Insights row metrics shared by daily and breakdown rows. */
export function metricsOf(r: Record<string, any>) {
  const actions = actionMap(r.actions);
  const values = actionMap(r.action_values);
  return {
    actions,
    values,
    metrics: {
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      reach: Number(r.reach) || 0,
      frequency: Number(r.frequency) || 0,
      clicks: Number(r.clicks) || 0,
      linkClicks: Number(r.inline_link_clicks) || 0,
      landingPageViews: pickAction(actions, LANDING_PAGE_VIEW),
      metaAddToCart: pickAction(actions, ADD_TO_CART),
      metaInitiateCheckout: pickAction(actions, INITIATE_CHECKOUT),
      metaPurchases: pickAction(actions, PURCHASE),
      metaPurchaseValue: pickAction(values, PURCHASE),
    },
  };
}

/** Breakdown key, e.g. 'female|25-34', 'instagram|instagram_reels'. */
export const breakdownKey = (r: Record<string, any>, fields: string[]) =>
  fields.map((f) => String(r[f] ?? 'unknown')).join('|');

/** The ad's destination URL, wherever this creative type keeps it. */
export function landingUrlOf(
  creative: Record<string, any> | null | undefined,
): string {
  if (!creative) return '';
  const oss = creative.object_story_spec ?? {};
  return (
    oss.link_data?.link ||
    oss.link_data?.call_to_action?.value?.link ||
    oss.video_data?.call_to_action?.value?.link ||
    oss.template_data?.link ||
    creative.asset_feed_spec?.link_urls?.[0]?.website_url ||
    creative.link_url ||
    creative.object_url ||
    ''
  );
}

/** Which covered product a landing URL sells, or null. */
export function productFromUrl(url: string): string | null {
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  // Order matters: nadi-report-premium before nadi-report.
  for (const p of PM_PRODUCTS) {
    if (new RegExp(p.landingRe).test(path) || new RegExp(p.cartRe).test(path))
      return p.id;
  }
  return null;
}

/** Fallback from names, only for unambiguous wording. */
export function productFromName(name: string): string | null {
  const n = name.toLowerCase();
  if (/wish[ _-]?letter|golu|arzi/.test(n)) return 'golu-devta-arzi';
  if (/nadi.*premium|premium.*nadi/.test(n)) return 'nadi-report-premium';
  return null;
}

/** Budgets come in the account currency's minor unit (paise). */
export const rupees = (v: unknown): number | null =>
  v === undefined || v === null || v === '' ? null : Number(v) / 100;

const RETARGETING_RE =
  /visit|view|purchas|buyer|cart|checkout|engag|retarget|website|lead|customer|video/i;

/** Plain summary of an ad set's targeting. */
export function targetingSummary(t: Record<string, any> | null | undefined) {
  if (!t) return null;
  const names = (xs: any[] | undefined) =>
    (xs ?? []).map((x) => x?.name ?? String(x?.id ?? x)).filter(Boolean);
  const geo = t.geo_locations ?? {};
  const custom = names(t.custom_audiences);
  const interests = (t.flexible_spec ?? []).flatMap((f: any) => [
    ...names(f.interests),
    ...names(f.behaviors),
  ]);
  const lookalike = custom.some((n: string) =>
    /lookalike|\blal\b|similar/i.test(n),
  );
  const audienceType = custom.length
    ? lookalike
      ? 'lookalike'
      : custom.some((n: string) => RETARGETING_RE.test(n))
        ? 'retargeting'
        : 'custom'
    : interests.length
      ? 'interest'
      : 'broad';
  return {
    ageMin: t.age_min,
    ageMax: t.age_max,
    genders: t.genders,
    countries: geo.countries,
    regions: names(geo.regions),
    cities: names(geo.cities),
    customAudiences: custom,
    excludedAudiences: names(t.excluded_custom_audiences),
    interests,
    advantageAudience: t.targeting_automation?.advantage_audience === 1,
    audienceType,
  };
}

/** Product of a parent = the product with most spend among its children (ties → 'other'). */
export function majorityProduct(
  children: { product: string; spend: number }[],
): string {
  // 'other' competes too: a campaign that mostly sells something else is 'other',
  // even if one small ad points at a covered product.
  const by = new Map<string, number>();
  for (const c of children)
    by.set(c.product, (by.get(c.product) ?? 0) + c.spend);
  const sorted = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted[1] && sorted[1][1] === sorted[0][1]))
    return 'other';
  return sorted[0][0];
}

/**
 * An ad's product. A readable landing URL decides on its own: a covered
 * product's page → that product, any other page → 'other'. OpenPanel traffic
 * and the name are fallbacks only when the ad has no usable URL.
 */
export function adProduct(
  linkUrl: string,
  traffic: string | undefined,
  name: string,
): { product: string; source: 'url' | 'traffic' | 'name' | 'none' } {
  const fromUrl = productFromUrl(linkUrl);
  if (fromUrl) return { product: fromUrl, source: 'url' };
  if (isUrl(linkUrl)) return { product: 'other', source: 'url' };
  if (traffic) return { product: traffic, source: 'traffic' };
  const fromName = productFromName(name);
  if (fromName) return { product: fromName, source: 'name' };
  return { product: 'other', source: 'none' };
}

const isUrl = (u: string) => {
  try {
    return Boolean(u) && Boolean(new URL(u).host);
  } catch {
    return false;
  }
};

/** Split [from, to] (YYYY-MM-DD) into consecutive chunks of at most `days`, newest first. */
export function dateChunks(
  from: string,
  to: string,
  days: number,
): { since: string; until: string }[] {
  const DAY = 86_400_000;
  const out: { since: string; until: string }[] = [];
  let end = Date.parse(`${to}T00:00:00Z`);
  const start = Date.parse(`${from}T00:00:00Z`);
  while (end >= start) {
    const s = Math.max(start, end - (days - 1) * DAY);
    out.push({
      since: new Date(s).toISOString().slice(0, 10),
      until: new Date(end).toISOString().slice(0, 10),
    });
    end = s - DAY;
  }
  return out;
}

export type PmChangeValue = string | number | null;

/** Which setting an activity-log event changed (budget events are rupees after parsing). */
export function changeField(eventType: string, hint = ''): string {
  const t = eventType.toLowerCase();
  if (/budget|spend_cap/.test(t))
    return /lifetime/i.test(t + hint) ? 'lifetime_budget' : 'daily_budget';
  if (/run_status|status/.test(t)) return 'status';
  if (/target/.test(t)) return 'targeting';
  if (/bid_strategy/.test(t)) return 'bid_strategy';
  if (/bid/.test(t)) return 'bid_amount';
  if (/optimization_goal/.test(t)) return 'optimization_goal';
  if (/^create_/.test(t)) return 'created';
  if (/creative/.test(t)) return 'creative';
  if (/name/.test(t)) return 'name';
  return t;
}

/** Budget amounts: bare digits are minor units (paise); formatted strings ("₹7,500.00") are rupees. */
const money = (v: unknown): PmChangeValue => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return rupees(v);
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && /\d/.test(String(v)) ? n : String(v);
};

const plain = (v: unknown): PmChangeValue => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v).slice(0, 300);
};

/** { old_value: { old_value: 1000, … } } and { old_value: 1000 } both → 1000. */
const unwrap = (v: any, key: 'old_value' | 'new_value') =>
  v && typeof v === 'object' && !Array.isArray(v) && (key in v || 'value' in v)
    ? (v[key] ?? v.value)
    : v;

/**
 * Meta's extra_data (a JSON string whose shape varies by event type) →
 * field / old / new. Unknown shapes keep the field and give null values;
 * the raw string is stored alongside.
 */
export function parseExtraData(
  eventType: string,
  raw: string,
): { field: string; oldValue: PmChangeValue; newValue: PmChangeValue } {
  let d: any = null;
  try {
    d = raw ? JSON.parse(raw) : null;
  } catch {
    d = null;
  }
  const obj = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const field = changeField(
    eventType,
    `${obj.type ?? ''} ${obj.old_value?.type ?? ''} ${obj.new_value?.type ?? ''}`,
  );
  const oldRaw = unwrap(obj.old_value, 'old_value');
  const newRaw = unwrap(obj.new_value, 'new_value');
  if (/budget$/.test(field))
    return { field, oldValue: money(oldRaw), newValue: money(newRaw) };
  if (field === 'status') {
    // ponytail: numeric run_status codes are kept as-is; map them once a real sample shows them.
    const s = (v: unknown) =>
      typeof v === 'string'
        ? v.trim().toUpperCase().replace(/\s+/g, '_')
        : plain(v);
    return { field, oldValue: s(oldRaw), newValue: s(newRaw) };
  }
  return { field, oldValue: plain(oldRaw), newValue: plain(newRaw) };
}
