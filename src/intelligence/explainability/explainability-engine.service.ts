import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  ExplainabilityData,
  RecommendedAction,
} from '../orchestrator/decision-context';

@Injectable()
export class ExplainabilityEngine extends BaseEngine<
  'explainability',
  ExplainabilityData
> {
  readonly name = 'explainability' as const;
  readonly step = 14;
  readonly version = '1.0.0';
  readonly dependsOn = ['recommendation', 'diagnosis', 'signal', 'trend', 'lifecycle'] as const;

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

  @OnEvent('intelligence.recommendation.completed')
  async onRecommendationCompleted(payload: {
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
    deps: ComputeDeps<'explainability'>,
  ): Promise<ExplainabilityData> {
    const actions = deps.recommendation!.data.actions as RecommendedAction[];
    const signals = deps.signal!.data.signals;
    const trend = deps.trend!.data;
    const diagnosis = deps.diagnosis!.data;
    const stage = deps.lifecycle!.data.stage;

    const perAction: ExplainabilityData['perAction'] = {};
    for (const a of actions) {
      const relevantSignals = signals.filter(
        (s) =>
          (a.type.includes('creative') && (s.kind === 'creative_fatigue' || s.kind === 'ctr_decay')) ||
          (a.type.includes('scale') && s.kind === 'winner_emerging') ||
          (a.type.includes('pause') && s.kind === 'unprofitable_run'),
      );
      const evidenceChain: ExplainabilityData['perAction'][string]['evidenceChain'] = [];
      for (const s of relevantSignals) {
        evidenceChain.push({
          step: `Signal '${s.kind}' fired (severity=${s.severity}, strength=${s.strength.toFixed(2)})`,
          source: 'dc.signal',
        });
      }
      evidenceChain.push({
        step: `Lifecycle stage '${stage}' allows action '${a.type}'`,
        source: 'dc.lifecycle',
      });
      const ctrSlope = trend.perMetric?.ctr?.slope3d;
      if (ctrSlope !== undefined) {
        evidenceChain.push({
          step: `CTR 3-day slope = ${ctrSlope.toFixed(4)}`,
          source: 'dc.trend',
        });
      }
      evidenceChain.push({
        step: `Diagnosis leak = '${diagnosis.leakDiagnosis}'`,
        source: 'dc.diagnosis',
      });

      const summary = `${a.type.replace(/_/g, ' ')} — expected ${a.expectedImpact.deltaPct}% ${a.expectedImpact.metric}`;
      const reasoning = [
        `Recommended: ${a.type} on ${a.targetType} ${a.targetId}.`,
        diagnosis.rootCauses[0]
          ? `Primary root cause: ${diagnosis.rootCauses[0].hypothesis}.`
          : '',
        `Risk: ${a.risk}; score ${a.score}.`,
      ]
        .filter(Boolean)
        .join(' ');

      const counterfactual =
        a.type.includes('pause')
          ? 'If not paused, spend continues at current rate with breakeven not restored.'
          : a.type.includes('scale')
            ? 'If not scaled, additional revenue growth is deferred.'
            : undefined;

      perAction[a.actionId] = { summary, reasoning, evidenceChain, counterfactual };
    }
    return { perAction };
  }

  protected computeConfidence(deps: ComputeDeps<'explainability'>): number {
    return deps.recommendation!.confidence;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'explainability'>,
    data: ExplainabilityData,
  ): Evidence[] {
    return [
      {
        kind: 'context',
        ref: `explanations:${Object.keys(data.perAction).length}`,
        weight: 1,
      },
    ];
  }
}
