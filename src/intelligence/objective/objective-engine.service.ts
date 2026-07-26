import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  ObjectiveData,
  ObjectiveKey,
} from '../orchestrator/decision-context';
import { getProfile, mapMetaObjective } from './kpi-profiles';

/**
 * Determines what "success" means for a campaign.
 * Reads snapshot slice; produces objective + KPI profile.
 */
@Injectable()
export class ObjectiveEngine extends BaseEngine<'objective', ObjectiveData> {
  readonly name = 'objective' as const;
  readonly step = 2;
  readonly version = '1.0.0';
  readonly dependsOn = ['snapshot'] as const;

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

  @OnEvent('intelligence.snapshot.completed')
  async onSnapshotCompleted(payload: {
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

  protected async identityFromDeps(
    cycleId: string,
  ): Promise<{ tenantId: string; campaignId: string }> {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(deps: ComputeDeps<'objective'>): Promise<ObjectiveData> {
    const snapshot = deps.snapshot!;
    // Read from snapshot.meta.objective — the slice field. The older
    // rawCampaign lookup is kept as a fallback for cycles whose slices predate
    // that field, but it never resolved on the live path: rawCampaign is
    // persisted to the snapshot DOCUMENT only and is absent from the slice
    // handed to this engine, so every campaign silently resolved to 'sales'.
    const snap = snapshot.data as {
      meta?: { objective?: string };
      rawCampaign?: { objective?: string };
    };
    const rawMeta = { objective: snap.meta?.objective ?? snap.rawCampaign?.objective };

    // Deterministic resolution ladder — for now default 'sales'; extended
    // when Campaign/Company adapters expose campaign.objective + company.primaryObjective.
    let objective: ObjectiveKey = 'sales';
    let source: ObjectiveData['source'] = 'company_default';
    const fromMeta = mapMetaObjective(rawMeta?.objective);
    if (fromMeta) {
      objective = fromMeta;
      source = 'meta_objective';
    }

    const profile = getProfile(objective);
    return {
      objective,
      source,
      primaryKPI: profile.primaryKPI,
      supportingKPIs: [...profile.supportingKPIs],
      weights: { ...profile.weights },
      thresholds: {
        healthy: { ...profile.thresholds.healthy },
        warning: { ...profile.thresholds.warning },
        critical: { ...profile.thresholds.critical },
      },
      policy: { ...profile.policy },
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'objective'>,
    data: ObjectiveData,
  ): number {
    switch (data.source) {
      case 'campaign_field':
        return 1;
      case 'meta_objective':
        return 0.85;
      case 'company_default':
        return 0.65;
      case 'inferred':
        return 0.4;
      default:
        return 0.5;
    }
  }

  protected buildEvidence(
    _deps: ComputeDeps<'objective'>,
    data: ObjectiveData,
  ): Evidence[] {
    return [
      {
        kind: 'company_config',
        ref: `objective:${data.objective}`,
        weight: 1,
        note: `source=${data.source}`,
      },
    ];
  }
}
