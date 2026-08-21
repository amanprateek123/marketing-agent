const STANDARD_EVENTS = new Set([
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'complete_registration',
  'offsite_conversion.fb_pixel_complete_registration',
  'submit_application',
  'offsite_conversion.fb_pixel_submit_application',
  'subscribe',
  'offsite_conversion.fb_pixel_subscribe',
  'start_trial',
  'offsite_conversion.fb_pixel_start_trial',
  // Mobile-app purchase equivalents of the website pixel pair above — Meta
  // commonly reports the same app purchase under both the legacy and
  // omni-channel action_type simultaneously, so these need the same
  // pick-one-don't-sum treatment (Path B excludes STANDARD_EVENTS; Path C
  // picks the first non-zero match below) or ROAS double-counts.
  'mobile_app_purchase',
  'omni_purchase',
  // Same legacy/omni pairing for installs — affects conversion COUNT (and
  // therefore CPA) rather than revenue, but the same double-count risk.
  'mobile_app_install',
  'omni_app_install',
]);

const STANDARD_PRIORITY = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'complete_registration',
  'offsite_conversion.fb_pixel_complete_registration',
  'submit_application',
  'offsite_conversion.fb_pixel_submit_application',
  'subscribe',
  'offsite_conversion.fb_pixel_subscribe',
  'start_trial',
  'offsite_conversion.fb_pixel_start_trial',
  // omni_purchase first — Meta's current canonical unified metric; falls
  // back to the legacy mobile_app_purchase if that's what actually appears.
  'omni_purchase',
  'mobile_app_purchase',
  'omni_app_install',
  'mobile_app_install',
];

const WEB_STANDARD_EVENT_PAIRS: Record<string, [string, string]> = {
  purchase: ['purchase', 'offsite_conversion.fb_pixel_purchase'],
  lead: ['lead', 'offsite_conversion.fb_pixel_lead'],
  completeregistration: [
    'complete_registration',
    'offsite_conversion.fb_pixel_complete_registration',
  ],
  subscribe: ['subscribe', 'offsite_conversion.fb_pixel_subscribe'],
  starttrial: ['start_trial', 'offsite_conversion.fb_pixel_start_trial'],
  submitapplication: [
    'submit_application',
    'offsite_conversion.fb_pixel_submit_application',
  ],
};

function normalizeConfiguredEvent(event: string | undefined): string {
  return String(event ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Meta reports app-events conversions under prefixed action_types, never the
 * bare event name — app_custom_event.other.<event> for non-standard events,
 * mobile_app_install/omni_app_install for installs. Products tracked via
 * metaAppId (not pixelId) need these variants added to conversionTypes, or
 * extractConversions silently returns 0 for a campaign that's actually
 * converting (same failure shape as the missing customConversionId bug from
 * 2026-06-10 — see campaign-sync.service.ts).
 *
 * Mirrors the standard-vs-OTHER split mapConversionEvent already makes at
 * launch time (meta-ads.service.ts) — a product whose conversionEvent is the
 * literal string 'Purchase' fires AppEventsLogger.logPurchase() client-side
 * (see 91astro-app/src/utils/analytics.js), which Meta reports as a standard
 * mobile-app purchase action_type, not the app_custom_event.other.* shape.
 * Without this split, ROAS silently reads 0 in our own audit/sync pipeline
 * even once Meta's own Ads Manager is reporting real revenue correctly —
 * same failure shape as the missing customEventName bug this file already
 * documents, now for the revenue side instead of the conversion-count side.
 */
export function appEventActionTypes(product: {
  metaAppId?: string;
  conversionEvent?: string;
  customEventName?: string;
}): string[] {
  if (!product.metaAppId) return [];
  const customEventName = String(product.customEventName ?? '').trim();
  const configuredEvent = String(product.conversionEvent ?? '').trim();
  const normalizedEvent = normalizeConfiguredEvent(configuredEvent);
  if (!customEventName && normalizedEvent === 'purchase') {
    // omni_purchase is Meta's newer channel-agnostic action_type; mobile_app_purchase
    // is the classic one. Match both — unvalidated against a real payload as of
    // 2026-08-11, watch the first live recharge closely and adjust if Meta's
    // actual response differs (see the equivalent caveat on the OTHER-event path).
    return ['mobile_app_purchase', 'omni_purchase'];
  }
  if (
    !customEventName &&
    ['install', 'appinstall', 'mobileappinstall'].includes(normalizedEvent)
  ) {
    return ['mobile_app_install', 'omni_app_install'];
  }
  const eventName = customEventName || configuredEvent;
  if (!eventName || normalizeConfiguredEvent(eventName) === 'customevent') {
    return [];
  }
  if (
    eventName.startsWith('app_custom_event.') ||
    eventName.startsWith('mobile_app_') ||
    eventName.startsWith('omni_')
  ) {
    return [eventName];
  }
  return [`app_custom_event.other.${eventName}`];
}

export type ProductConversionTypeSource =
  | 'custom_conversion'
  | 'custom_event'
  | 'standard_event'
  | 'app_event'
  | 'account_fallback'
  | 'unresolved';

export interface ProductConversionTypeResolution {
  conversionTypes: Set<string>;
  source: ProductConversionTypeSource;
}

/**
 * Resolve exactly one product's configured success event. This prevents a
 * multi-product account row from counting another product's conversion or
 * applying the wrong product value to it.
 */
export function resolveProductConversionTypes(
  product:
    | {
        customConversionId?: string;
        customEventName?: string;
        conversionEvent?: string;
        metaAppId?: string;
      }
    | null
    | undefined,
  _accountFallback: ReadonlySet<string> = new Set<string>(),
  options?: { useAppEvents?: boolean },
): ProductConversionTypeResolution {
  // Retained for API compatibility; unresolved products deliberately fail closed.
  void _accountFallback;
  if (!product) {
    return { conversionTypes: new Set(), source: 'unresolved' };
  }

  const customConversionId = String(product.customConversionId ?? '').trim();
  if (customConversionId) {
    return {
      conversionTypes: new Set([
        `offsite_conversion.custom.${customConversionId}`,
      ]),
      source: 'custom_conversion',
    };
  }

  if (product.metaAppId && options?.useAppEvents !== false) {
    const appTypes = appEventActionTypes(product);
    return {
      conversionTypes: new Set(appTypes),
      source: appTypes.length > 0 ? 'app_event' : 'unresolved',
    };
  }

  const customEventName = String(product.customEventName ?? '').trim();
  if (customEventName) {
    return {
      conversionTypes: new Set([customEventName]),
      source: 'custom_event',
    };
  }

  const conversionEvent = String(product.conversionEvent ?? '').trim();
  const normalizedEvent = normalizeConfiguredEvent(conversionEvent);
  const standardPair = WEB_STANDARD_EVENT_PAIRS[normalizedEvent];
  if (standardPair) {
    return {
      conversionTypes: new Set(standardPair),
      source: 'standard_event',
    };
  }
  if (conversionEvent && normalizedEvent !== 'customevent') {
    return {
      conversionTypes: new Set([conversionEvent]),
      source: 'custom_event',
    };
  }
  return { conversionTypes: new Set(), source: 'unresolved' };
}

/**
 * Extract the conversion count from a Meta actions array.
 *
 * conversionTypes is pre-filtered to only contain purchase-type custom conversions
 * (done in fetchConversionData). So Path A sums only purchases, not add-to-carts.
 *
 * Priority:
 *   A — purchase-type custom conversions (offsite_conversion.custom.*)
 *   B — custom pixel events (e.g. NADI_REPORT_PURCHASE_COMPLETED)
 *   C — standard events fallback (purchase, lead, etc.)
 */
export function extractConversions(
  actions: any[] | undefined,
  conversionTypes?: Set<string>,
): number {
  if (!actions || actions.length === 0) return 0;

  if (conversionTypes && conversionTypes.size > 0) {
    // Path A — purchase-type Meta custom conversions (offsite_conversion.custom.*)
    const customConvTotal = actions
      .filter(
        (a) =>
          a.action_type.startsWith('offsite_conversion.custom.') &&
          conversionTypes.has(a.action_type),
      )
      .reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
    if (customConvTotal > 0) return customConvTotal;

    // Path B — Custom pixel event names (e.g. NADI_REPORT_PURCHASE_COMPLETED)
    const customPixelTotal = actions
      .filter(
        (a) =>
          !a.action_type.startsWith('offsite_conversion.custom.') &&
          !STANDARD_EVENTS.has(a.action_type) &&
          conversionTypes.has(a.action_type),
      )
      .reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
    if (customPixelTotal > 0) return customPixelTotal;

    // Path C — Standard events fallback (purchase, lead, etc.)
    for (const type of STANDARD_PRIORITY) {
      if (!conversionTypes.has(type)) continue;
      const action = actions.find((a) => a.action_type === type);
      const val = parseInt(action?.value ?? '0', 10);
      if (val > 0) return val;
    }
  }

  return 0;
}

/**
 * Extract the total conversion VALUE (sum of pixel event `value` params) from
 * Meta's `action_values` insights field. Mirrors extractConversions logic so
 * the same conversionTypes Set drives both count and value. Used to compute
 * real ROAS: actionValue / spend.
 *
 * When the pixel doesn't fire with a `value` param, Meta returns no
 * action_values for that conversion type — returns 0 here. Caller should
 * fall back to (count × product.conversionValue) for legacy setups.
 */
export function extractActionValue(
  actionValues: any[] | undefined,
  conversionTypes?: Set<string>,
): number {
  if (!actionValues || actionValues.length === 0) return 0;

  if (conversionTypes && conversionTypes.size > 0) {
    // Path A — purchase-type Meta custom conversions
    const customConvTotal = actionValues
      .filter(
        (a) =>
          a.action_type.startsWith('offsite_conversion.custom.') &&
          conversionTypes.has(a.action_type),
      )
      .reduce((sum, a) => sum + parseFloat(a.value ?? '0'), 0);
    if (customConvTotal > 0) return customConvTotal;

    // Path B — Custom pixel event names
    const customPixelTotal = actionValues
      .filter(
        (a) =>
          !a.action_type.startsWith('offsite_conversion.custom.') &&
          !STANDARD_EVENTS.has(a.action_type) &&
          conversionTypes.has(a.action_type),
      )
      .reduce((sum, a) => sum + parseFloat(a.value ?? '0'), 0);
    if (customPixelTotal > 0) return customPixelTotal;

    // Path C — Standard events fallback
    for (const type of STANDARD_PRIORITY) {
      if (!conversionTypes.has(type)) continue;
      const action = actionValues.find((a) => a.action_type === type);
      const val = parseFloat(action?.value ?? '0');
      if (val > 0) return val;
    }
  }

  return 0;
}
