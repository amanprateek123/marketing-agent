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
 * Before Campaign.source was persisted consistently, autonomous launches were
 * deliberately given this deterministic Meta name (see campaign-creator and
 * meta-campaign-name.util). Keep the matcher strict: a generic occurrence of
 * "agent" is not ownership evidence.
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
  if (
    campaign.source === 'manual' &&
    LEGACY_AGENT_META_NAME.test(String(campaign.name ?? '').trim())
  ) {
    return {
      actor: 'agent',
      evidence: 'legacy_agent_name',
      confidence: 'name_inferred',
    };
  }
  return null;
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

  // Within each funnel transition these reason counts are mutually exclusive:
  // a selected campaign missing both launch fields is assigned to the first
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
        legacyAgentName: selected.filter(
          (campaign) =>
            classifyToolOwnership(campaign)?.evidence === 'legacy_agent_name',
        ).length,
      },
      exclusions: [
        {
          code: 'manual_source',
          stage: 'scope',
          count: campaigns.filter(
            (c) => c.source === 'manual' && classifyToolOwnership(c) == null,
          ).length,
          description:
            'Created directly in Meta and imported for observation; excludes legacy rows that match Meridian’s deterministic AGENT_<topic>_<date> marker.',
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
  // This is deliberately a complete portfolio action-value test, not an
  // objective scorecard or proof of ledger cash:
  // every verified campaign that spent money belongs in both numerator and
  // denominator. Excluding awareness/traffic spend would flatter the claim
  // "what Meridian spent versus what Meta/configuration attributed".
  const measuredRows = rows.filter((row) => row.spend > 0);
  const nonSalesRows = measuredRows.filter((row) => !row.isRevenueObjective);
  const spend = sum(measuredRows.map((row) => row.spend));
  const attributedReturn = sum(measuredRows.map((row) => row.revenue));
  const weightedRoas = spend > 0 ? attributedReturn / spend : 0;
  const revenueBasis = (
    [
      'meta_action_value',
      'configured_conversion_value',
      'no_attributed_revenue',
      'unknown',
    ] as const
  ).map((basis) => {
    const basisRows = measuredRows.filter((row) => row.revenueBasis === basis);
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

  return {
    campaigns: rows.length,
    campaignsWithSpend: measuredRows.length,
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
