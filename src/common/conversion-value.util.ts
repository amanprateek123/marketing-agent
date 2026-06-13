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
 * GROSS revenue per conversion: conversionValue, falling back to price.
 *
 * Falsy-zero guard: a `conversionValue` of 0 (or negative) is NOT a valid
 * revenue figure — no product is worth ₹0 per conversion — so it falls back
 * to `price`, the same as a missing value. A plain `?? price` chain treated
 * an explicit 0 as intentional and returned 0, which made ROAS read 0.00x and
 * tripped the data_gap protocol indefinitely even when price was set
 * (Nadi Leaf Reading: price ₹10,000, conversionValue 0 → 5 blocked audits,
 * ₹21,625 of spend with no profitability decisions). When BOTH are 0/unset,
 * this returns 0 and data_gap correctly fires — that path is preserved.
 *
 * Use for gross-context sites: the Meta campaign-config optimization target,
 * the AOV attribution-window proxy, and prompt/display strings. For any
 * ROAS / breakeven / bandit decision use getEffectiveConversionValue (net).
 */
export function getGrossConversionValue(product?: RefundableProduct | null): number {
  const cv = Number(product?.conversionValue);
  if (Number.isFinite(cv) && cv > 0) return cv;
  const price = Number(product?.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

/**
 * NET revenue per conversion: gross × (1 − refund rate).
 * This is the number all ROAS, breakeven, and bandit math should use.
 */
export function getEffectiveConversionValue(product?: RefundableProduct | null): number {
  return getGrossConversionValue(product) * getRefundFactor(product);
}
