import { Inject, Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import {
  SliceIdentity,
  SliceRepository,
} from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { MemoryData } from '../orchestrator/decision-context';
import { CompaniesService } from '../../companies/companies.service';
import { ActionOutcomeService } from '../../learning/action-outcome.service';

@Injectable()
export class MemoryEngine extends BaseEngine<'memory', MemoryData> {
  readonly name = 'memory' as const;
  readonly step = 12;
  readonly version = '1.1.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'diagnosis',
    'confidence',
  ] as const;

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
    @Optional()
    @Inject(CompaniesService)
    private readonly companies: CompaniesService | null,
    @Optional()
    @Inject(ActionOutcomeService)
    private readonly actionOutcomes: ActionOutcomeService | null,
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

  protected async compute(
    deps: ComputeDeps<'memory'>,
    cycleId: string,
    identity: SliceIdentity,
  ): Promise<MemoryData> {
    void deps;
    void cycleId;
    // deps carries only engine-slice outputs, never identity fields — the
    // previous `deps as unknown as {tenantId}` cast always resolved to
    // undefined, so tenantId was always '' and `company` (hence every real
    // causalInsight/companyLearnings field below) never loaded.
    const tenantId = identity.tenantId;
    const campaignId = identity.campaignId;
    const company =
      this.companies && tenantId
        ? await this.companies.findByTenantId(tenantId).catch(() => null)
        : null;
    const co =
      (company as {
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
      } | null) ?? {};

    const causalInsights = (co.learnings?.causalInsights ?? []).map((c) => ({
      finding: c.finding ?? '',
      confidence: Number(c.confidence ?? 0),
      isolatedVariable: c.isolatedVariable ?? '',
    }));

    // Real executed-action history, SCOPED TO THIS CAMPAIGN — the only place
    // actual outcome labels (improved/worsened/neutral) exist today. Each
    // record carries the specific ad/adset/campaign targetId it acted on,
    // so RecommendationEngine can gate on "this exact target already tried
    // this and it backfired," not just "this action type backfired
    // somewhere in the account" (previously listRecent(tenantId, 30) pulled
    // account-wide, unscoped history — every campaign saw every other
    // campaign's failures as equally relevant caution, and no per-target
    // signal was available at all).
    const recentExecuted =
      this.actionOutcomes && tenantId && campaignId
        ? await this.actionOutcomes
            .listRecentForCampaign(tenantId, campaignId, 30)
            .catch(() => [])
        : [];
    const pastActions = recentExecuted
      .filter((a) => a.outcomeLabel != null)
      .map((a) => ({
        actionType: a.action.type,
        targetId: a.action.targetId ?? '',
        executedAt: a.executedAt,
        outcomeLabel: a.outcomeLabel as
          | 'improved'
          | 'worsened'
          | 'neutral'
          | 'inconclusive',
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
          .map((e) => ({
            hookLine: e.hookLine ?? '',
            ctr: Number(e.ctr ?? 0),
          })),
        audienceHookSaturation: creative.audienceHookSaturation ?? {},
      },
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'memory'>,
    data: MemoryData,
  ): number {
    // Only measured actions from this campaign strengthen campaign-specific
    // memory confidence. Tenant-wide causal insights and creative exemplars
    // remain useful context, but they cannot make an untested campaign look
    // historically validated.
    if (data.pastActions.length === 0) return 0.2;
    return Math.min(1, 0.5 + data.pastActions.length * 0.1);
  }

  protected buildEvidence(
    _deps: ComputeDeps<'memory'>,
    data: MemoryData,
  ): Evidence[] {
    const evidence: Evidence[] = [];
    if (data.pastActions.length > 0) {
      evidence.push({
        kind: 'memory',
        ref: 'action_outcomes:campaign',
        weight: 1,
        note: `${data.pastActions.length} campaign-scoped measured action(s)`,
      });
    }
    if (
      data.causalInsights.length > 0 ||
      data.companyLearnings.winningExemplars.length > 0
    ) {
      evidence.push({
        kind: 'context',
        ref: 'company.learnings',
        weight: 0,
        note: 'account-wide context only; not causal evidence for this campaign',
      });
    }
    return evidence;
  }
}
