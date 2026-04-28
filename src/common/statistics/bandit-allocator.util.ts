/**
 * Thompson Sampling allocator for ad-set budget redistribution.
 *
 * Each ad set is modeled as a Beta(α, β) posterior over true conversion rate.
 * Per Monte-Carlo trial we draw one CVR sample per ad set, multiply by
 * conversionValue / spend-per-click to get an implied ROAS, and award the
 * trial to the argmax. After N trials, each ad set's "probability of being
 * best" (pBest) IS the recommended budget allocation.
 *
 * Why this matters:
 *   - Ad sets with wide posteriors (low N) occasionally win trials → get budget → build evidence
 *   - Ad sets with narrow posteriors centered high consistently win → keep budget
 *   - Exploration vs exploitation is automatic, no hyperparameters
 *   - Provably near-optimal regret bound: O(√(KT log T))
 *
 * Pure functions. Closed-form sampling, no math library.
 */

// ─── Random sampling primitives ──────────────────────────────────────────────

/**
 * Box-Muller transform: turn two uniform [0,1) samples into one standard normal.
 * Cached pair for amortized O(1) per call.
 */
let _normalCache: number | null = null;
function sampleStandardNormal(): number {
  if (_normalCache !== null) {
    const v = _normalCache;
    _normalCache = null;
    return v;
  }
  let u1 = Math.random();
  while (u1 === 0) u1 = Math.random();   // log(0) guard
  const u2 = Math.random();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  _normalCache = r * Math.sin(theta);
  return r * Math.cos(theta);
}

/**
 * Marsaglia-Tsang algorithm for Gamma(shape, 1). Boosts shape<1 via the
 * standard trick: Γ(s) = Γ(s+1) × U^(1/s).
 */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Beta(α, β) sample via Beta = X/(X+Y), X~Γ(α), Y~Γ(β).
 */
export function sampleBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0;
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

// ─── Thompson allocator ──────────────────────────────────────────────────────

export interface AdSetForAllocation {
  adSetId: string;
  adSetName: string;
  conversions: number;
  clicks: number;
  spend: number;
}

export interface BanditAllocation {
  adSetId: string;
  adSetName: string;
  pBest: number;                 // [0,1] — probability this ad set is the true best
  recommendedPct: number;        // pBest × 100, normalized to sum = 100 across active arms
  posteriorMeanCVR: number;      // E[θ] = α / (α + β)
  expectedROAS: number;          // posteriorMeanCVR × conversionValue × clicks / spend
}

export interface ThompsonAllocationResult {
  allocations: BanditAllocation[];
  leader: { adSetId: string; adSetName: string; pBest: number } | null;
  trials: number;
  method: 'thompson_sampling';
  /** Bandit's confidence in its leader. Below ~0.55, the leader is barely ahead — exploration matters. */
  leaderConfidence: number;
}

/**
 * Run Thompson Sampling across the supplied ad sets. Produces an allocation
 * that the LLM can ratify or override.
 *
 * @param adSets             current ad-set metrics
 * @param priorCVR           vertical CVR prior (decimal, e.g. 0.06 for 6%)
 * @param conversionValue    revenue per conversion (₹)
 * @param numTrials          Monte Carlo trials (default 200 — gives 1pp precision on pBest)
 * @param kappa              prior strength in pseudo-clicks (default 10)
 */
export function thompsonAllocate(input: {
  adSets: AdSetForAllocation[];
  priorCVR: number;
  conversionValue: number;
  numTrials?: number;
  kappa?: number;
}): ThompsonAllocationResult {
  const { adSets, priorCVR, conversionValue, numTrials = 200, kappa = 10 } = input;

  if (adSets.length === 0) {
    return { allocations: [], leader: null, trials: 0, method: 'thompson_sampling', leaderConfidence: 0 };
  }
  if (adSets.length === 1) {
    const only = adSets[0];
    return {
      allocations: [{
        adSetId: only.adSetId,
        adSetName: only.adSetName,
        pBest: 1,
        recommendedPct: 100,
        posteriorMeanCVR: only.clicks > 0 ? (only.conversions + kappa * priorCVR) / (only.clicks + kappa) : priorCVR,
        expectedROAS: 0,
      }],
      leader: { adSetId: only.adSetId, adSetName: only.adSetName, pBest: 1 },
      trials: 0,
      method: 'thompson_sampling',
      leaderConfidence: 1,
    };
  }

  // Build Beta posterior parameters per arm.
  // Prior: kappa pseudo-observations split as kappa×priorCVR successes and kappa×(1-priorCVR) failures.
  const priorAlpha = Math.max(1e-3, kappa * priorCVR);
  const priorBeta = Math.max(1e-3, kappa * (1 - priorCVR));

  const arms = adSets.map(as => {
    const failures = Math.max(0, as.clicks - as.conversions);
    return {
      ...as,
      alpha: priorAlpha + as.conversions,
      beta: priorBeta + failures,
      // Implied per-click revenue at sampled CVR: cvr × conversionValue.
      // Multiply by clicks/spend to convert to ROAS proxy. Avoid div-by-zero with a small denom.
      revenuePerSpend: as.spend > 0 ? as.clicks / as.spend : 0,
      winCount: 0,
    };
  });

  for (let t = 0; t < numTrials; t++) {
    let bestIdx = 0;
    let bestROAS = -Infinity;
    for (let i = 0; i < arms.length; i++) {
      const cvrSample = sampleBeta(arms[i].alpha, arms[i].beta);
      const sampledROAS = cvrSample * conversionValue * arms[i].revenuePerSpend;
      if (sampledROAS > bestROAS) {
        bestROAS = sampledROAS;
        bestIdx = i;
      }
    }
    arms[bestIdx].winCount++;
  }

  const allocations: BanditAllocation[] = arms.map(a => {
    const pBest = a.winCount / numTrials;
    const posteriorMeanCVR = a.alpha / (a.alpha + a.beta);
    return {
      adSetId: a.adSetId,
      adSetName: a.adSetName,
      pBest,
      recommendedPct: Math.round(pBest * 100),
      posteriorMeanCVR,
      expectedROAS: posteriorMeanCVR * conversionValue * a.revenuePerSpend,
    };
  });

  // Re-normalize recommendedPct to sum to 100 (rounding error).
  const totalPct = allocations.reduce((s, a) => s + a.recommendedPct, 0);
  if (totalPct > 0 && totalPct !== 100) {
    const scale = 100 / totalPct;
    for (const a of allocations) a.recommendedPct = Math.round(a.recommendedPct * scale);
  }

  // Pick leader by pBest.
  const leader = allocations.reduce(
    (best, a) => (a.pBest > best.pBest ? a : best),
    allocations[0],
  );

  return {
    allocations: allocations.sort((a, b) => b.pBest - a.pBest),
    leader: { adSetId: leader.adSetId, adSetName: leader.adSetName, pBest: leader.pBest },
    trials: numTrials,
    method: 'thompson_sampling',
    leaderConfidence: leader.pBest,
  };
}
