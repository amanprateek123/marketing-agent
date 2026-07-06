import { ObjectiveData, ObjectiveKey } from '../orchestrator/decision-context';

export type ObjectiveProfile = Pick<
  ObjectiveData,
  'objective' | 'primaryKPI' | 'supportingKPIs' | 'weights' | 'thresholds' | 'policy'
>;

const P = <T extends ObjectiveProfile>(x: T) => x;

export const SALES_PROFILE = P({
  objective: 'sales',
  primaryKPI: 'roas',
  supportingKPIs: ['cvr', 'aov', 'ctr'],
  weights: { roas: 0.5, cvr: 0.2, aov: 0.15, ctr: 0.15 },
  thresholds: {
    healthy: { roas: 1.5, cvr: 0.02, ctr: 0.01, frequency: 2.5 },
    warning: { roas: 1, cvr: 0.01, ctr: 0.008, frequency: 3 },
    critical: { roas: 0.7, cvr: 0.005, ctr: 0.005, frequency: 4 },
  },
  policy: {
    scaleBudgetIf: 'roas >= 2.0 && conversions >= 10',
    pauseIf: 'roas < 0.7 && spend > 500',
    refreshCreativeIf: 'ctrDelta7d < -0.3 || frequency > 3.5',
  },
} as const);

export const LEADS_PROFILE = P({
  objective: 'leads',
  primaryKPI: 'cvr',
  supportingKPIs: ['ctr', 'cpc'],
  weights: { cvr: 0.5, ctr: 0.3, cpc: 0.2 },
  thresholds: {
    healthy: { cvr: 0.03, ctr: 0.012, cpc: 30 },
    warning: { cvr: 0.015, ctr: 0.008, cpc: 60 },
    critical: { cvr: 0.005, ctr: 0.004, cpc: 120 },
  },
  policy: {
    scaleBudgetIf: 'cvr >= 0.03 && ctr >= 0.012',
    pauseIf: 'cvr < 0.005 && spend > 500',
    refreshCreativeIf: 'ctrDelta7d < -0.3',
  },
} as const);

export const AWARENESS_PROFILE = P({
  objective: 'awareness',
  primaryKPI: 'reach',
  supportingKPIs: ['cpm', 'impressions', 'frequency'],
  weights: { reach: 0.5, cpm: 0.3, impressions: 0.15, frequency: 0.05 },
  thresholds: {
    healthy: { cpm: 400, frequency: 3 },
    warning: { cpm: 600, frequency: 4.5 },
    critical: { cpm: 900, frequency: 6 },
  },
  policy: {
    scaleBudgetIf: 'cpm <= 400',
    pauseIf: 'cpm > 900 || frequency > 6',
    refreshCreativeIf: 'frequency > 4.5',
    ignoreSignals: ['cvr_collapse', 'unprofitable_run'],
  },
} as const);

export const TRAFFIC_PROFILE = P({
  objective: 'traffic',
  primaryKPI: 'cpc',
  supportingKPIs: ['ctr', 'clicks'],
  weights: { cpc: 0.5, ctr: 0.35, clicks: 0.15 },
  thresholds: {
    healthy: { cpc: 8, ctr: 0.015 },
    warning: { cpc: 15, ctr: 0.008 },
    critical: { cpc: 30, ctr: 0.004 },
  },
  policy: {
    scaleBudgetIf: 'cpc <= 8 && ctr >= 0.015',
    pauseIf: 'cpc > 30',
    refreshCreativeIf: 'ctrDelta7d < -0.3',
    ignoreSignals: ['cvr_collapse'],
  },
} as const);

export const ENGAGEMENT_PROFILE = P({
  objective: 'engagement',
  primaryKPI: 'ctr',
  supportingKPIs: ['cpm', 'frequency'],
  weights: { ctr: 0.6, cpm: 0.25, frequency: 0.15 },
  thresholds: {
    healthy: { ctr: 0.015, cpm: 500 },
    warning: { ctr: 0.008, cpm: 800 },
    critical: { ctr: 0.004, cpm: 1200 },
  },
  policy: {
    scaleBudgetIf: 'ctr >= 0.015',
    pauseIf: 'ctr < 0.004',
    refreshCreativeIf: 'frequency > 4.5',
    ignoreSignals: ['cvr_collapse', 'unprofitable_run'],
  },
} as const);

export const VIDEO_VIEWS_PROFILE = P({
  objective: 'video_views',
  primaryKPI: 'ctr',
  supportingKPIs: ['cpm', 'reach'],
  weights: { ctr: 0.5, cpm: 0.3, reach: 0.2 },
  thresholds: {
    healthy: { cpm: 300 },
    warning: { cpm: 500 },
    critical: { cpm: 800 },
  },
  policy: {
    scaleBudgetIf: 'cpm <= 300',
    pauseIf: 'cpm > 800',
    refreshCreativeIf: 'frequency > 4',
    ignoreSignals: ['cvr_collapse', 'unprofitable_run'],
  },
} as const);

export const APP_INSTALLS_PROFILE = P({
  objective: 'app_installs',
  primaryKPI: 'cpc',
  supportingKPIs: ['ctr', 'cvr'],
  weights: { cpc: 0.4, ctr: 0.3, cvr: 0.3 },
  thresholds: {
    healthy: { cpc: 20, ctr: 0.012 },
    warning: { cpc: 40, ctr: 0.008 },
    critical: { cpc: 80, ctr: 0.004 },
  },
  policy: {
    scaleBudgetIf: 'cpc <= 20',
    pauseIf: 'cpc > 80',
    refreshCreativeIf: 'ctrDelta7d < -0.3',
  },
} as const);

export const MESSAGES_PROFILE = P({
  objective: 'messages',
  primaryKPI: 'cvr',
  supportingKPIs: ['ctr'],
  weights: { cvr: 0.6, ctr: 0.4 },
  thresholds: {
    healthy: { cvr: 0.02, ctr: 0.012 },
    warning: { cvr: 0.01, ctr: 0.008 },
    critical: { cvr: 0.005, ctr: 0.004 },
  },
  policy: {
    scaleBudgetIf: 'cvr >= 0.02',
    pauseIf: 'cvr < 0.005',
    refreshCreativeIf: 'ctr < 0.008',
  },
} as const);

export const CATALOG_SALES_PROFILE = P({
  ...SALES_PROFILE,
  objective: 'catalog_sales',
} as const);

export const RETARGETING_PROFILE = P({
  ...SALES_PROFILE,
  objective: 'retargeting',
  thresholds: {
    healthy: { roas: 3, cvr: 0.04, ctr: 0.015, frequency: 3 },
    warning: { roas: 2, cvr: 0.02, ctr: 0.01, frequency: 4.5 },
    critical: { roas: 1, cvr: 0.008, ctr: 0.005, frequency: 6 },
  },
} as const);

const REGISTRY: Record<ObjectiveKey, ObjectiveProfile> = {
  sales: SALES_PROFILE,
  leads: LEADS_PROFILE,
  awareness: AWARENESS_PROFILE,
  traffic: TRAFFIC_PROFILE,
  engagement: ENGAGEMENT_PROFILE,
  video_views: VIDEO_VIEWS_PROFILE,
  app_installs: APP_INSTALLS_PROFILE,
  messages: MESSAGES_PROFILE,
  catalog_sales: CATALOG_SALES_PROFILE,
  retargeting: RETARGETING_PROFILE,
};

export function getProfile(k: ObjectiveKey): ObjectiveProfile {
  return REGISTRY[k] ?? SALES_PROFILE;
}

/**
 * Meta objective enum strings → our canonical ObjectiveKey.
 * Handles both Meta's OUTCOME_* format (v14+) and legacy names.
 */
export function mapMetaObjective(raw?: string): ObjectiveKey | undefined {
  if (!raw) return undefined;
  const u = raw.toUpperCase();
  if (u.includes('SALES') && u.includes('CATALOG')) return 'catalog_sales';
  if (u.includes('SALES') || u.includes('CONVERSIONS') || u === 'OUTCOME_SALES') return 'sales';
  if (u.includes('LEAD')) return 'leads';
  if (u.includes('AWARENESS')) return 'awareness';
  if (u.includes('TRAFFIC') || u.includes('LINK_CLICKS')) return 'traffic';
  if (u.includes('ENGAGE')) return 'engagement';
  if (u.includes('VIDEO')) return 'video_views';
  if (u.includes('APP_INSTALL')) return 'app_installs';
  if (u.includes('MESSAGES')) return 'messages';
  return undefined;
}
