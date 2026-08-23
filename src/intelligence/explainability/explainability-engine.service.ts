import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import {
  SliceIdentity,
  SliceRepository,
} from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  ExplainabilityData,
  RecommendedAction,
} from '../orchestrator/decision-context';
import {
  IntelligenceDecision,
  IntelligenceDecisionDocument,
} from '../decisions/intelligence-decision.schema';
import { buildIntelligenceReviewEvidence } from './intelligence-review-evidence.builder';
import { INTELLIGENCE_REVIEW_SCHEMA_VERSION } from './intelligence-review.types';
import { OpenAIIntelligenceReviewService } from './openai-intelligence-review.service';

@Injectable()
export class ExplainabilityEngine extends BaseEngine<
  'explainability',
  ExplainabilityData
> {
  readonly name = 'explainability' as const;
  readonly step = 14;
  readonly version = '2.0.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'lifecycle',
    'trend',
    'revenue',
    'signal',
    'diagnosis',
    'business',
    'portfolio',
    'forecast',
    'confidence',
    'memory',
    'recommendation',
  ] as const;

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    private readonly reviewer: OpenAIIntelligenceReviewService,
    @InjectModel(IntelligenceDecision.name)
    private readonly decisionModel: Model<IntelligenceDecisionDocument>,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.recommendation.completed')
  async onRecommendationCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    await this.execute(payload.cycleId, {
      tenantId: payload.tenantId,
      campaignId: payload.campaignId,
    });
  }

  protected async compute(
    deps: ComputeDeps<'explainability'>,
    cycleId: string,
    identity: SliceIdentity,
  ): Promise<ExplainabilityData> {
    const actions = deps.recommendation!.data.actions as RecommendedAction[];
    const signals = deps.signal!.data.signals;
    const trend = deps.trend!.data;
    const diagnosis = deps.diagnosis!.data;
    const stage = deps.lifecycle!.data.stage;

    const perAction: ExplainabilityData['perAction'] = {};
    for (const a of actions) {
      const relevantSignals = signals.filter((s) => {
        if (s.targetType !== a.targetType || s.targetId !== a.targetId) {
          return false;
        }
        return (
          (a.type.includes('creative') &&
            (s.kind === 'creative_fatigue' ||
              s.kind === 'ctr_decay' ||
              s.kind === 'hook_burn')) ||
          (a.type.includes('scale') &&
            (s.kind === 'winner_emerging' || s.kind === 'winner_confirmed')) ||
          ((a.type.includes('pause') || a.type.includes('reduce')) &&
            s.kind === 'unprofitable_run')
        );
      });
      const evidenceChain: ExplainabilityData['perAction'][string]['evidenceChain'] =
        [];
      for (const s of relevantSignals) {
        evidenceChain.push({
          step: `Signal '${s.kind}' fired (severity=${s.severity}, strength=${s.strength.toFixed(2)})`,
          source: 'dc.signal',
        });
      }
      evidenceChain.push({
        step: `Lifecycle stage '${stage}' was checked before action '${a.type}' was surfaced`,
        source: 'dc.lifecycle',
      });
      if (trend.trendReady === true) {
        evidenceChain.push({
          step: `Trend gate passed with ${trend.observationCount ?? 0} daily observations across ${trend.windowElapsedDays ?? 0} elapsed days`,
          source: 'dc.trend',
        });
      }
      evidenceChain.push({
        step: `Diagnosis leak = '${diagnosis.leakDiagnosis}'`,
        source: 'dc.diagnosis',
      });

      const summary =
        a.expectedImpact.basis === 'not_estimated'
          ? `${a.type.replace(/_/g, ' ')} — validate ${a.expectedImpact.metric}; no causal uplift is estimated`
          : `${a.type.replace(/_/g, ' ')} — ${a.expectedImpact.basis === 'observed_gap' ? 'observed' : 'expected'} ${a.expectedImpact.deltaPct}% ${a.expectedImpact.metric}`;
      const exactRootCause = diagnosis.rootCauses.find(
        (cause) =>
          cause.targetType === a.targetType && cause.targetId === a.targetId,
      );
      const reasoning = [
        `Recommended: ${a.type} on ${a.targetType} ${a.targetId}.`,
        exactRootCause
          ? `Exact-target root cause: ${exactRootCause.hypothesis}.`
          : '',
        `Risk: ${a.risk}; score ${a.score}.`,
      ]
        .filter(Boolean)
        .join(' ');

      const counterfactual = a.type.includes('pause')
        ? 'If not paused, spend continues at current rate with breakeven not restored.'
        : a.type.includes('scale')
          ? 'If not scaled, additional revenue growth is deferred.'
          : undefined;

      const evidence = buildIntelligenceReviewEvidence({
        deps,
        cycleId,
        identity,
        action: a,
      });
      const review = await this.reviewer.review({
        packet: evidence.packet,
        action: a,
      });

      perAction[a.actionId] = {
        summary,
        reasoning,
        evidenceChain,
        counterfactual,
        llmRendered: review.summary,
        review,
        evidence,
      };

      try {
        await this.decisionModel.updateOne(
          {
            tenantId: identity.tenantId,
            campaignId: identity.campaignId,
            cycleId,
            actionId: a.actionId,
          },
          {
            $set: {
              intelligenceReviewVersion: INTELLIGENCE_REVIEW_SCHEMA_VERSION,
              intelligenceReview: review,
              intelligenceEvidence: evidence,
              intelligenceReviewedAt: new Date(review.generatedAt),
            },
          },
        );
      } catch (err) {
        // The canonical review still lands in the Step-14 slice. A denormalized
        // decision update failure must not break Steps 15–16.
        this.logger.warn(
          `Could not attach intelligence review to decision ${a.actionId}: ${(err as Error).message}`,
        );
      }
    }
    return { perAction };
  }

  protected isDeterministic(): boolean {
    return false;
  }

  protected computeConfidence(
    deps: ComputeDeps<'explainability'>,
    data: ExplainabilityData,
  ): number {
    const reviews = Object.values(data.perAction)
      .map((entry) => entry.review)
      .filter(Boolean);
    if (reviews.some((review) => review?.source === 'fallback')) {
      return Math.min(deps.recommendation!.confidence, 0.45);
    }
    return deps.recommendation!.confidence;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'explainability'>,
    data: ExplainabilityData,
  ): Evidence[] {
    return [
      {
        kind: 'context',
        ref: `validated-reviews:${Object.values(data.perAction).filter((entry) => entry.review?.validation.valid).length}/${Object.keys(data.perAction).length}`,
        weight: 1,
      },
    ];
  }
}
