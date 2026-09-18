/**
 * Deterministic trend math used by TrendEngine.
 * All functions are pure and return 0 for empty/invalid inputs.
 */

export function slope(series: readonly number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = series.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (series[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function ema(series: readonly number[], alpha: number): number {
  if (series.length === 0) return 0;
  let e = series[0];
  for (let i = 1; i < series.length; i++) {
    e = alpha * series[i] + (1 - alpha) * e;
  }
  return e;
}

export function velocity(series: readonly number[]): number {
  if (series.length < 2) return 0;
  const prev = series[series.length - 2];
  const last = series[series.length - 1];
  const denom = Math.max(Math.abs(prev), 1e-9);
  return (last - prev) / denom;
}

export function acceleration(series: readonly number[]): number {
  if (series.length < 6) return 0;
  const recent = series.slice(-3);
  const older = series.slice(-6, -3);
  return velocity(recent) - velocity(older);
}

export function volatility(series: readonly number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const mean = series.reduce((s, y) => s + y, 0) / n;
  if (mean === 0) return 0;
  const variance = series.reduce((s, y) => s + (y - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return stddev / Math.abs(mean);
}

export function zScore(series: readonly number[], x: number): number {
  const n = series.length;
  if (n < 2) return 0;
  const mean = series.reduce((s, y) => s + y, 0) / n;
  const variance = series.reduce((s, y) => s + (y - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (x - mean) / sd;
}

export function vsBaseline(series: readonly number[]): number {
  if (series.length < 2) return 0;
  const first = series[0];
  const last = series[series.length - 1];
  if (first === 0) return 0;
  return last / first;
}
