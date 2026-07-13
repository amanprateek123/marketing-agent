import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence, weightedConfidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { ConfidenceData } from '../orchestrator/decision-context';

@Injectable()
export class ConfidenceEngine extends BaseEngine<'confidence', ConfidenceData> {
  readonly name = 'confidence' as const;
  readonly step = 11;
  readonly version = '1.0.0';
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
  ] as const;

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

  // confidence depends on 10 slices spanning parallel branches of the DAG
  // (e.g. diagnosis and forecast don't depend on each other, so their
  // completion order isn't guaranteed) — triggering on forecast.completed
  // alone meant confidence ran as soon as forecast finished regardless of
  // whether the other 9 deps existed yet, failing with MissingDependencyError
  // on effectively every cycle. Same fan-in pattern PortfolioEngine already
  // uses for its 2 slow deps (business/revenue), extended to all 10: each
  // dependency's completion re-attempts execute(), which is a no-op failure
  // (fast, harmlessly logged) until the last one to actually finish arrives
  // and every dependency is present — that attempt succeeds.
  //
  // Deliberately 10 stacked @OnEvent(string) decorators, NOT one
  // @OnEvent(string[]) — confirmed the installed eventemitter2 version's
  // plain .on() doesn't special-case an array `type` argument; it registers
  // the listener under the array's stringified value as a single bogus key,
  // so it silently never fires for any real single-event emission. Stacking
  // individual decorators makes NestJS register 10 separate string
  // subscriptions instead (each call to extendArrayMetadata appends one
  // {event, options} entry, and the loader binds each entry separately).
  @OnEvent('intelligence.snapshot.completed')
  @OnEvent('intelligence.objective.completed')
  @OnEvent('intelligence.lifecycle.completed')
  @OnEvent('intelligence.trend.completed')
  @OnEvent('intelligence.revenue.completed')
  @OnEvent('intelligence.signal.completed')
  @OnEvent('intelligence.diagnosis.completed')
  @OnEvent('intelligence.business.completed')
  @OnEvent('intelligence.portfolio.completed')
  @OnEvent('intelligence.forecast.completed')
  async onDependencyCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    // Pre-check readiness before calling execute(): with 10 parallel
    // dependencies firing in a non-deterministic order, up to 9 of these 10
    // event deliveries per cycle are guaranteed to arrive before every dep
    // is ready. execute() used to be called unconditionally and would throw
    // MissingDependencyError for every one of those — harmless by design
    // (the last dependency to land always succeeds) but NestJS logs every
    // exception thrown inside an @OnEvent handler at ERROR severity, so a
    // normal cycle produced up to 9 scary-looking "cannot run: missing X
    // slice" ERROR lines that were never real failures. Checking readiness
    // first (same idea as PortfolioEngine's 2-dep readyGate, generalized to
    // 10 deps via a slice-existence count) makes the expected "still
    // waiting" case a silent no-op instead of a thrown-and-logged error.
    if (!(await this.sliceRepo.hasSlices(payload.cycleId, this.dependsOn))) {
      return;
    }
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

  protected async compute(deps: ComputeDeps<'confidence'>): Promise<ConfidenceData> {
    const perEngine: Record<string, number> = {};
    for (const k of this.dependsOn) {
      const slice = (deps as Record<string, { confidence?: number }>)[k];
      perEngine[k] = slice?.confidence ?? 0;
    }
    const meanConf = weightedConfidence(
      Object.values(perEngine).map((v) => ({ value: v, weight: 1 })),
    );

    // Worst-of-core floor — scoped to the engines whose weakness genuinely
    // means "we don't understand what's happening" (snapshot/revenue/
    // signal/diagnosis). Previously this took the min across ALL 10 deps,
    // including engines with a known, permanent, narrower scope by design
    // (portfolio is explicitly single-campaign-scoped pending a future
    // batch-orchestration feature; business/forecast are context, not
    // action-justifying evidence). That meant one structurally-capped
    // engine permanently dragged every decision's confidence down by up to
    // 30 points, regardless of whether that engine's weakness had anything
    // to do with the action being considered.
    const CORE_ENGINES = ['snapshot', 'revenue', 'signal', 'diagnosis'] as const;
    const minCore = Math.min(...CORE_ENGINES.map((k) => perEngine[k] ?? 0));

    const snap = deps.snapshot!.data as {
      freshnessSec?: number;
      missingFields?: string[];
      metrics?: { campaignLevel?: Record<string, number> };
    };
    const freshnessSec = snap.freshnessSec ?? 0;
    const snapshotCoverage = 1 - Math.min(1, (snap.missingFields?.length ?? 0) / 5);

    // Statistical power: previously purchases-count alone, which ignores
    // traffic volume entirely — a campaign can clear a purchases threshold
    // on a tiny, noisy sample of impressions (CTR-based signals like
    // ctr_decay/hook_burn/creative_fatigue would then be trusted on thin
    // data) just as easily as on a well-trafficked one. Power is only as
    // strong as its WEAKEST evidentiary leg, so this takes the min of the
    // purchase-volume read (CVR/ROAS evidence) and the impression-volume
    // read (CTR evidence) rather than either one alone.
    const purchases = (snap.metrics?.campaignLevel?.purchases as number) ?? 0;
    const impressions = (snap.metrics?.campaignLevel?.impressions as number) ?? 0;
    const purchasePower = Math.min(1, purchases / 25);
    const impressionPower = Math.min(1, impressions / 3000);
    const statisticalPower = Math.min(purchasePower, impressionPower);

    // Real history depth from the trend window (days of snapshot history
    // actually available) — previously hardcoded to 0 always, itself a
    // false-confidence stub inside the engine that's supposed to catch them.
    const trend = deps.trend?.data;
    const historyDepthDays =
      trend?.perMetric.roas?.windowSize ?? trend?.perMetric.spend?.windowSize ?? 0;

    const quality = {
      dataFreshnessSec: freshnessSec,
      snapshotCoverage,
      historyDepthDays,
      statisticalPower,
    };
    const qualityScore =
      snapshotCoverage * 0.4 +
      statisticalPower * 0.4 +
      (freshnessSec < 1800 ? 0.2 : freshnessSec < 3600 ? 0.1 : 0);

    const overall = 0.3 * minCore + 0.4 * meanConf + 0.3 * qualityScore;

    const stage = deps.lifecycle!.data.stage;
    const stageForbidsExec = ['learning', 'launching', 'unknown', 'draft', 'pending_approval'].includes(
      stage,
    );

    const okToRecommend = overall >= 0.5 && perEngine.snapshot >= 0.6;
    const okToExecute =
      overall >= 0.7 &&
      quality.statisticalPower >= 0.5 &&
      !stageForbidsExec &&
      (deps.diagnosis?.confidence ?? 0) >= 0.55;

    const reasonsBlocked: string[] = [];
    if (overall < 0.7) reasonsBlocked.push(`overall<0.7 (${overall.toFixed(2)})`);
    if (quality.statisticalPower < 0.5)
      reasonsBlocked.push(`power<0.5 (${quality.statisticalPower.toFixed(2)})`);
    if (stageForbidsExec) reasonsBlocked.push(`lifecycle=${stage}`);
    if ((deps.diagnosis?.confidence ?? 0) < 0.55)
      reasonsBlocked.push(`diagnosis<0.55`);

    return {
      overall: Number(overall.toFixed(3)),
      perEngine,
      quality,
      gates: { okToRecommend, okToExecute, reasonsBlocked },
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'confidence'>,
    data: ConfidenceData,
  ): number {
    return data.overall;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'confidence'>,
    data: ConfidenceData,
  ): Evidence[] {
    return Object.entries(data.perEngine).map(([k, v]) => ({
      kind: 'context',
      ref: `engine:${k}`,
      weight: 1,
      note: `conf=${v.toFixed(2)}`,
    }));
  }
}
