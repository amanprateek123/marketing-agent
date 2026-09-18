import { Injectable } from '@nestjs/common';
import { SnapshotData } from './snapshot.types';
import {
  isSourceMetricsFresh,
  MAX_ACTIONABLE_SOURCE_FRESHNESS_SEC,
} from './snapshot-freshness';

export interface ValidationResult {
  ok: boolean;
  missingFields: string[];
  warnings: string[];
  scores: {
    completeness: number; // 0..1
    freshness: number; // 0..1
    metaStatus: number; // 0..1
  };
}

/**
 * Pure evaluation of SnapshotData. No I/O. Confidence Engine consumes
 * scores; Snapshot Engine uses them to compute its own EngineContext
 * confidence.
 */
@Injectable()
export class SnapshotValidator {
  // Fields expected on every "active" campaign snapshot. Missing fields
  // penalize completeness proportionally.
  private static readonly EXPECTED_CAMPAIGN_FIELDS = [
    'spend',
    'impressions',
    'clicks',
    'ctr',
    'frequency',
  ] as const;

  validate(snapshot: SnapshotData): ValidationResult {
    const missing = [...snapshot.missingFields];
    const warnings: string[] = [];

    if (!isSourceMetricsFresh(snapshot.freshnessSec))
      warnings.push('stale_snapshot');
    if (
      Object.keys(snapshot.metrics.adLevel).length === 0 &&
      Object.keys(snapshot.metrics.adSetLevel).length > 0
    ) {
      warnings.push('ad_breakdown_missing');
    }
    if (
      snapshot.metrics.campaignLevel.revenue === 0 &&
      snapshot.metrics.campaignLevel.purchases > 0
    ) {
      warnings.push('revenue_zero_but_purchases_present');
    }

    const completeness = this.scoreCompleteness(missing);
    const freshness = this.scoreFreshness(snapshot.freshnessSec);
    const metaStatus = this.scoreMetaStatus(snapshot.meta.deliveryStatus);

    return {
      ok: missing.length === 0,
      missingFields: missing,
      warnings,
      scores: { completeness, freshness, metaStatus },
    };
  }

  /**
   * Aggregate confidence per the Snapshot Engine guide §10:
   *   0.5 * completeness + 0.3 * freshness + 0.2 * meta_status.
   */
  confidence(result: ValidationResult): number {
    return (
      0.5 * result.scores.completeness +
      0.3 * result.scores.freshness +
      0.2 * result.scores.metaStatus
    );
  }

  private scoreCompleteness(missing: string[]): number {
    const totalExpected = SnapshotValidator.EXPECTED_CAMPAIGN_FIELDS.length;
    const overlap = missing.filter((f) =>
      (
        SnapshotValidator.EXPECTED_CAMPAIGN_FIELDS as readonly string[]
      ).includes(f),
    ).length;
    return Math.max(0, 1 - overlap / totalExpected);
  }

  /** 1.0 while ≤ 15 min old, decays to 0 at 60 min. */
  private scoreFreshness(freshnessSec: number): number {
    if (!Number.isFinite(freshnessSec) || freshnessSec < 0) return 0;
    if (freshnessSec <= 900) return 1;
    if (freshnessSec >= MAX_ACTIONABLE_SOURCE_FRESHNESS_SEC) return 0;
    return (
      1 - (freshnessSec - 900) / (MAX_ACTIONABLE_SOURCE_FRESHNESS_SEC - 900)
    );
  }

  private scoreMetaStatus(status?: string): number {
    if (!status) return 0.5;
    return status.toUpperCase() === 'ACTIVE' ? 1 : 0.5;
  }
}
