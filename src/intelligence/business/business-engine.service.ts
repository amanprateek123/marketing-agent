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
import { BusinessData } from '../orchestrator/decision-context';
import { CompaniesService } from '../../companies/companies.service';
import { CampaignsService } from '../../campaigns/campaigns.service';

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
    // Explicit @Inject() tokens — a bare `@Optional() x: Service | null`
    // parameter relies on TS's emitted design:paramtypes reflection to know
    // which provider to resolve, and a `Type | null` union can erase to
    // `Object` in that metadata, which silently resolves to nothing under
    // @Optional() even though the module correctly provides+exports the
    // service. That's exactly what happened here: weeklyCapUsedINR's real
    // getWeeklySpend() call, and the company doc itself, were never even
    // attempted despite CompaniesModule/CampaignsModule being wired in
    // business.module.ts. Every other @Optional() injection in this
    // codebase already sidesteps this via an explicit token (@InjectModel);
    // this does the same for plain service classes.
    @Optional()
    @Inject(CompaniesService)
    private readonly companies: CompaniesService | null,
    @Optional()
    @Inject(CampaignsService)
    private readonly campaigns: CampaignsService | null,
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

  protected async compute(
    deps: ComputeDeps<'business'>,
    cycleId: string,
    identity: SliceIdentity,
  ): Promise<BusinessData> {
    void deps;
    void cycleId;
    // deps carries only engine-slice outputs, never identity fields — the
    // previous `deps as unknown as {tenantId}` cast always resolved to
    // undefined, so tenantId was always '' here. That meant `company` never
    // loaded (weeklyBudgetCap always defaulted to 0) and weeklyCapUsedINR's
    // real getWeeklySpend() call was never even attempted — silently
    // re-breaking the weekly-cap enforcement this engine exists to provide,
    // via a different path than the original hardcoded-0 bug.
    const tenantId = identity.tenantId;
    const company =
      this.companies && tenantId
        ? await this.companies.findByTenantId(tenantId).catch(() => null)
        : null;
    const co =
      (company as {
        weeklyBudgetCap?: number;
        maxBudgetPerCampaign?: number;
        activePromotions?: Array<{
          name?: string;
          expiresAt?: string | Date;
          details?: string;
        }>;
        forbiddenTopics?: string[];
        calendarContext?: string;
      } | null) ?? {};

    const now = Date.now();
    const activePromotions = (co.activePromotions ?? [])
      .filter((p) => p.expiresAt && new Date(p.expiresAt).getTime() > now)
      .map((p) => ({
        name: String(p.name ?? ''),
        expiresAt: new Date(p.expiresAt as string | Date),
      }));

    const weeklyCap = Number(co.weeklyBudgetCap ?? 0);
    const perCampaignCap = Number(co.maxBudgetPerCampaign ?? 0);

    // Was hardcoded to 0 — the system believed 0% of the weekly cap was
    // ever used regardless of real spend, so scale-up/budget decisions had
    // no way to know they were approaching or over the cap. Reuses the same
    // rolling-7-day spend calc that already gates new campaign creation
    // (CampaignsService.getWeeklySpend, SafetyChecks.checkWeeklyBudget) so
    // this figure matches what's actually enforced elsewhere.
    const weeklyCapUsedINR =
      this.campaigns && tenantId
        ? await this.campaigns.getWeeklySpend(tenantId).catch(() => 0)
        : 0;

    return {
      activePromotions,
      seasonalContext: String(co.calendarContext ?? ''),
      competitorPressure: 'medium',
      budgetPolicy: {
        weeklyCapINR: weeklyCap,
        weeklyCapUsedINR,
        weeklyCapRemainingINR: Math.max(0, weeklyCap - weeklyCapUsedINR),
        perCampaignCapINR: perCampaignCap,
      },
      forbiddenTopics: Array.isArray(co.forbiddenTopics)
        ? co.forbiddenTopics
        : [],
    };
  }

  protected computeConfidence(): number {
    return this.companies && this.campaigns ? 0.75 : 0.4;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'company_config', ref: 'company-doc', weight: 1 }];
  }
}
