import { LifecycleData, LifecycleStage } from '../orchestrator/decision-context';

const g = (
  x: Partial<LifecycleData['gates']>,
): LifecycleData['gates'] => ({
  canPause: false,
  canScale: false,
  canReduceBudget: false,
  canReplaceCreative: false,
  canAddAudience: false,
  ...x,
});

export const LIFECYCLE_GATES: Record<
  LifecycleStage,
  Pick<LifecycleData, 'allowedActions' | 'blockedActions' | 'monitoringCadenceMinutes' | 'gates'>
> = {
  draft: {
    allowedActions: [],
    blockedActions: [{ action: '*', reason: 'Campaign is in draft' }],
    monitoringCadenceMinutes: 720,
    gates: g({}),
  },
  pending_approval: {
    allowedActions: [],
    blockedActions: [{ action: '*', reason: 'Awaiting human approval' }],
    monitoringCadenceMinutes: 120,
    gates: g({}),
  },
  launching: {
    allowedActions: ['add_creative'],
    blockedActions: [
      { action: 'pause_ad', reason: 'Launching (<24h)' },
      { action: 'pause_adset', reason: 'Launching (<24h)' },
      { action: 'scale_adset', reason: 'Insufficient data to scale' },
    ],
    monitoringCadenceMinutes: 30,
    gates: g({ canReplaceCreative: true }),
  },
  learning: {
    allowedActions: ['add_creative', 'narrow_placement'],
    blockedActions: [
      { action: 'pause_ad', reason: 'Meta learning stage; pause resets learning' },
      { action: 'pause_adset', reason: 'Meta learning stage' },
      { action: 'scale_adset', reason: 'Wait for learning to complete' },
      { action: 'shift_budget_between_adsets', reason: 'Learning phase' },
    ],
    monitoringCadenceMinutes: 60,
    gates: g({ canReplaceCreative: true }),
  },
  growing: {
    allowedActions: ['scale_adset', 'add_creative', 'shift_budget_between_adsets'],
    blockedActions: [],
    monitoringCadenceMinutes: 60,
    gates: g({ canScale: true, canReplaceCreative: true, canAddAudience: true }),
  },
  scaling: {
    allowedActions: ['scale_adset', 'shift_budget_between_adsets'],
    blockedActions: [],
    monitoringCadenceMinutes: 60,
    gates: g({ canScale: true, canReduceBudget: true }),
  },
  stable: {
    allowedActions: ['add_creative', 'narrow_placement', 'shift_budget_between_adsets'],
    blockedActions: [],
    monitoringCadenceMinutes: 120,
    gates: g({
      canScale: true,
      canReduceBudget: true,
      canReplaceCreative: true,
    }),
  },
  fatigue: {
    allowedActions: ['replace_creative', 'add_creative', 'narrow_placement'],
    blockedActions: [
      { action: 'scale_adset', reason: 'Fatigue detected' },
    ],
    monitoringCadenceMinutes: 60,
    gates: g({ canReplaceCreative: true, canReduceBudget: true }),
  },
  recovery: {
    allowedActions: ['add_creative'],
    blockedActions: [{ action: 'scale_adset', reason: 'Recovery in progress' }],
    monitoringCadenceMinutes: 60,
    gates: g({ canReplaceCreative: true }),
  },
  retirement: {
    allowedActions: [],
    blockedActions: [{ action: '*', reason: 'Campaign is being retired' }],
    monitoringCadenceMinutes: 720,
    gates: g({ canPause: true, canReduceBudget: true }),
  },
  unknown: {
    allowedActions: [],
    blockedActions: [{ action: '*', reason: 'Lifecycle unknown; insufficient data' }],
    monitoringCadenceMinutes: 60,
    gates: g({}),
  },
};

export function nextStageOf(stage: LifecycleStage): LifecycleStage {
  const map: Record<LifecycleStage, LifecycleStage> = {
    draft: 'pending_approval',
    pending_approval: 'launching',
    launching: 'learning',
    learning: 'growing',
    growing: 'scaling',
    scaling: 'stable',
    stable: 'fatigue',
    fatigue: 'recovery',
    recovery: 'stable',
    retirement: 'retirement',
    unknown: 'unknown',
  };
  return map[stage];
}
