/**
 * Power calculations for the audit pipeline. Derives "how much data do we need
 * before this signal is statistically meaningful" from the vertical's baseline
 * conversion / click-through rates — instead of using flat constants that are
 * either too lenient for fintech (CTR ~0.5%) or too strict for food delivery (CTR ~3%).
 *
 * Closed-form. No math library.
 *
 * Z-values used (two-sided α=0.05, power=0.80) are baked in as constants since
 * other (α, power) combos aren't currently used by the audit pipeline.
 */

const Z_ALPHA_TWO_SIDED_05 = 1.96;
const Z_BETA_POWER_80 = 0.84;

/**
 * Required sample size to detect a relative drop in a proportion with α=0.05, power=0.80.
 *
 * Use for CTR-fatigue floors:
 *   "How many impressions does an ad need before a 35% CTR drop is signal, not noise?"
 *
 * Single-arm test against a known baseline (the ad's own ctrBaseline).
 *
 * Examples (relDropPct=35, α=0.05, power=0.80):
 *   p₀=3.0% (spirituality)  → ~2,200 impressions
 *   p₀=1.5% (default)       → ~4,400 impressions
 *   p₀=0.5% (fintech floor) → ~13,500 impressions
 *
 * @param baselineProportion p₀ — the proportion we're comparing against (decimal, e.g. 0.015 for 1.5%)
 * @param relDropPct         the minimum relative drop we want to be able to detect, in percent (default 35)
 */
export function requiredSampleForProportionDrop(
  baselineProportion: number,
  relDropPct: number = 35,
): number {
  if (baselineProportion <= 0 || baselineProportion >= 1) return Infinity;
  if (relDropPct <= 0 || relDropPct >= 100) return Infinity;
  const delta = baselineProportion * (relDropPct / 100);
  const variance = baselineProportion * (1 - baselineProportion);
  const n = ((Z_ALPHA_TWO_SIDED_05 + Z_BETA_POWER_80) ** 2 * variance) / (delta * delta);
  return Math.ceil(n);
}

/**
 * Required clicks to confidently say "zero conversions is unusual" given a baseline CVR.
 *
 * P(observe 0 conversions in n clicks | true CVR = p) = (1-p)^n.
 * For this to drop below α, we need n > log(α) / log(1-p).
 *
 * Examples (α=0.05):
 *   CVR=8% (food delivery)    → ~37 clicks
 *   CVR=6% (spirituality)     → ~49 clicks
 *   CVR=3% (fintech)          → ~99 clicks
 *   CVR=2% (B2B SaaS)         → ~149 clicks
 *
 * @param baselineCVR decimal (e.g. 0.06 for 6%)
 * @param alpha       false-positive tolerance; default 0.05
 */
export function requiredClicksForZeroConvSignal(
  baselineCVR: number,
  alpha: number = 0.05,
): number {
  if (baselineCVR <= 0 || baselineCVR >= 1) return 100;
  if (alpha <= 0 || alpha >= 1) return 100;
  const n = Math.log(alpha) / Math.log(1 - baselineCVR);
  return Math.ceil(n);
}

/**
 * Derive all sample-size floors used by signal-detector from a vertical benchmark.
 * Computed once per audit, used at every trigger site. Caps applied to keep floors
 * sane (a vertical with extreme CTR shouldn't drive the floor to 1 or to 1M).
 */
export function deriveFloorsFromVertical(input: {
  ctrMidpoint: number;          // decimal — midpoint of vertical CTR range, e.g. 0.025 for 2.5%
  cvrTypical: number;           // decimal — vertical's typical CVR, e.g. 0.06 for 6%
}): {
  impressionsForCtrSignal: number;       // CTR fatigue floor
  clicksForZeroConvSignal: number;       // "no conversions yet" pause floor
  clicksForRetargetTrigger: number;      // higher than zero-conv: confidence we have audience
  conversionsForWinnerFloor: number;     // hard floor below which posterior is too uncertain
} {
  const { ctrMidpoint, cvrTypical } = input;

  // Hard caps so unusual verticals don't produce absurd floors.
  const MIN_IMPRESSIONS_CAP = 800;
  const MAX_IMPRESSIONS_CAP = 15000;
  const MIN_CLICKS_CAP = 30;
  const MAX_CLICKS_CAP = 200;

  const rawImpressions = requiredSampleForProportionDrop(ctrMidpoint, 35);
  const rawClicksZeroConv = requiredClicksForZeroConvSignal(cvrTypical, 0.05);

  const impressionsForCtrSignal = Math.min(
    Math.max(rawImpressions, MIN_IMPRESSIONS_CAP),
    MAX_IMPRESSIONS_CAP,
  );
  const clicksForZeroConvSignal = Math.min(
    Math.max(rawClicksZeroConv, MIN_CLICKS_CAP),
    MAX_CLICKS_CAP,
  );

  return {
    impressionsForCtrSignal,
    clicksForZeroConvSignal,
    // Retarget needs ~4× the data of "zero-conv signal" — we're not pausing, we're committing
    // budget to a new audience derived from these clicks. Hard cap 400.
    clicksForRetargetTrigger: Math.min(clicksForZeroConvSignal * 4, 400),
    // Winner posterior at N<5 conversions is too uncertain even with shrinkage.
    conversionsForWinnerFloor: 5,
  };
}
