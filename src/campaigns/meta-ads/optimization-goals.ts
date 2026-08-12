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
