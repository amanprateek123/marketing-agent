/**
 * Lightweight Bayesian estimators for the audit pipeline. Closed-form, no math library.
 *
 * Why these exist:
 *   The system has hard thresholds like "≥10 conversions = winner" — at N=9 we ignore,
 *   at N=10 we scale 20%. That's a cliff; one extra conversion is not a meaningful
 *   evidence change. These helpers replace the cliff with a continuous transition:
 *   small-N observations get pulled toward the vertical prior, large-N observations
 *   dominate. Same threshold across all N produces sane behavior at both ends.
 */

/**
 * Shrink an observed proportion / rate toward a prior. The prior is encoded as
 * `kappa` "pseudo-observations" of value `priorMean`. At n = kappa the observed
 * and prior contribute equally; at n = 10×kappa the prior contributes ~10%.
 *
 * Use for: shrunken CVR, shrunken CTR, shrunken CPA point estimates that the
 * agent compares against benchmarks. Prevents lucky early data from being treated
 * as a real signal.
 *
 * @param observed  The raw observed value (e.g. observed CVR = conversions/clicks)
 * @param n         Number of trials behind the observation (clicks for CVR, impressions for CTR)
 * @param priorMean The vertical or category prior (e.g. priorCVR from vertical-benchmarks.cvrPct.typical / 100)
 * @param kappa     Prior strength in pseudo-observations. Default 10 = "moderate trust in vertical mean."
 */
export function shrinkTowardPrior(
  observed: number,
  n: number,
  priorMean: number,
  kappa: number = 10,
): number {
  if (n <= 0) return priorMean;
  return (n * observed + kappa * priorMean) / (n + kappa);
}

/**
 * Wilson score interval — closed-form 95% confidence lower bound on a proportion.
 * Better than the normal approximation at small N and zero successes.
 *
 * Use for: "is the true conversion rate provably > X with 95% confidence?"
 * Returns the lower edge of the 95% CI; compare to a target rate to decide.
 *
 * @param successes Conversions (or whatever success count)
 * @param n         Trials (clicks)
 * @param z         z-score for the desired confidence; default 1.96 = 95%
 */
export function wilsonLowerBound(successes: number, n: number, z: number = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return Math.max(0, center - margin);
}

/**
 * Convenience: posterior summary for a "winner" decision on an ad set.
 *
 * Returns:
 *   - shrunkenCVR: point estimate of true conversion rate, pulled toward vertical prior
 *   - lowerCVR: lower 95% bound on true conversion rate (Wilson)
 *   - shrunkenROAS: implied ROAS using shrunken CVR
 *   - lowerROAS: lower 95% bound on ROAS (using lowerCVR)
 *
 * Use: winner iff shrunkenROAS > scaleThreshold AND lowerROAS > 1.0.
 * The first condition says "the point estimate suggests a winner"; the second
 * says "we're confident this is at least breakeven, not just lucky." Both must
 * hold to scale.
 */
export function adSetWinnerPosterior(input: {
  conversions: number;
  clicks: number;
  spend: number;                  // total spend on this ad set (₹)
  conversionValue: number;        // revenue per conversion (₹)
  priorCVR: number;               // vertical CVR prior (decimal, e.g. 0.06 for 6%)
  kappa?: number;                 // prior strength; default 10 pseudo-clicks
}): {
  shrunkenCVR: number;
  lowerCVR: number;
  shrunkenROAS: number;
  lowerROAS: number;
} {
  const { conversions, clicks, spend, conversionValue, priorCVR, kappa = 10 } = input;
  const observedCVR = clicks > 0 ? conversions / clicks : 0;
  const shrunkenCVR = shrinkTowardPrior(observedCVR, clicks, priorCVR, kappa);
  const lowerCVR = wilsonLowerBound(conversions, clicks);

  // Implied revenue at each CVR estimate, then divide by spend for ROAS.
  // Falls back to 0 when spend is 0 (newly launched ad set).
  const impliedRevenue = (cvr: number) => cvr * clicks * conversionValue;
  const shrunkenROAS = spend > 0 ? impliedRevenue(shrunkenCVR) / spend : 0;
  const lowerROAS = spend > 0 ? impliedRevenue(lowerCVR) / spend : 0;

  return { shrunkenCVR, lowerCVR, shrunkenROAS, lowerROAS };
}
