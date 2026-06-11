/**
 * Refund-aware conversion value resolution.
 *
 * conversionValue / price and Meta pixel `value` params are GROSS bookings.
 * For refundable funnels (Nadi Report-style: pay → reading → optional refund)
 * a chunk of that revenue comes back, so every ROAS / breakeven decision made
 * on gross numbers overstates profitability — the system scales campaigns
 * that net out unprofitable and trusts "winners" that aren't.
 *
 * Two rules keep this from double-counting:
 *   1. Anywhere code resolves a per-conversion value from a product
 *      (`product.conversionValue ?? product.price`), use
 *      getEffectiveConversionValue() instead — it applies the haircut once.
 *   2. MetaMetricsService applies getRefundFactor() to the action_values
 *      branch only (real pixel revenue, which is gross). Its conversionValue
 *      param is expected to already be refund-adjusted by the caller.
 */

interface RefundableProduct {
  price?: number;
  conversionValue?: number;
  refundRatePercent?: number;
}

/**
 * Multiplier that converts gross revenue to net-of-refunds revenue.
 * Clamped to [0%, 95%] so a typo'd 100% can't zero out all revenue and
 * make every campaign look like a total loss.
 */
export function getRefundFactor(product?: RefundableProduct | null): number {
  const rate = Number(product?.refundRatePercent ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return 1 - Math.min(rate, 95) / 100;
}

/**
 * Net revenue per conversion: (conversionValue ?? price) × (1 − refund rate).
 * This is the number all ROAS, breakeven, and bandit math should use.
 */
export function getEffectiveConversionValue(product?: RefundableProduct | null): number {
  const gross = product?.conversionValue ?? product?.price ?? 0;
  return gross * getRefundFactor(product);
}
