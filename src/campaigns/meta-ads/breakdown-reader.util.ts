import { Model } from 'mongoose';
import { BreakdownSnapshotDocument } from '../schemas/breakdown-snapshot.schema';

/**
 * Reads campaign-level BreakdownSnapshot rollup docs (written by
 * meta-deep-sync.service.ts, hourly cadence) instead of the old audit loop's
 * own live Meta calls (meta-metrics.service.ts's fetchPlacementBreakdown /
 * fetchHourlyBreakdown / fetchDayOfWeekBreakdown) — same precedent
 * signal-engine.service.ts's placement_leak rule already uses ("this data
 * already exists, no reason to hit the API again").
 *
 * Windows differ from the old live fetches: placement/hourly move from
 * lifetime/last_14d to last_30d; day-of-week moves from last_14d to
 * up-to-last_90d (whatever metric_timeseries has accumulated). Output shapes
 * match the old fetch* methods exactly so downstream consumers
 * (signal-detector's pure passthrough, audit-agent's prompt rendering) don't
 * need to change.
 */

export interface PlacementBreakdownRow {
  publisherPlatform: string;
  platformPosition: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpa: number;
}

export interface HourlyBreakdownRow {
  hourOfDay: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpa: number;
}

export interface DayOfWeekBreakdownRow {
  dayOfWeek: number; // 0=Sun, 6=Sat
  dayLabel: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cvr: number;
  cpa: number;
}

const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function readPlacementBreakdown(
  breakdownModel: Model<BreakdownSnapshotDocument>,
  tenantId: string,
  metaCampaignId: string,
): Promise<PlacementBreakdownRow[]> {
  const doc = await breakdownModel
    .findOne({ tenantId, entityId: metaCampaignId, breakdownType: 'placement', level: 'campaign' })
    .lean()
    .exec();
  if (!doc?.rows?.length) return [];

  // deep-sync's placement breakdown adds a devicePlatform dimension the old
  // fetch never had — re-aggregate it away so publisherPlatform+platformPosition
  // stays the same grain the audit-agent prompt's thresholds were tuned against.
  const byKey = new Map<string, PlacementBreakdownRow>();
  for (const row of doc.rows) {
    const publisherPlatform = row.keys.publisherPlatform ?? 'unknown';
    const platformPosition = row.keys.platformPosition ?? 'unknown';
    const key = `${publisherPlatform}|${platformPosition}`;
    const agg = byKey.get(key) ?? {
      publisherPlatform, platformPosition,
      spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpa: 0,
    };
    agg.spend += row.spend;
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
    agg.conversions += row.conversions;
    byKey.set(key, agg);
  }
  return [...byKey.values()].map((r) => ({
    ...r,
    ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
    cpa: r.conversions > 0 ? r.spend / r.conversions : 0,
  }));
}

export async function readHourlyBreakdown(
  breakdownModel: Model<BreakdownSnapshotDocument>,
  tenantId: string,
  metaCampaignId: string,
): Promise<HourlyBreakdownRow[]> {
  const doc = await breakdownModel
    .findOne({ tenantId, entityId: metaCampaignId, breakdownType: 'hourly', level: 'campaign' })
    .lean()
    .exec();
  if (!doc?.rows?.length) return [];
  return doc.rows.map((row) => ({
    hourOfDay: row.keys.hour ?? 'unknown',
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    ctr: row.ctr,
    cpa: row.cpa,
  }));
}

export async function readDayOfWeekBreakdown(
  breakdownModel: Model<BreakdownSnapshotDocument>,
  tenantId: string,
  metaCampaignId: string,
): Promise<DayOfWeekBreakdownRow[]> {
  const doc = await breakdownModel
    .findOne({ tenantId, entityId: metaCampaignId, breakdownType: 'dow', level: 'campaign' })
    .lean()
    .exec();
  if (!doc?.rows?.length) return [];
  return doc.rows.map((row) => {
    const dayName = (row.keys.dow ?? '').toLowerCase();
    const dayOfWeek = DAY_NAME_TO_INDEX[dayName] ?? 0;
    // cvr isn't stored on BreakdownSnapshot rows — derive it, matching the
    // old fetchDayOfWeekBreakdown's own cvr = conversions/clicks*100.
    return {
      dayOfWeek,
      dayLabel: DAY_LABELS[dayOfWeek],
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      ctr: row.ctr,
      cvr: row.clicks > 0 ? (row.conversions / row.clicks) * 100 : 0,
      cpa: row.cpa,
    };
  });
}
