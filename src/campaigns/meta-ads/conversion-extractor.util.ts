const STANDARD_EVENTS = new Set([
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'complete_registration',
  'submit_application',
  'subscribe',
  'start_trial',
]);

const STANDARD_PRIORITY = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'complete_registration',
  'submit_application',
  'subscribe',
  'start_trial',
];

/**
 * Meta reports app-events conversions under prefixed action_types, never the
 * bare event name — app_custom_event.other.<event> for non-standard events,
 * mobile_app_install/omni_app_install for installs. Products tracked via
 * metaAppId (not pixelId) need these variants added to conversionTypes, or
 * extractConversions silently returns 0 for a campaign that's actually
 * converting (same failure shape as the missing customConversionId bug from
 * 2026-06-10 — see campaign-sync.service.ts).
 *
 * Every in-app event this pipeline tracks today is non-standard (chat_success
 * etc.), matching the OTHER-only assumption already made by mapConversionEvent
 * in meta-ads.service.ts — extend with standard app-event action_types later
 * only if a product actually needs one.
 */
export function appEventActionTypes(product: {
  metaAppId?: string;
  conversionEvent?: string;
  customEventName?: string;
}): string[] {
  if (!product.metaAppId || !product.conversionEvent) return [];
  const eventName = product.customEventName ?? product.conversionEvent;
  return [
    'mobile_app_install',
    'omni_app_install',
    `app_custom_event.other.${eventName}`,
  ];
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
      .filter(a => a.action_type.startsWith('offsite_conversion.custom.') && conversionTypes.has(a.action_type))
      .reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
    if (customConvTotal > 0) return customConvTotal;

    // Path B — Custom pixel event names (e.g. NADI_REPORT_PURCHASE_COMPLETED)
    const customPixelTotal = actions
      .filter(
        a =>
          !a.action_type.startsWith('offsite_conversion.custom.') &&
          !STANDARD_EVENTS.has(a.action_type) &&
          conversionTypes.has(a.action_type),
      )
      .reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
    if (customPixelTotal > 0) return customPixelTotal;

    // Path C — Standard events fallback (purchase, lead, etc.)
    for (const type of STANDARD_PRIORITY) {
      if (!conversionTypes.has(type)) continue;
      const action = actions.find(a => a.action_type === type);
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
      .filter(a => a.action_type.startsWith('offsite_conversion.custom.') && conversionTypes.has(a.action_type))
      .reduce((sum, a) => sum + parseFloat(a.value ?? '0'), 0);
    if (customConvTotal > 0) return customConvTotal;

    // Path B — Custom pixel event names
    const customPixelTotal = actionValues
      .filter(
        a =>
          !a.action_type.startsWith('offsite_conversion.custom.') &&
          !STANDARD_EVENTS.has(a.action_type) &&
          conversionTypes.has(a.action_type),
      )
      .reduce((sum, a) => sum + parseFloat(a.value ?? '0'), 0);
    if (customPixelTotal > 0) return customPixelTotal;

    // Path C — Standard events fallback
    for (const type of STANDARD_PRIORITY) {
      if (!conversionTypes.has(type)) continue;
      const action = actionValues.find(a => a.action_type === type);
      const val = parseFloat(action?.value ?? '0');
      if (val > 0) return val;
    }
  }

  return 0;
}
