/**
 * Pure maths for the agent's maths tools (maths.tools.ts) — so no number in a
 * phase file comes from model arithmetic. No I/O; tested in maths.logic.spec.ts.
 */
import { TARGET_ROAS, Z95 } from '../../analysis/pm-stats';

// ---------------------------------------------------------------- calc

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
};

/**
 * Safe arithmetic: numbers, + - * / ^, parentheses, min/max/round/abs/sqrt
 * (round(x, digits)). Recursive descent, no eval. ^ is right-associative and
 * binds tighter than unary minus (-2^2 = -4).
 */
export function calc(expr: string): number {
  if (expr.length > 500) throw new Error('Expression too long');
  const toks =
    expr.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[a-z]+|[-+*/^(),]|\S/gi) ??
    [];
  let i = 0;
  const peek = () => toks[i];
  const eat = (t?: string) => {
    const x = toks[i++];
    if (t && x !== t)
      throw new Error(`Expected "${t}" but got "${x ?? 'end'}"`);
    return x;
  };
  const expression = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-')
      v = eat() === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      if (eat() === '*') v *= unary();
      else {
        const d = unary();
        if (d === 0) throw new Error('Division by zero');
        v /= d;
      }
    }
    return v;
  };
  const unary = (): number => {
    if (peek() === '-') return (eat(), -unary());
    if (peek() === '+') return (eat(), unary());
    return power();
  };
  const power = (): number => {
    const b = primary();
    return peek() === '^' ? (eat(), b ** unary()) : b;
  };
  const primary = (): number => {
    const t = eat();
    if (t === undefined) throw new Error('Unexpected end of expression');
    if (t === '(') {
      const v = expression();
      eat(')');
      return v;
    }
    if (/^[\d.]/.test(t)) return Number(t);
    const f = FUNCS[t.toLowerCase()];
    if (!f) throw new Error(`Unknown token "${t}"`);
    eat('(');
    const args = [expression()];
    while (peek() === ',') (eat(), args.push(expression()));
    eat(')');
    return f(...args);
  };
  const v = expression();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i]}"`);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

// ---------------------------------------------------------------- stat_compare

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Wilson score interval for k / n. */
export function wilson(k: number, n: number, z = Z95) {
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const hw = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { low: Math.max(0, mid - hw), high: Math.min(1, mid + hw) };
}

/**
 * Difference of two proportions a − b with Newcombe's hybrid score 95%
 * interval (built from two Wilson intervals; behaves with small counts and 0s).
 */
export function compareProportions(
  a: { k: number; n: number },
  b: { k: number; n: number },
) {
  for (const x of [a, b])
    if (!(x.n > 0) || x.k < 0 || x.k > x.n)
      throw new Error('Each side needs 0 ≤ successes ≤ trials and trials > 0');
  const p1 = a.k / a.n;
  const p2 = b.k / b.n;
  const w1 = wilson(a.k, a.n);
  const w2 = wilson(b.k, b.n);
  const d = p1 - p2;
  const low = d - Math.sqrt((p1 - w1.low) ** 2 + (w2.high - p2) ** 2);
  const high = d + Math.sqrt((w1.high - p1) ** 2 + (p2 - w2.low) ** 2);
  const significant = low > 0 || high < 0;
  return {
    rateA: round(p1, 6),
    rateB: round(p2, 6),
    diff: round(d, 6),
    diff95: { low: round(low, 6), high: round(high, 6) },
    relDiff: p2 ? round(d / p2) : null,
    verdict: significant ? 'significant' : 'not distinguishable from noise',
  };
}

/**
 * Two Poisson rates (counts per exposure, e.g. orders per ₹ spend or per
 * day). Difference with a normal 95% interval (a zero count is given variance
 * 0.5 so the interval is not falsely tight) and, when both counts > 0, the
 * rate ratio with a log-normal 95% interval. Significant when the interval
 * excludes "no difference".
 */
export function comparePoisson(
  a: { count: number; exposure: number },
  b: { count: number; exposure: number },
) {
  for (const x of [a, b])
    if (!(x.exposure > 0) || x.count < 0)
      throw new Error('Each side needs count ≥ 0 and exposure > 0');
  const r1 = a.count / a.exposure;
  const r2 = b.count / b.exposure;
  const d = r1 - r2;
  const se = Math.sqrt(
    Math.max(a.count, 0.5) / a.exposure ** 2 +
      Math.max(b.count, 0.5) / b.exposure ** 2,
  );
  const diff95 = { low: d - Z95 * se, high: d + Z95 * se };
  let ratio95: { low: number; high: number } | null = null;
  if (a.count > 0 && b.count > 0) {
    const s = Math.sqrt(1 / a.count + 1 / b.count);
    const rr = r1 / r2;
    ratio95 = { low: rr * Math.exp(-Z95 * s), high: rr * Math.exp(Z95 * s) };
  }
  const significant = ratio95
    ? ratio95.low > 1 || ratio95.high < 1
    : diff95.low > 0 || diff95.high < 0;
  return {
    rateA: r1,
    rateB: r2,
    diff: d,
    diff95,
    rateRatio: r2 ? round(r1 / r2) : null,
    rateRatio95: ratio95 && {
      low: round(ratio95.low),
      high: round(ratio95.high),
    },
    verdict: significant ? 'significant' : 'not distinguishable from noise',
    ...(a.count + b.count < 10
      ? { note: 'Fewer than 10 events in total — treat any call as weak' }
      : {}),
  };
}

// ---------------------------------------------------------------- impact_rupees

/**
 * ₹/day at stake: spendPerDay × shareAffected × (roasIfFixed − roasNow).
 * Read: extra first-party revenue per day at the same spend if the cause were
 * fixed. With roasIfFixed = target (1.0) and roasNow < 1 it is the daily loss
 * (spend − revenue) on the affected spend.
 */
export function impactRupees(i: {
  spendPerDay: number;
  roasNow: number;
  roasIfFixed?: number;
  shareAffected?: number;
}) {
  const roasIfFixed = i.roasIfFixed ?? TARGET_ROAS;
  const share = i.shareAffected ?? 1;
  if (!(i.spendPerDay >= 0)) throw new Error('spendPerDay must be ≥ 0');
  if (!(share >= 0 && share <= 1)) throw new Error('shareAffected must be 0–1');
  if (!(i.roasNow >= 0) || !(roasIfFixed >= 0))
    throw new Error('ROAS must be ≥ 0');
  const perDay = i.spendPerDay * share * (roasIfFixed - i.roasNow);
  return {
    impactRupeesPerDay: Math.round(perDay),
    impactRupeesPer30Days: Math.round(perDay * 30),
    formula: `${i.spendPerDay} × ${share} × (${roasIfFixed} − ${i.roasNow})`,
    ...(perDay < 0
      ? { note: 'Negative: the "fixed" ROAS is below the current one' }
      : {}),
  };
}

// ---------------------------------------------------------------- anomaly

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Robust z-score (Iglewicz–Hoaglin): z = 0.6745 (x − median) / MAD; flag
 * |z| > 3.5. MAD = 0 (over half the points equal) falls back to the mean
 * absolute deviation × 1.2533; if that is 0 too nothing is flagged.
 */
export function anomalies(values: number[], threshold = 3.5) {
  if (values.length < 5) throw new Error('Need at least 5 values');
  const med = median(values);
  const dev = values.map((v) => Math.abs(v - med));
  const mad = median(dev);
  const meanAd = dev.reduce((s, v) => s + v, 0) / dev.length;
  const z = (v: number) =>
    mad > 0
      ? (0.6745 * (v - med)) / mad
      : meanAd > 0
        ? (v - med) / (1.2533 * meanAd)
        : 0;
  const flagged = values
    .map((v, index) => ({ index, value: v, z: round(z(v), 2) }))
    .filter((p) => Math.abs(p.z) > threshold);
  return { median: med, mad, threshold, flagged };
}

// ---------------------------------------------------------------- changepoint

/**
 * Single changepoint: the split minimising the summed squared error of the two
 * segments (each ≥ minSegment points). `index` = first point of the new
 * segment. Shift vs noise: t = |Δmean| / (pooled sd × √(1/n1 + 1/n2)); "large"
 * when t ≥ 3 — stricter than 1.96 because the best split was searched for.
 */
export function changepoint(values: number[], minSegment = 3) {
  const n = values.length;
  if (n < 2 * minSegment)
    throw new Error(`Need at least ${2 * minSegment} values`);
  const sse = (xs: number[]) => {
    const m = xs.reduce((s, v) => s + v, 0) / xs.length;
    return { m, e: xs.reduce((s, v) => s + (v - m) ** 2, 0) };
  };
  let best = { k: minSegment, e: Infinity, m1: 0, m2: 0 };
  for (let k = minSegment; k <= n - minSegment; k++) {
    const a = sse(values.slice(0, k));
    const b = sse(values.slice(k));
    if (a.e + b.e < best.e) best = { k, e: a.e + b.e, m1: a.m, m2: b.m };
  }
  const n1 = best.k;
  const n2 = n - best.k;
  const sd = Math.sqrt(best.e / (n - 2));
  const diff = best.m2 - best.m1;
  const t = sd > 0 ? Math.abs(diff) / (sd * Math.sqrt(1 / n1 + 1 / n2)) : null;
  const large = t == null ? diff !== 0 : t >= 3;
  return {
    index: best.k,
    beforeMean: round(best.m1),
    afterMean: round(best.m2),
    relChange: best.m1 ? round(diff / best.m1) : null,
    t: t == null ? null : round(t, 2),
    verdict: large ? 'large shift' : 'within noise',
  };
}
