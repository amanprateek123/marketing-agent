import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { BusinessData } from '../orchestrator/decision-context';
import { CompaniesService } from '../../companies/companies.service';

@Injectable()
export class BusinessEngine extends BaseEngine<'business', BusinessData> {
  readonly name = 'business' as const;
  readonly step = 8;
  readonly version = '1.0.0';
  readonly dependsOn = ['objective'] as const;

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

  @OnEvent('intelligence.objective.completed')
  async onObjectiveCompleted(payload: {
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

  protected async compute(deps: ComputeDeps<'business'>): Promise<BusinessData> {
    const ident = deps as unknown as { tenantId?: string };
    const tenantId = ident.tenantId ?? '';
    const company =
      this.companies && tenantId
        ? await this.companies.findByTenantId(tenantId).catch(() => null)
        : null;
    const co = (company as
      | {
          weeklyBudgetCap?: number;
          maxBudgetPerCampaign?: number;
          activePromotions?: Array<{ name?: string; expiresAt?: string | Date; details?: string }>;
          forbiddenTopics?: string[];
          calendarContext?: string;
        }
      | null) ?? {};

    const now = Date.now();
    const activePromotions = (co.activePromotions ?? [])
      .filter((p) => p.expiresAt && new Date(p.expiresAt).getTime() > now)
      .map((p) => ({
        name: String(p.name ?? ''),
        expiresAt: new Date(p.expiresAt as string | Date),
      }));

    const weeklyCap = Number(co.weeklyBudgetCap ?? 0);
    const perCampaignCap = Number(co.maxBudgetPerCampaign ?? 0);

    return {
      activePromotions,
      seasonalContext: String(co.calendarContext ?? ''),
      competitorPressure: 'medium',
      budgetPolicy: {
        weeklyCapINR: weeklyCap,
        weeklyCapUsedINR: 0,
        weeklyCapRemainingINR: weeklyCap,
        perCampaignCapINR: perCampaignCap,
      },
      forbiddenTopics: Array.isArray(co.forbiddenTopics) ? co.forbiddenTopics : [],
    };
  }

  protected computeConfidence(): number {
    return this.companies ? 0.75 : 0.4;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'company_config', ref: 'company-doc', weight: 1 }];
  }
}
