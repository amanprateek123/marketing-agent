/**
 * Source metrics older than one hour are observation-only. They can still be
 * shown in a trace, but they must not unlock a new recommendation or an
 * execution-ready state.
 */
export const MAX_ACTIONABLE_SOURCE_FRESHNESS_SEC = 60 * 60;

export function isSourceMetricsFresh(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < MAX_ACTIONABLE_SOURCE_FRESHNESS_SEC
  );
}

export function sourceFreshnessLabel(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 'unknown';
  }
  if (value < 60) return `${Math.round(value)} seconds`;
  if (value < 60 * 60) return `${Math.round(value / 60)} minutes`;
  return `${(value / (60 * 60)).toFixed(1)} hours`;
}
