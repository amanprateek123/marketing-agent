import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { DiagnosisData, SignalKind } from '../orchestrator/decision-context';

const PATTERNS: Array<{
  match: Set<SignalKind>;
  hypothesis: string;
  focus: DiagnosisData['rootCauses'][number]['suggestedFocus'];
}> = [
  {
    // hook_burn is already a compound, volume-gated observation on one
    // active video ad (P25 depth + CTR). Keep the conclusion explicitly at
    // hypothesis level, but do not require an impossible ad-level pairing
    // with creative_fatigue, which is emitted at campaign/ad-set scope.
    match: new Set(['hook_burn']),
    hypothesis: 'Weak video-opening engagement on this ad',
    focus: 'creative',
  },
  {
    match: new Set(['ctr_decay', 'frequency_ceiling']),
    hypothesis: 'Creative fatigue driven by over-frequency',
    focus: 'creative',
  },
  {
    match: new Set(['cvr_collapse', 'ctr_decay']),
    hypothesis: 'Landing-page or product-market misalignment',
    focus: 'audience',
  },
  {
    match: new Set(['cvr_collapse', 'unprofitable_run']),
    hypothesis: 'Chronically unprofitable creative',
    focus: 'creative',
  },
  {
    match: new Set(['audience_saturation', 'frequency_ceiling']),
    hypothesis: 'Audience pool exhausted',
    focus: 'audience',
  },
  {
    match: new Set(['delivery_stalled', 'learning_limited_locked']),
    hypothesis: 'Meta learning locked out',
    focus: 'budget',
  },
  {
    match: new Set(['budget_saturation']),
    hypothesis: 'Auction ceiling reached',
    focus: 'budget',
  },
  {
    match: new Set(['placement_leak']),
    hypothesis: 'Placement mix suboptimal',
    focus: 'placement',
  },
  {
    match: new Set(['winner_confirmed']),
    hypothesis: 'Confirmed winner — protect and scale',
    focus: 'budget',
  },
  {
    match: new Set(['winner_emerging']),
    hypothesis: 'Emerging winner candidate',
    focus: 'budget',
  },
];

@Injectable()
export class DiagnosisEngine extends BaseEngine<'diagnosis', DiagnosisData> {
  readonly name = 'diagnosis' as const;
  readonly step = 7;
  readonly version = '1.3.0';
  readonly dependsOn = ['signal', 'trend', 'revenue', 'objective'] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.signal.completed')
  async onSignalCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    this.identity.set(payload.cycleId, {
      tenantId: payload.tenantId,
      campaignId: payload.campaignId,
    });
    try {
      await this.execute(payload.cycleId);
    } finally {
      this.identity.delete(payload.cycleId);
    }
  }

  protected async identityFromDeps(cycleId: string) {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(
    deps: ComputeDeps<'diagnosis'>,
  ): Promise<DiagnosisData> {
    const signals = deps.signal!.data.signals;
    const revenue = deps.revenue!;
    const kinds = new Set(signals.map((s) => s.kind));

    const rootCauses: DiagnosisData['rootCauses'] = [];
    const signalsByTarget = new Map<string, typeof signals>();
    for (const signal of signals) {
      const key = `${signal.targetType}:${signal.targetId}`;
      const group = signalsByTarget.get(key);
      if (group) group.push(signal);
      else signalsByTarget.set(key, [signal]);
    }

    // A causal pattern is valid only when every corroborating observation was
    // measured on the same entity. Campaign-level frequency plus one ad set's
    // CTR decay (or signals from two different ad sets) is not a diagnosis of
    // either target and must never be combined into one actionable root cause.
    for (const targetSignals of signalsByTarget.values()) {
      const target = targetSignals[0];
      const laggingGoalSignal = targetSignals.find(
        (signal) => signal.kind === 'optimization_goal_efficiency_lagging',
      );
      const leadingGoalSignal = targetSignals.find(
        (signal) => signal.kind === 'optimization_goal_efficiency_leading',
      );
      for (const p of PATTERNS) {
        // When a hook observation corroborates an exact ad-level goal lag,
        // the bounded combined hypothesis below supersedes the generic hook
        // diagnosis. This prevents two near-duplicate creative diagnoses.
        if (
          laggingGoalSignal &&
          target.targetType === 'ad' &&
          p.match.size === 1 &&
          p.match.has('hook_burn')
        ) {
          continue;
        }
        const matched = [...p.match].map((kind) =>
          targetSignals.find((signal) => signal.kind === kind),
        );
        if (matched.some((signal) => !signal)) continue;

        const evidenceSignals = [...p.match];
        const strengthAvg =
          matched.reduce((sum, signal) => sum + (signal?.strength ?? 0), 0) /
          matched.length;
        rootCauses.push({
          hypothesis: p.hypothesis,
          targetType: target.targetType,
          targetId: target.targetId,
          evidenceSignals,
          supportingTrends: [],
          confidence: Number(strengthAvg.toFixed(3)),
          suggestedFocus: p.focus,
        });
      }

      const goalSignal = laggingGoalSignal ?? leadingGoalSignal;
      if (!goalSignal?.goalEvidence) continue;
      const creativeCorroboration =
        goalSignal.kind === 'optimization_goal_efficiency_lagging' &&
        target.targetType === 'ad'
          ? targetSignals.filter(
              (signal) =>
                signal.kind === 'hook_burn' || signal.kind === 'ctr_decay',
            )
          : [];
      const evidence = [goalSignal, ...creativeCorroboration];
      const confidence = Math.min(
        0.8,
        evidence.reduce((sum, signal) => sum + signal.strength, 0) /
          evidence.length,
      );
      const goal = goalSignal.goalEvidence.optimizationGoal;
      const isLagging =
        goalSignal.kind === 'optimization_goal_efficiency_lagging';
      const hasCreativeCorroboration = creativeCorroboration.length > 0;
      const hypothesis = hasCreativeCorroboration
        ? `Relative ${goal} delivery inefficiency is observed, and this exact ad also has weak hook or target CTR evidence; creative contribution is plausible, not proven, and no uplift is predicted.`
        : isLagging
          ? `Relative ${goal} delivery inefficiency is observed against exact ACTIVE same-window siblings. Cause remains unresolved: the evidence does not establish creative, audience, placement, bid, landing-page, or tracking causality, and no uplift is predicted.`
          : `Relative ${goal} delivery-efficiency leadership is observed against exact ACTIVE same-window siblings; no causal driver, scale outcome, or future uplift is established.`;
      rootCauses.push({
        hypothesis,
        targetType: target.targetType,
        targetId: target.targetId,
        evidenceSignals: evidence.map((signal) => signal.kind),
        supportingTrends: [
          'Observed same-window pooled sibling comparison; not causal evidence.',
        ],
        goalEvidence: goalSignal.goalEvidence,
        confidence: Number(confidence.toFixed(3)),
        suggestedFocus: hasCreativeCorroboration
          ? 'creative'
          : 'delivery_efficiency',
      });
    }

    rootCauses.sort((a, b) => b.confidence - a.confidence);

    const leakDiagnosis = this.computeLeak(kinds, revenue.data);
    const narrative = this.narrate(rootCauses, leakDiagnosis);

    return { rootCauses, leakDiagnosis, narrative };
  }

  private computeLeak(
    kinds: Set<SignalKind>,
    revenue: { breakeven: { isProfitable: boolean } },
  ): DiagnosisData['leakDiagnosis'] {
    if (kinds.has('cvr_collapse')) return 'audience_lp_leak';
    if (kinds.has('creative_fatigue') || kinds.has('hook_burn'))
      return 'creative_leak';
    if (kinds.has('placement_leak')) return 'auction_leak';
    if (!revenue.breakeven.isProfitable && kinds.has('unprofitable_run'))
      return 'chronic_unprofitable';
    if (kinds.has('delivery_stalled')) return 'data_gap';
    if (kinds.size === 0) return 'none';
    return 'fragmentation';
  }

  /**
   * Operators read this string directly on the recommendations page, so it
   * stays in plain language. The machine-readable code remains available as
   * `leakDiagnosis` for anything that needs to branch on it.
   */
  private plainLeak(leak: DiagnosisData['leakDiagnosis']): string {
    const phrases: Record<string, string> = {
      none: 'nothing structurally wrong stood out',
      chronic_unprofitable: 'it is simply returning less than it costs to run',
      creative_leak: 'the ads themselves look like the weak point',
      auction_leak: 'where the ads are being shown looks like the weak point',
      data_gap: 'delivery data is missing',
      fragmentation: 'the spend is spread too thin to read clearly',
    };
    return phrases[leak] ?? leak.replace(/_/g, ' ');
  }

  private narrate(
    rootCauses: DiagnosisData['rootCauses'],
    leak: DiagnosisData['leakDiagnosis'],
  ): string {
    if (rootCauses.length === 0)
      return `No supported root cause emerged from the available evidence — ${this.plainLeak(leak)}.`;
    const top = rootCauses[0];
    const target =
      top.targetType && top.targetId
        ? `, target=${top.targetType}:${top.targetId}`
        : '';
    return `Top hypothesis: ${top.hypothesis} (confidence ${(top.confidence * 100).toFixed(0)}%, focus=${top.suggestedFocus}${target}). In plain terms: ${this.plainLeak(leak)}.`;
  }

  protected computeConfidence(
    _deps: ComputeDeps<'diagnosis'>,
    data: DiagnosisData,
  ): number {
    // Absence of a supported cause is useful restraint, not positive
    // diagnostic evidence. Keep it below Recommendation's 0.5 readiness
    // threshold so a strong standalone signal cannot masquerade as a root
    // cause and unlock an action.
    if (data.rootCauses.length === 0) return 0.2;
    return Math.min(1, data.rootCauses[0].confidence + 0.2);
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'context', ref: 'signals+trends+revenue', weight: 1 }];
  }
}
