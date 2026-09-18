/**
 * Valid Meta `optimization_goal` values this app is allowed to set on an ad
 * set. Single source of truth so CampaignCreatorService's LLM-output
 * normalization and CampaignOptimizerService's operator-chosen override on
 * addAdSet never drift on what's acceptable — see the matching pattern in
 * placement-presets.ts.
 */
export const VALID_OPTIMIZATION_GOALS = new Set([
  'OFFSITE_CONVERSIONS',
  'VALUE',
  'LANDING_PAGE_VIEWS',
  'LINK_CLICKS',
  'IMPRESSIONS',
  'REACH',
  'THRUPLAY',
  'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS',
  'POST_ENGAGEMENT',
  'PAGE_LIKES',
  'AD_RECALL_LIFT',
  'LEAD_GENERATION',
  'QUALITY_LEAD',
  'QUALITY_CALL',
  'APP_INSTALLS',
]);

export function defaultOptimizationGoalForObjective(objective: string): string {
  switch (objective) {
    case 'OUTCOME_AWARENESS':
      return 'AD_RECALL_LIFT';
    case 'OUTCOME_TRAFFIC':
      return 'LANDING_PAGE_VIEWS';
    case 'OUTCOME_ENGAGEMENT':
      return 'POST_ENGAGEMENT';
    case 'OUTCOME_APP_PROMOTION':
      return 'APP_INSTALLS';
    case 'OUTCOME_LEADS':
    case 'OUTCOME_SALES':
    default:
      return 'OFFSITE_CONVERSIONS';
  }
}

/** Product-level VBB is a sales-conversion setting, not a global override. */
export function resolveOptimizationGoalForLaunch(input: {
  objective: string;
  requested?: string;
  productGoal?: string;
}): string {
  if (
    input.objective === 'OUTCOME_SALES' &&
    input.productGoal &&
    VALID_OPTIMIZATION_GOALS.has(input.productGoal)
  ) {
    return input.productGoal;
  }
  if (input.requested && VALID_OPTIMIZATION_GOALS.has(input.requested)) {
    return input.requested;
  }
  return defaultOptimizationGoalForObjective(input.objective);
}
