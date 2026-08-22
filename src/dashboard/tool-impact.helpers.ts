import {
  DashboardCampaignRow,
  ToolImpactCohortStageCounts,
  ToolImpactDurationStats,
  ToolImpactOverview,
  ToolImpactOwnership,
  ToolImpactScope,
} from './dashboard.types';

export const TOOL_IMPACT_MATURITY_DAYS = 7;

type CampaignLike = {
  _id?: unknown;
  name?: string | null;
  source?: string;
  metaCampaignId?: string | null;
  launchedAt?: Date | string | null;
  spend?: number | null;
};

/**
 * Some campaigns the marketing team created directly in Meta happen to have
 * names matching this old deterministic pattern (real example: a manual
 * campaign named "AGENT_LANDING_PAGE_TEST_NADI_REPORT_2026-06-29", ₹30,605
 * spend, source='manual' — never launched by this tool). This constant is
 * kept only as a DIAGNOSTIC signal (surfaced in the exclusion ledger as
 * "worth reviewing"), never as ownership evidence: ownership is decided
 * exclusively by the persisted `source` field. A naming coincidence is not
 * proof, and crediting the tool's track record on a guess is exactly the
 * class of mistake this whole page exists to catch, not repeat. If a
 * specific historical campaign really was tool-launched, fix its `source`
 * field — don't infer it here.
 */
export const LEGACY_AGENT_META_NAME =
  /^AGENT_[A-Z0-9][A-Z0-9_]*_\d{4}-\d{2}-\d{2}(?:_\d{4}-\d{2}-\d{2})?(?:[\s-]+TAT)?$/i;

export function classifyToolOwnership(
  campaign: CampaignLike,
): ToolImpactOwnership | null {
  if (campaign.source === 'agent') {
    return {
      actor: 'agent',
      evidence: 'persisted_agent_source',
      confidence: 'recorded',
    };
  }
  if (campaign.source === 'human') {
    return {
      actor: 'human',
      evidence: 'persisted_human_source',
      confidence: 'recorded',
    };
  }
  return null;
}

/** Manual campaign whose name coincidentally matches the old agent-name
 *  pattern — surfaced as a "worth reviewing" diagnostic, never as ownership. */
export function isNameCoincidenceWorthReviewing(
  campaign: CampaignLike,
): boolean {
  return (
    campaign.source === 'manual' &&
    LEGACY_AGENT_META_NAME.test(String(campaign.name ?? '').trim())
  );
}

export function isVerifiedToolLaunch(campaign: CampaignLike): boolean {
  return (
    classifyToolOwnership(campaign) != null &&
    String(campaign.metaCampaignId ?? '').trim().length > 0 &&
    isValidDate(campaign.launchedAt)
  );
}

export function campaignIsMature(
  campaign: CampaignLike,
  now: Date,
  maturityDays = TOOL_IMPACT_MATURITY_DAYS,
): boolean {
  if (!isVerifiedToolLaunch(campaign) || number(campaign.spend) <= 0) {
    return false;
  }
  const launchedAt = new Date(campaign.launchedAt as Date | string);
  return now.getTime() - launchedAt.getTime() >= maturityDays * 86_400_000;
}

export function buildToolImpactCohort(
  campaigns: CampaignLike[],
  scope: ToolImpactScope,
  now: Date,
  maturityDays = TOOL_IMPACT_MATURITY_DAYS,
): {
  selected: CampaignLike[];
  launched: CampaignLike[];
  withSpend: CampaignLike[];
  mature: CampaignLike[];
  summary: Omit<ToolImpactOverview['cohort'], 'campaigns'>;
} {
  const ownershipAllowed = (campaign: CampaignLike) => {
    const ownership = classifyToolOwnership(campaign);
    return (
      ownership?.actor === 'agent' ||
      (scope === 'managed' && ownership?.actor === 'human')
    );
  };
  const selected = campaigns.filter(ownershipAllowed);
  const launched = selected.filter(isVerifiedToolLaunch);
  const withSpend = launched.filter((c) => number(c.spend) > 0);
  const mature = withSpend.filter((c) =>
    campaignIsMature(c, now, maturityDays),
  );

  const sourceStages = (
    source: 'agent' | 'human',
  ): ToolImpactCohortStageCounts => {
    const actorIsSource = (campaign: CampaignLike) =>
      classifyToolOwnership(campaign)?.actor === source;
    const createdForSource = selected.filter(actorIsSource);
    const launchedForSource = launched.filter(actorIsSource);
    const spendForSource = withSpend.filter(actorIsSource);
    return {
      created: createdForSource.length,
      launched: launchedForSource.length,
      withSpend: spendForSource.length,
      mature: mature.filter(actorIsSource).length,
    };
  };

  // Within each funnel transition these reason counts are mutually exclusive
  // — EXCEPT 'manual_source_name_coincidence', which is a diagnostic overlay
  // on top of 'manual_source' (every campaign it counts is already counted
  // there too), not an additional funnel stage. Exclude that one code when
  // reconciling exclusions + mature against the total population.
  // A selected campaign missing both launch fields is assigned to the first
  // failed predicate (Meta id), so the gap can be reconciled exactly.
  const missingMeta = selected.filter(
    (c) => String(c.metaCampaignId ?? '').trim().length === 0,
  );
  const missingLaunchDate = selected.filter(
    (c) =>
      String(c.metaCampaignId ?? '').trim().length > 0 &&
      !isValidDate(c.launchedAt),
  );
  const zeroSpend = launched.filter((c) => number(c.spend) <= 0);
  const notMature = withSpend.filter(
    (c) => !campaignIsMature(c, now, maturityDays),
  );

  return {
    selected,
    launched,
    withSpend,
    mature,
    summary: {
      created: selected.length,
      launched: launched.length,
      withSpend: withSpend.length,
      mature: mature.length,
      maturityDays,
      bySource: {
        agent: sourceStages('agent'),
        human: sourceStages('human'),
      },
      ownershipEvidence: {
        persistedAgentSource: selected.filter(
          (campaign) =>
            classifyToolOwnership(campaign)?.evidence ===
            'persisted_agent_source',
        ).length,
        persistedHumanSource: selected.filter(
          (campaign) =>
            classifyToolOwnership(campaign)?.evidence ===
            'persisted_human_source',
        ).length,
        // Always 0 now — ownership is never name-inferred. Kept as a field
        // (rather than removed) so old snapshots/clients don't break on a
        // missing key; see isNameCoincidenceWorthReviewing for the real signal.
        legacyAgentName: 0,
      },
      exclusions: [
        {
          code: 'manual_source',
          stage: 'scope',
          count: campaigns.filter((c) => c.source === 'manual').length,
          description:
            'Created directly in Meta and imported for observation; never credited to this tool, regardless of naming.',
        },
        {
          code: 'manual_source_name_coincidence',
          stage: 'scope',
          count: campaigns.filter(isNameCoincidenceWorthReviewing).length,
          description:
            'Manual (marketing-team) campaign whose Meta name happens to match the old AGENT_<topic>_<date> convention. Not counted as tool-owned — a name is not provenance — but worth a human checking whether its source field was ever miscategorized.',
        },
        {
          code: 'unrecognized_source',
          stage: 'scope',
          count: campaigns.filter(
            (c) =>
              c.source !== 'agent' &&
              c.source !== 'human' &&
              c.source !== 'manual' &&
              classifyToolOwnership(c) == null,
          ).length,
          description:
            'Missing or unknown provenance; excluded because the tool cannot prove ownership.',
        },
        {
          code: 'human_outside_agent_scope',
          stage: 'scope',
          count:
            scope === 'agent'
              ? campaigns.filter(
                  (c) => classifyToolOwnership(c)?.actor === 'human',
                ).length
              : 0,
          description:
            'Created by a person through the dashboard; excluded from the autonomous-agent headline.',
        },
        {
          code: 'missing_meta_campaign_id',
          stage: 'verified_launch',
          count: missingMeta.length,
          description:
            'Created in the product but no non-empty Meta campaign id proves launch.',
        },
        {
          code: 'missing_launched_at',
          stage: 'verified_launch',
          count: missingLaunchDate.length,
          description:
            'Has a Meta campaign id but no valid launch timestamp; not counted as a verified launch.',
        },
        {
          code: 'zero_spend',
          stage: 'with_spend',
          count: zeroSpend.length,
          description:
            'Verified launch with no recorded ad spend; retained in launch count but excluded from spend maturity.',
        },
        {
          code: 'not_mature',
          stage: 'mature',
          count: notMature.length,
          description: `Has spend but is younger than the declared D${maturityDays} observation window.`,
        },
      ],
    },
  };
}

export function buildRawRoasOutcome(
  rows: DashboardCampaignRow[],
): ToolImpactOverview['launched']['rawOutcome'] {
  // ROAS only means something for a campaign that was actually asked to
  // drive purchases — the same principle dashboard.service.ts's rollUp()
  // already applies account-wide ("Including awareness/app-promotion/
  // traffic spend in the denominator would drag the headline down with money
  // that was never supposed to come back as tracked purchases). Blending
  // a ₹0-return Awareness campaign into the numerator/denominator here
  // isn't a neutral "complete portfolio test" — it's grading spend against
  // a goal nobody gave it, and makes the sales-objective spend look worse
  // than it is. Sales-only for the headline math; non-sales spend is
  // reported separately, never folded into ROAS. The headline is narrower
  // again: only sales rows with resolved Meta/no-attributed-return evidence
  // enter the proof numerator and denominator; modeled or unresolved rows are
  // disclosed as excluded coverage.
  const measuredRows = rows.filter((row) => row.spend > 0);
  const strictSalesObjectives = new Set([
    'OUTCOME_SALES',
    'SALES',
    'CONVERSIONS',
    'OUTCOME_CONVERSIONS',
    'PRODUCT_CATALOG_SALES',
    'CATALOG_SALES',
    'OUTCOME_CATALOG_SALES',
    'RETARGETING',
    'RETARGETING_SALES',
  ]);
  const isStrictSales = (row: DashboardCampaignRow) =>
    strictSalesObjectives.has(
      String(row.objective ?? '')
        .trim()
        .toUpperCase(),
    );
  const salesRows = measuredRows.filter(isStrictSales);
  const nonSalesRows = measuredRows.filter((row) => !isStrictSales(row));
  const proofRows = salesRows.filter(
    (row) =>
      (row.revenueBasis === 'meta_action_value' ||
        row.revenueBasis === 'no_attributed_revenue') &&
      row.revenueAttributionSource !== 'unknown' &&
      row.revenueAttributionSource !== 'unresolved' &&
      row.revenueAttributionSource !== 'account_fallback',
  );
  const excludedSalesRows = salesRows.filter((row) => !proofRows.includes(row));
  const spend = sum(proofRows.map((row) => row.spend));
  const attributedReturn = sum(proofRows.map((row) => row.revenue));
  const weightedRoas = spend > 0 ? attributedReturn / spend : 0;
  const revenueBasis = (
    [
      'meta_action_value',
      'configured_conversion_value',
      'no_attributed_revenue',
      'unknown',
    ] as const
  ).map((basis) => {
    const basisRows = salesRows.filter((row) => row.revenueBasis === basis);
    const basisSpend = sum(basisRows.map((row) => row.spend));
    const basisRevenue = sum(basisRows.map((row) => row.revenue));
    return {
      basis,
      campaignCount: basisRows.length,
      spend: round(basisSpend, 2),
      revenue: round(basisRevenue, 2),
      weightedRoas: basisSpend > 0 ? round(basisRevenue / basisSpend, 6) : 0,
    };
  });

  const returnSurplus = round(attributedReturn - spend, 2);
  const returnPosition =
    spend <= 0
      ? 'no_spend'
      : returnSurplus === 0
        ? 'equal'
        : returnSurplus > 0
          ? 'above'
          : 'below';

  // Non-sales campaigns don't share one KPI unit (CPM for awareness, CPC
  // for traffic, ...) — blending them into a single "average" would repeat
  // the exact mistake this function exists to avoid. Grouped by objective
  // instead; each group's own weighted result (never a naive average).
  const nonSalesByObjective = new Map<
    string,
    { objectiveLabel: string; rows: DashboardCampaignRow[] }
  >();
  for (const row of nonSalesRows) {
    const objectiveKey = row.objectiveKey ?? 'unknown';
    const group = nonSalesByObjective.get(objectiveKey) ?? {
      objectiveLabel: row.objectiveLabel ?? 'Other',
      rows: [],
    };
    group.rows.push(row);
    nonSalesByObjective.set(objectiveKey, group);
  }
  const nonSales = {
    campaigns: nonSalesRows.length,
    spend: round(sum(nonSalesRows.map((row) => row.spend)), 2),
    byObjective: [...nonSalesByObjective.entries()].map(
      ([objectiveKey, group]) => {
        const groupSpend = sum(group.rows.map((row) => row.spend));
        const groupClicks = sum(group.rows.map((row) => row.clicks ?? 0));
        const groupImpressions = sum(
          group.rows.map((row) => row.impressions ?? 0),
        );
        // Every row in a group shares one primaryKpi.key (same objective),
        // so its direction/label are safe to read off the first row —
        // recomputing the weighted value from raw totals, not averaging
        // each row's own already-computed per-campaign KPI value.
        const sample = group.rows[0].primaryKpi as
          | DashboardCampaignRow['primaryKpi']
          | undefined;
        const weightedValue =
          sample?.key === 'cpc' && groupClicks > 0
            ? groupSpend / groupClicks
            : sample?.key === 'cpm' && groupImpressions > 0
              ? (groupSpend / groupImpressions) * 1000
              : null;
        return {
          objectiveKey,
          objectiveLabel: group.objectiveLabel,
          campaignCount: group.rows.length,
          spend: round(groupSpend, 2),
          primaryKpiLabel: sample?.label ?? 'Result',
          weightedValue: weightedValue == null ? null : round(weightedValue, 2),
          weightedDisplay:
            weightedValue == null ? 'n/a' : `₹${weightedValue.toFixed(2)}`,
        };
      },
    ),
  };

  return {
    campaigns: rows.length,
    campaignsWithSpend: measuredRows.length,
    // Distinct from campaignsWithSpend above (which counts sales + non-sales
    // together): `spend`/`attributedReturn`/`weightedRoas` below are
    // sales-only, so the campaign count next to them must match that same
    // population or the tile reads "₹X across Y campaigns" with Y counting
    // campaigns that contributed nothing to X.
    salesCampaignsWithSpend: salesRows.length,
    resolvedSalesCampaignsWithSpend: proofRows.length,
    excludedSalesCampaignsWithSpend: excludedSalesRows.length,
    excludedSalesSpend: round(
      sum(excludedSalesRows.map((row) => row.spend)),
      2,
    ),
    returnCoverage:
      salesRows.length === 0
        ? 'no_sales_spend'
        : proofRows.length === 0
          ? 'unavailable'
          : proofRows.length === salesRows.length
            ? 'complete'
            : 'partial',
    spend: round(spend, 2),
    attributedReturn: round(attributedReturn, 2),
    revenueBasis,
    containsModeledOrUnknownRevenue: revenueBasis.some(
      (entry) =>
        entry.campaignCount > 0 &&
        (entry.basis === 'configured_conversion_value' ||
          entry.basis === 'unknown'),
    ),
    // Keep enough precision for the 1.0x boundary. Rounding 0.9996 to 1.000
    // while retaining a negative surplus creates a contradictory founder UI.
    weightedRoas: round(weightedRoas, 6),
    returnSurplus,
    returnPosition,
    metOneXActionValueThreshold:
      returnPosition === 'above' || returnPosition === 'equal',
    thresholdRule: 'weighted_attributed_roas_gte_1',
    nonSalesCampaigns: nonSalesRows.length,
    nonSalesSpend: round(sum(nonSalesRows.map((row) => row.spend)), 2),
    nonSales,
  };
}

export function durationStats(
  durationsHours: number[],
  basis: string,
): ToolImpactDurationStats {
  const values = durationsHours
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return {
    sampleSize: values.length,
    medianHours: values.length ? round(percentile(values, 0.5), 2) : null,
    p90Hours: values.length ? round(percentile(values, 0.9), 2) : null,
    basis,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function isValidDate(value: unknown): boolean {
  if (!value) return false;
  return Number.isFinite(new Date(value as Date | string).getTime());
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
