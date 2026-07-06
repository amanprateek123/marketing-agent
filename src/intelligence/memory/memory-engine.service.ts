import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { MemoryData } from '../orchestrator/decision-context';
import { CompaniesService } from '../../companies/companies.service';

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
    @Optional() private readonly companies: CompaniesService | null,
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
    const ident = deps as unknown as { tenantId?: string };
    const tenantId = ident.tenantId ?? '';
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

    const creative = co.learnings?.creative ?? {};
    return {
      pastActions: [],
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
    const hasInsights = data.causalInsights.length > 0 ? 0.4 : 0;
    const hasExemplars = data.companyLearnings.winningExemplars.length > 0 ? 0.3 : 0;
    return 0.3 + hasInsights + hasExemplars;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'memory', ref: 'company.learnings', weight: 1 }];
  }
}
