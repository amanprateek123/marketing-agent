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
 * Wilson score interval — closed-form 95% confidence UPPER bound on a proportion.
 *
 * Use for: "is the true conversion rate provably < X with 95% confidence?"
 * Returns the upper edge of the 95% CI; compare to a target rate to decide if even
 * the optimistic case is below threshold (i.e. confident loser).
 */
export function wilsonUpperBound(successes: number, n: number, z: number = 1.96): number {
  if (n <= 0) return 1;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return Math.min(1, center + margin);
}

/**
 * Convenience: posterior summary for a "loser" decision at the campaign or ad-set
 * level. Mirrors `adSetWinnerPosterior` but exposes the upper 95% bound on ROAS
 * so callers can require "even the optimistic estimate is below breakeven".
 *
 * Pause iff shrunkenROAS < breakeven AND upperROAS < breakeven AND conversions ≥ floor.
 */
export function adSetLoserPosterior(input: {
  conversions: number;
  clicks: number;
  spend: number;
  conversionValue: number;
  priorCVR: number;
  kappa?: number;
}): { shrunkenROAS: number; upperROAS: number } {
  const { conversions, clicks, spend, conversionValue, priorCVR, kappa = 10 } = input;
  const observedCVR = clicks > 0 ? conversions / clicks : 0;
  const shrunkenCVR = shrinkTowardPrior(observedCVR, clicks, priorCVR, kappa);
  const upperCVR = wilsonUpperBound(conversions, clicks);
  const impliedRevenue = (cvr: number) => cvr * clicks * conversionValue;
  const shrunkenROAS = spend > 0 ? impliedRevenue(shrunkenCVR) / spend : 0;
  const upperROAS = spend > 0 ? impliedRevenue(upperCVR) / spend : 0;
  return { shrunkenROAS, upperROAS };
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
/**
 * Acklam approximation of the inverse standard normal CDF (probit). Closed-form,
 * no math library. Accurate to ~1.15e-9 absolute error across the central region;
 * fine for our use (Bonferroni z-score selection where k ≤ ~200).
 *
 * Used by the learning loop to compute family-wise-error-corrected z-scores
 * when ranking N exemplar candidates: z = inverseNormalCdf(1 - α / (2·N)).
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    throw new Error(`inverseNormalCdf: p must be in (0,1), got ${p}`);
  }
  // Coefficients (Peter J. Acklam, 2003)
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

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
