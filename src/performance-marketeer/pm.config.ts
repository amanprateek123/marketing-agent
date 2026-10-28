import { registerAs } from '@nestjs/config';

/**
 * Performance Marketeer — everything this module needs from the environment.
 * Kept separate from the app-wide configuration.ts on purpose: the module is
 * self-contained and reads 91astro's own data (OpenPanel ClickHouse + the
 * product Mongo through Metabase), not Meridian's.
 */
export const pmEnv = registerAs('pm', () => ({
  // Which Meridian tenant these rows belong to (the 91astro workspace).
  tenantId: process.env.PM_TENANT_ID ?? '91astrology',
  // Crons are off unless explicitly enabled, so deploying never starts
  // reading production data by surprise.
  syncEnabled: (process.env.PM_SYNC_ENABLED ?? '').toLowerCase() === 'true',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? '',
    username: process.env.CLICKHOUSE_USER ?? '',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    project: process.env.OPENPANEL_PROJECT_ID ?? '91astro-website',
  },
  meta: {
    // System User token with ads_read only (read-only).
    accessToken: process.env.META_ACCESS_TOKEN ?? '',
    apiVersion: process.env.PM_META_API_VERSION ?? 'v21.0',
    // 91Astrology ad accounts: JFM24, Account Shift, Mayank (docs/performance-marketeer/06-decisions.md D-10).
    accountIds: (
      process.env.PM_META_ACCOUNT_IDS ??
      '6995951240481576,549390260260950,692074691787119'
    )
      .split(',')
      .map((s) => s.trim().replace(/^act_/, ''))
      .filter(Boolean),
  },
  metabase: {
    url: process.env.METABASE_URL ?? '',
    apiKey: process.env.METABASE_API_KEY ?? '',
    // Metabase's id for the 91astrology-prod Mongo database.
    databaseId: parseInt(process.env.METABASE_DATABASE_ID ?? '2', 10),
  },
}));

export type PmEnv = ReturnType<typeof pmEnv>;

/** A funnel step counted per visitor-day: an event, optionally only on some paths. */
export interface PmStep {
  key: PmStepKey;
  event: string;
  /** Regex on the event's page path. Needed when the event also fires on other products' pages. */
  pathRe?: string;
}

export type PmStepKey =
  | 'productView'
  | 'ctaClick'
  | 'addToCart'
  | 'formSubmit'
  | 'beginCheckout'
  | 'couponApplied'
  | 'paymentInitiated';

export interface PmProduct {
  id: string;
  label: string;
  /** Landing page, any locale prefix (/hi/, /ta/ …). */
  landingRe: string;
  /** Cart / checkout pages. */
  cartRe: string;
  steps: PmStep[];
  /**
   * Browser event fired just before the gateway. Its `order_id` property holds
   * the order's transactionId (Nadi Premium) or the order id — match both.
   */
  paymentEvent: string;
  /**
   * Server-side purchase event. Only listed where its device_id is the buyer's
   * browser device (sent with the client's IP + UA); for Golu Devta it is not.
   */
  purchaseEvent?: string;
  /** How to find this product's orders in 91astro Mongo (same as astro_be product-insights). */
  orderMatch: Record<string, unknown>;
}

const anyLocale = (path: string) => `^(/[a-z]{2})?${path}/?$`;

export const PM_PRODUCTS: PmProduct[] = [
  {
    id: 'nadi-report-premium',
    label: 'Nadi Report Premium',
    landingRe: anyLocale('/nadi-report-premium'),
    cartRe: anyLocale('/nadi-report-premium/cart'),
    steps: [
      { key: 'ctaClick', event: 'nadi_report_premium_cta_click' },
      {
        key: 'formSubmit',
        event: 'nadi_report_form_submit',
        pathRe: 'nadi-report-premium',
      },
      {
        key: 'couponApplied',
        event: 'cart_coupon_applied',
        pathRe: 'nadi-report-premium',
      },
      { key: 'paymentInitiated', event: 'nadi_report_premium_order_attempted' },
    ],
    paymentEvent: 'nadi_report_premium_order_attempted',
    purchaseEvent: 'nadi_report_premium_purchase',
    orderMatch: {
      'products.0.title': 'Nadi Report Premium',
      'additionalInfo.comboId': { $exists: false },
    },
  },
  {
    id: 'nadi-report',
    label: 'Nadi Report',
    landingRe: anyLocale('/nadi-report'),
    cartRe: '^(/[a-z]{2})?/nadi-report/cart(-v2)?/?$',
    steps: [
      {
        key: 'ctaClick',
        event: 'nadi_report_cta_click',
        pathRe: '^(/[a-z]{2})?/nadi-report(/|$)',
      },
      { key: 'addToCart', event: 'nadi_report_add_to_cart' },
      {
        key: 'formSubmit',
        event: 'nadi_report_form_submit',
        pathRe: '/nadi-report/cart',
      },
      {
        key: 'couponApplied',
        event: 'cart_coupon_applied',
        pathRe: '/nadi-report/cart',
      },
      { key: 'paymentInitiated', event: 'nadi_report_payment_initiated' },
    ],
    paymentEvent: 'nadi_report_payment_initiated',
    purchaseEvent: 'nadi_report_purchase',
    orderMatch: {
      'products.0.title': 'Nadi Report',
      'additionalInfo.comboId': { $exists: false },
    },
  },
  {
    id: 'golu-devta-arzi',
    label: 'Golu Devta Wish',
    landingRe: anyLocale('/golu-devta-arzi'),
    cartRe: anyLocale('/golu-devta-arzi/cart'),
    steps: [
      { key: 'productView', event: 'golu_devta_arzi_view' },
      { key: 'ctaClick', event: 'golu_devta_arzi_cta_click' },
      { key: 'beginCheckout', event: 'golu_devta_arzi_begin_checkout' },
      { key: 'formSubmit', event: 'golu_devta_arzi_form_submit' },
      { key: 'paymentInitiated', event: 'golu_devta_arzi_payment_initiated' },
    ],
    paymentEvent: 'golu_devta_arzi_payment_initiated',
    orderMatch: { 'products.0.productId': 'golu-devta-arzi' },
  },
];

export const findPmProduct = (id: string) =>
  PM_PRODUCTS.find((p) => p.id === id);

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Agreed definitions — docs/performance-marketeer/07-definitions.md. */
export const GST_RATE = 0.18;
export const ATTRIBUTION_WINDOW_DAYS = 7;
/** A Meta ad id in utm_content (Meta ids are 15+ digit numbers; some ads send slugs instead). */
export const META_AD_ID_RE = '^[0-9]{15,}$';
/** First day of OpenPanel history; Meta backfills start here too (D-11). */
export const PM_HISTORY_START = '2026-04-10';

/**
 * Transactions that are a customer paying 91astro. ASTROLOGER_* rows are
 * payouts/adjustments to astrologers and DEDUCTED_BALANCE is wallet spend,
 * so neither counts as a customer payment.
 */
export const CUSTOMER_PAYMENT_TYPES = [
  'ECOMMERCE',
  'ADD_BALANCE',
  'CHAT_PACK',
  'CONSULTATION',
];
