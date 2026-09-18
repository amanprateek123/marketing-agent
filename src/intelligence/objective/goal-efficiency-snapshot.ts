import { createHash } from 'node:crypto';
import type {
  MetricProvenance,
  MetricSet,
  SnapshotData,
} from '../snapshot/snapshot.types';
import type {
  GoalEfficiencyAttributionIdentity,
  GoalEfficiencyEntityLevel,
  GoalEfficiencyMetrics,
  GoalEfficiencyRow,
} from './goal-efficiency';

export interface BuildSnapshotGoalEfficiencyRowInput {
  snapshot: SnapshotData;
  level: GoalEfficiencyEntityLevel;
  entityId: string;
}

/**
 * Canonical Snapshot -> GoalEfficiencyRow mapping.
 *
 * It performs identity-preserving adaptation only. The pure goal-efficiency
 * contract remains authoritative for availability, provenance and evidence
 * floors. Null means the exact entity/parent/metrics relationship is absent;
 * an incomplete row is still returned so the contract can explain why it is
 * unavailable without inventing fallback data.
 */
export function buildSnapshotGoalEfficiencyRow(
  input: BuildSnapshotGoalEfficiencyRowInput,
): GoalEfficiencyRow | null {
  const { snapshot, level } = input;
  const entityId = clean(input.entityId);
  const campaign = snapshot.entities?.campaign;
  if (!entityId || !campaign) return null;

  let parentId: string | null;
  let optimizationGoal: string | null;
  let effectiveStatus: string;
  let metrics: MetricSet | undefined;

  if (level === 'adset') {
    const entity = snapshot.entities?.adSets?.[entityId];
    metrics = snapshot.metrics?.adSetLevel?.[entityId];
    parentId = clean(campaign.id);
    optimizationGoal = clean(entity?.optimizationGoal);
    effectiveStatus = exactStatus(entity);
    if (!entity || !metrics) return null;
  } else {
    const entity = snapshot.entities?.ads?.[entityId];
    metrics = snapshot.metrics?.adLevel?.[entityId];
    parentId = clean(entity?.adSetId);
    if (!entity || !metrics || !parentId) return null;
    const parent = snapshot.entities?.adSets?.[parentId];
    if (!parent) return null;
    optimizationGoal = clean(parent.optimizationGoal);
    effectiveStatus = exactStatus(entity);
  }

  if (!parentId || !optimizationGoal) return null;
  const provenance = metrics.provenance;
  const exactActionTypes = exactActionTypesOrNull(
    provenance?.revenueAttributionActionTypes,
  );
  const exactConversions = exactActionTypes
    ? sumExactActionCounts(
        provenance?.goalResultInputs?.actionCounts,
        exactActionTypes,
      )
    : undefined;

  return {
    entityId,
    parentId,
    level,
    effectiveStatus,
    objective:
      clean(campaign.objective) ?? clean(snapshot.meta?.objective) ?? '',
    optimizationGoal,
    metrics: mapExactMetrics(metrics, exactConversions),
    provenance: {
      // Preserved/legacy rows are not current observed evidence, even if an
      // older boolean survived on the document.
      rowObserved:
        provenance?.rowObserved === true && provenance.state === 'observed',
      responseComplete: provenance?.fetchComplete === true,
      dateStart: clean(provenance?.dateStart) ?? '',
      dateStop: clean(provenance?.dateStop) ?? '',
      metricScope: clean(snapshot.meta?.metricScope) ?? '',
      metricsSyncedAt: provenance?.metricsSyncedAt ?? '',
      freshnessSec: rowFreshnessSec(
        provenance?.metricsSyncedAt,
        snapshot.collectedAt,
      ),
      source: clean(provenance?.source) ?? '',
      sourceFingerprint: clean(provenance?.sourceFingerprint) ?? '',
      currency: clean(provenance?.currency) ?? '',
      attribution: buildAttributionIdentity(provenance, exactActionTypes),
    },
  };
}

/** Deterministic row ordering keeps persisted/debug evidence reproducible. */
export function buildSnapshotGoalEfficiencyRows(
  snapshot: SnapshotData,
  level: GoalEfficiencyEntityLevel,
): GoalEfficiencyRow[] {
  const ids = Object.keys(
    level === 'adset'
      ? (snapshot.metrics?.adSetLevel ?? {})
      : (snapshot.metrics?.adLevel ?? {}),
  ).sort();
  return ids
    .map((entityId) =>
      buildSnapshotGoalEfficiencyRow({ snapshot, level, entityId }),
    )
    .filter((row): row is GoalEfficiencyRow => row !== null);
}

function mapExactMetrics(
  source: MetricSet,
  exactConversions: number | undefined,
): GoalEfficiencyMetrics {
  const metrics: GoalEfficiencyMetrics = {};
  copyOwnFinite(source, metrics, 'spend', 'spend');
  copyOwnFinite(source, metrics, 'reach', 'reach');
  copyOwnFinite(source, metrics, 'impressions', 'impressions');
  copyOwnFinite(source, metrics, 'landingPageViews', 'landingPageViews');
  copyOwnFinite(source, metrics, 'inlineLinkClicks', 'inlineLinkClicks');
  copyOwnFinite(source, metrics, 'thruplay', 'thruplay');
  const rawMetaActionValue = ownFiniteNonNegative(
    source.provenance,
    'rawMetaActionValueGross',
  );
  if (rawMetaActionValue !== undefined) {
    metrics.rawMetaActionValue = rawMetaActionValue;
  }
  if (exactConversions !== undefined) {
    metrics.exactConversions = exactConversions;
  }
  return metrics;
}

function buildAttributionIdentity(
  provenance: MetricProvenance | undefined,
  actionTypes: string[] | null,
): GoalEfficiencyAttributionIdentity | null {
  const attributionSource = clean(provenance?.revenueAttributionSource);
  if (!provenance || !attributionSource || !actionTypes) return null;
  const attributionSpec = provenance.attributionSpec;
  if (attributionSpec === undefined || attributionSpec === null) return null;

  const attributionSpecHash = hashStable(attributionSpec);
  const conversionEventIdentity = hashStable({
    attributionSource,
    actionTypes,
    promotedObject: provenance.promotedObject ?? null,
  });
  if (!attributionSpecHash || !conversionEventIdentity) return null;

  return {
    attributionSource,
    conversionEventIdentity,
    actionTypes,
    attributionSpecHash,
    valueBasis: clean(provenance.revenueBasis) ?? undefined,
  };
}

function sumExactActionCounts(
  actionCounts: Record<string, number> | undefined,
  actionTypes: string[],
): number | undefined {
  if (!actionCounts) return undefined;
  let total = 0;
  for (const actionType of actionTypes) {
    if (!Object.prototype.hasOwnProperty.call(actionCounts, actionType)) {
      return undefined;
    }
    const value = actionCounts[actionType];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    total += value;
  }
  return Number.isFinite(total) ? total : undefined;
}

function exactActionTypesOrNull(input: string[] | undefined): string[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const cleaned = input.map(clean);
  if (cleaned.some((value) => value === null)) return null;
  const values = cleaned as string[];
  const unique = [...new Set(values)].sort();
  return unique.length === values.length ? unique : null;
}

function rowFreshnessSec(
  metricsSyncedAt: Date | undefined,
  collectedAt: Date,
): number {
  const syncedMs = dateMs(metricsSyncedAt);
  const collectedMs = dateMs(collectedAt);
  if (syncedMs === null || collectedMs === null || collectedMs < syncedMs) {
    return Number.NaN;
  }
  return Math.round((collectedMs - syncedMs) / 1000);
}

function exactStatus(entity?: {
  status?: string;
  effectiveStatus?: string;
}): string {
  return clean(entity?.effectiveStatus) ?? clean(entity?.status) ?? '';
}

function copyOwnFinite<
  SourceKey extends keyof MetricSet,
  TargetKey extends keyof GoalEfficiencyMetrics,
>(
  source: MetricSet,
  target: GoalEfficiencyMetrics,
  sourceKey: SourceKey,
  targetKey: TargetKey,
): void {
  const value = ownFiniteNonNegative(source, sourceKey);
  if (value !== undefined) {
    target[targetKey] = value;
  }
}

function ownFiniteNonNegative<T extends object>(
  source: T | undefined,
  key: keyof T,
): number | undefined {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function hashStable(value: unknown): string | null {
  try {
    return createHash('sha256').update(stableSerialize(value)).digest('hex');
  } catch {
    return null;
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('unserializable provenance');
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(',')}}`;
}

function dateMs(value: Date | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const milliseconds = value.getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
