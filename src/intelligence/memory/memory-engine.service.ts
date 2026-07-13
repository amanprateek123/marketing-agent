import { Inject, Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { MemoryData } from '../orchestrator/decision-context';
import { CompaniesService } from '../../companies/companies.service';
import { ActionOutcomeService } from '../../learning/action-outcome.service';

@Injectable()
export class MemoryEngine extends BaseEngine<'memory', MemoryData> {
  readonly name = 'memory' as const;
  readonly step = 12;
  readonly version = '1.0.0';
  readonly dependsOn = ['snapshot', 'objective', 'diagnosis', 'confidence'] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    // Explicit @Inject() tokens — see BusinessEngine's constructor for why a
    // bare `@Optional() x: Service | null` param is unreliable (the union
    // with null can erase to `Object` in emitted design:paramtypes
    // metadata, so @Optional() silently resolves to null even when the
    // module correctly provides the service).
    @Optional() @Inject(CompaniesService) private readonly companies: CompaniesService | null,
    @Optional() @Inject(ActionOutcomeService) private readonly actionOutcomes: ActionOutcomeService | null,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.confidence.completed')
  async onConfidenceCompleted(payload: {
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

  protected async compute(deps: ComputeDeps<'memory'>): Promise<MemoryData> {
    // deps carries only engine-slice outputs, never identity fields — the
    // previous `deps as unknown as {tenantId}` cast always resolved to
    // undefined, so tenantId was always '' and `company` (hence every real
    // causalInsight/companyLearnings field below) never loaded.
    const ident = this.identity.values().next().value;
    const tenantId = ident?.tenantId ?? '';
    const company =
      this.companies && tenantId
        ? await this.companies.findByTenantId(tenantId).catch(() => null)
        : null;
    const co = (company as
      | {
          learnings?: {
            causalInsights?: Array<{
              finding?: string;
              confidence?: number;
              isolatedVariable?: string;
            }>;
            creative?: {
              winningHooks?: string[];
              losingHooks?: string[];
              winningExemplars?: Array<{ hookLine?: string; ctr?: number }>;
              audienceHookSaturation?: Record<string, Record<string, number>>;
            };
          };
        }
      | null) ?? {};

    const causalInsights = (co.learnings?.causalInsights ?? []).map((c) => ({
      finding: c.finding ?? '',
      confidence: Number(c.confidence ?? 0),
      isolatedVariable: c.isolatedVariable ?? '',
    }));

    // Real executed-action history from the older campaign-auditor system
    // (executed_actions collection) — the only place actual outcome labels
    // (improved/worsened/neutral) exist today, since the 16-engine cascade
    // is shadow-mode only and has never applied anything itself. This was
    // previously hardcoded to [], so RecommendationEngine's "don't repeat a
    // proven-bad action type" dampening (recentlyWorsenedTypes) was dead
    // code — it read a field that could never contain anything.
    const recentExecuted = this.actionOutcomes && tenantId
      ? await this.actionOutcomes.listRecent(tenantId, 30).catch(() => [])
      : [];
    const pastActions = recentExecuted
      .filter((a) => a.outcomeLabel != null)
      .map((a) => ({
        actionType: a.action.type,
        executedAt: a.executedAt,
        outcomeLabel: a.outcomeLabel as 'improved' | 'worsened' | 'neutral' | 'inconclusive',
        context: [
          a.action.targetName ?? a.action.targetId,
          a.context?.ageDays != null ? `day ${a.context.ageDays}` : null,
          a.context?.audienceType,
        ]
          .filter(Boolean)
          .join(' · '),
      }));

    const creative = co.learnings?.creative ?? {};
    return {
      pastActions,
      causalInsights,
      similarPastCycles: [],
      companyLearnings: {
        winningHooks: creative.winningHooks ?? [],
        losingHooks: creative.losingHooks ?? [],
        winningExemplars: (creative.winningExemplars ?? [])
          .slice(0, 5)
          .map((e) => ({ hookLine: e.hookLine ?? '', ctr: Number(e.ctr ?? 0) })),
        audienceHookSaturation: creative.audienceHookSaturation ?? {},
      },
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'memory'>,
    data: MemoryData,
  ): number {
    const hasInsights = data.causalInsights.length > 0 ? 0.3 : 0;
    const hasExemplars = data.companyLearnings.winningExemplars.length > 0 ? 0.2 : 0;
    const hasPastActions = data.pastActions.length > 0 ? 0.2 : 0;
    return 0.3 + hasInsights + hasExemplars + hasPastActions;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'memory', ref: 'company.learnings', weight: 1 }];
  }
}
