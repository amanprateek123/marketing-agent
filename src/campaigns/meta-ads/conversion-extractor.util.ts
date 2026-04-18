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
