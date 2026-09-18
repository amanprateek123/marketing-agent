import type { TrendData } from '../orchestrator/decision-context';

/** Three daily observations span two real elapsed calendar days. */
export const MIN_TREND_OBSERVATIONS = 3;
export const MIN_TREND_ELAPSED_DAYS = 2;
export const TREND_RECENT_WINDOW_DAYS = 7;
export const MIN_TREND_RECENT_COVERAGE_DAYS = 3;
export const MIN_TREND_RECENT_COVERAGE_RATIO = 0.6;
export const MAX_TREND_GAP_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TrendCoverage {
  /** Distinct UTC dates represented inside the trailing seven-day window. */
  recentCoverageDays: number;
  /** Observed UTC dates / possible dates from the oldest recent point to now. */
  recentCoverageRatio: number;
  /** Largest gap, in UTC calendar days, between adjacent observations. */
  maxGapDays: number;
}

const utcDayNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  const ms = date.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / MS_PER_DAY) : undefined;
};

/**
 * Measures whether daily observations are both recent and contiguous. A raw
 * count plus a long elapsed span is not enough: three points separated by a
 * 40-day hole cannot safely describe the campaign's current direction.
 */
export function calculateTrendCoverage(
  currentCollectedAt: unknown,
  historicalCollectedAt: unknown[],
): TrendCoverage {
  const currentDay = utcDayNumber(currentCollectedAt);
  if (currentDay === undefined) {
    return { recentCoverageDays: 0, recentCoverageRatio: 0, maxGapDays: 0 };
  }

  const days = [currentDay, ...historicalCollectedAt.map(utcDayNumber)]
    .filter((day): day is number => day !== undefined && day <= currentDay)
    .filter((day, index, all) => all.indexOf(day) === index)
    .sort((a, b) => a - b);

  // TrendReading uses at most seven observations. Measure gaps over that same
  // newest-seven evidence window so an ancient point no longer matters once
  // seven contiguous recent observations have replaced it.
  const evidenceWindowDays = days.slice(-TREND_RECENT_WINDOW_DAYS);
  let maxGapDays = 0;
  for (let index = 1; index < evidenceWindowDays.length; index += 1) {
    maxGapDays = Math.max(
      maxGapDays,
      evidenceWindowDays[index] - evidenceWindowDays[index - 1],
    );
  }

  const recentStart = currentDay - (TREND_RECENT_WINDOW_DAYS - 1);
  const recentDays = days.filter((day) => day >= recentStart);
  const oldestRecent = recentDays[0];
  const possibleRecentDays =
    oldestRecent === undefined
      ? TREND_RECENT_WINDOW_DAYS
      : currentDay - oldestRecent + 1;
  const recentCoverageRatio =
    possibleRecentDays > 0 ? recentDays.length / possibleRecentDays : 0;

  return {
    recentCoverageDays: recentDays.length,
    recentCoverageRatio: Number(recentCoverageRatio.toFixed(3)),
    maxGapDays,
  };
}

export function hasAdequateTrendCoverage(
  trend: Pick<
    TrendData,
    'recentCoverageDays' | 'recentCoverageRatio' | 'maxGapDays'
  >,
): boolean {
  return (
    typeof trend.recentCoverageDays === 'number' &&
    trend.recentCoverageDays >= MIN_TREND_RECENT_COVERAGE_DAYS &&
    typeof trend.recentCoverageRatio === 'number' &&
    trend.recentCoverageRatio >= MIN_TREND_RECENT_COVERAGE_RATIO &&
    typeof trend.maxGapDays === 'number' &&
    trend.maxGapDays <= MAX_TREND_GAP_DAYS
  );
}

/**
 * Fail closed for legacy slices that predate explicit calendar metadata.
 * Snapshot count alone is never evidence of elapsed time.
 */
export function hasEnoughElapsedTrendHistory(
  trend: Pick<
    TrendData,
    | 'observationCount'
    | 'windowElapsedDays'
    | 'trendReady'
    | 'recentCoverageDays'
    | 'recentCoverageRatio'
    | 'maxGapDays'
  >,
): boolean {
  if (trend.trendReady !== true) return false;
  return (
    typeof trend.observationCount === 'number' &&
    trend.observationCount >= MIN_TREND_OBSERVATIONS &&
    typeof trend.windowElapsedDays === 'number' &&
    trend.windowElapsedDays >= MIN_TREND_ELAPSED_DAYS &&
    hasAdequateTrendCoverage(trend)
  );
}
