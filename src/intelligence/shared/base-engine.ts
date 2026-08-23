import { Logger, OnModuleInit } from '@nestjs/common';
import {
  DecisionContext,
  EngineSliceKey,
} from '../orchestrator/decision-context';
import { EngineContext, Evidence, clampConfidence } from './engine-context';
import { Engine, ComputeDeps } from './engine.interface';
import { EngineEventBus } from './engine-event-bus.service';
import { EngineRegistry } from './engine-registry';
import {
  ComputeError,
  IdentityResolutionError,
  MissingDependencyError,
} from './engine.errors';
import {
  isValidSliceIdentity,
  SliceIdentity,
  SliceRepository,
} from './slice-repository.service';

/**
 * Every intelligence engine extends this. Handles the four cross-cutting
 * concerns identically for all engines:
 *   1. subscribe to triggerOn events (via @OnEvent in subclass, or by
 *      manual dispatch from the orchestrator)
 *   2. load dependency slices from SliceRepository
 *   3. invoke compute() (subclass-specific pure function)
 *   4. persist slice + emit intelligence.<name>.completed
 *
 * Subclasses only implement compute(), computeConfidence(), buildEvidence().
 * See docs/engines/V2/RUNTIME-EXECUTION-PATTERN.md for details.
 */
export abstract class BaseEngine<K extends EngineSliceKey, TData>
  implements Engine<K>, OnModuleInit
{
  protected readonly logger: Logger;
  abstract readonly name: K;
  abstract readonly step: number;
  abstract readonly version: string;
  abstract readonly dependsOn: readonly EngineSliceKey[];

  get triggerOn(): readonly string[] {
    if (this.dependsOn.length === 0) return ['intelligence.cycle.started'];
    // Trigger on the deepest dep's completion (the last-in-order slice).
    // Subclass may override for parallel-fan-in cases.
    return this.dependsOn.map((d) => `intelligence.${d}.completed`);
  }

  constructor(
    protected readonly sliceRepo: SliceRepository,
    protected readonly eventBus: EngineEventBus,
    protected readonly registry: EngineRegistry,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  onModuleInit(): void {
    this.registry.register({
      name: this.name,
      step: this.step,
      version: this.version,
      dependsOn: this.dependsOn,
    });
  }

  /**
   * Entry point. Called by orchestrator (for cycle-driven engines) or
   * directly by the @OnEvent handler in the subclass.
   */
  async execute(cycleId: string): Promise<void> {
    // Load dependencies
    const loaded = await this.sliceRepo.loadManyWithIdentity(
      cycleId,
      this.dependsOn,
    );
    const deps = loaded.slices;
    for (const dep of this.dependsOn) {
      if (deps[dep] === undefined) {
        this.eventBus.emitFailed({
          cycleId,
          tenantId: '',
          campaignId: '',
          engine: this.name,
          at: new Date(),
          error: `missing dependency ${dep}`,
        });
        throw new MissingDependencyError(this.name, dep);
      }
    }

    // Persisted dependency identity is authoritative. Event handlers keep a
    // short-lived identity map for the first engine and as a fast-path hint,
    // but duplicate same-cycle events can overlap and delete that map while a
    // second invocation is still running. Never persist the empty fallback.
    const identity = await this.resolveCycleIdentity(
      cycleId,
      deps,
      loaded.identity,
    );

    // Check optional skip predicate
    if (this.canRun && !(await this.canRun(cycleId))) {
      this.eventBus.emitSkipped({
        cycleId,
        tenantId: identity.tenantId,
        campaignId: identity.campaignId,
        engine: this.name,
        at: new Date(),
        reason: 'canRun returned false',
      });
      return;
    }

    const start = Date.now();
    try {
      // Pass the immutable invocation identity all the way into compute().
      // Nest providers are singletons and EventEmitter can overlap two
      // campaign cycles on the same engine instance; subclasses must never
      // infer "the current cycle" from shared mutable state or the first
      // entry in an identity map.
      const data = await this.compute(deps as ComputeDeps<K>, cycleId);
      const slice: EngineContext<TData> = {
        data,
        confidence: clampConfidence(
          this.computeConfidence(deps as ComputeDeps<K>, data),
        ),
        evidence: this.buildEvidence(deps as ComputeDeps<K>, data),
        version: `${this.name}@${this.version}`,
        computedAt: new Date(),
        ms: Date.now() - start,
        deterministic: this.isDeterministic(),
      };

      await this.sliceRepo.write(
        {
          cycleId,
          tenantId: identity.tenantId,
          campaignId: identity.campaignId,
        },
        this.name,
        slice,
      );

      this.eventBus.emitCompleted({
        cycleId,
        tenantId: identity.tenantId,
        campaignId: identity.campaignId,
        engine: this.name,
        at: new Date(),
        confidence: slice.confidence,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.eventBus.emitFailed({
        cycleId,
        tenantId: identity.tenantId,
        campaignId: identity.campaignId,
        engine: this.name,
        at: new Date(),
        error: message,
      });
      throw new ComputeError(this.name, 'compute_threw', err);
    }
  }

  canRun?(cycleId: string): Promise<boolean>;

  private async resolveCycleIdentity(
    cycleId: string,
    deps: Partial<DecisionContext>,
    dependencyIdentity: SliceIdentity | null,
  ): Promise<SliceIdentity> {
    const eventIdentity = await this.identityFromDeps(cycleId, deps);

    if (isValidSliceIdentity(dependencyIdentity)) {
      if (
        isValidSliceIdentity(eventIdentity) &&
        (eventIdentity.tenantId !== dependencyIdentity.tenantId ||
          eventIdentity.campaignId !== dependencyIdentity.campaignId)
      ) {
        this.logger.warn(
          `Ignoring mismatched event identity for cycle ${cycleId}; using persisted dependency identity`,
        );
      }
      return dependencyIdentity;
    }

    // A dependency with an invalid legacy identity cannot establish the next
    // slice's identity. Recover from another valid slice in the same cycle.
    if (this.dependsOn.length > 0) {
      const persistedIdentity = await this.sliceRepo.identityForCycle(cycleId);
      if (isValidSliceIdentity(persistedIdentity)) return persistedIdentity;
      throw new IdentityResolutionError(this.name, cycleId);
    }

    // Snapshot is the first slice, so only its cycle-start payload can supply
    // identity. Reject an empty payload rather than creating corrupt history.
    if (isValidSliceIdentity(eventIdentity)) return eventIdentity;
    throw new IdentityResolutionError(this.name, cycleId);
  }

  /** Subclasses override to `false` for non-deterministic engines (Snapshot). */
  protected isDeterministic(): boolean {
    return true;
  }

  /** The engine-specific pure function. */
  protected abstract compute(
    deps: ComputeDeps<K>,
    cycleId: string,
  ): Promise<TData>;

  /** Confidence formula per each guide's §10. Default is 1.0 if all deps present. */
  protected abstract computeConfidence(
    deps: ComputeDeps<K>,
    data: TData,
  ): number;

  /** Traceable inputs. */
  protected abstract buildEvidence(
    deps: ComputeDeps<K>,
    data: TData,
  ): Evidence[];

  /**
   * Load (tenantId, campaignId) from a dep slice. If this engine has no
   * deps (Snapshot), subclass overrides to pull identity from elsewhere
   * (e.g. the BullMQ job payload).
   */
  protected async identityFromDeps(
    cycleId: string,
    _deps: Partial<DecisionContext>,
  ): Promise<{ tenantId: string; campaignId: string }> {
    void cycleId;
    void _deps;
    // Default: fetch the cycle doc for identity. Subclasses may override
    // to skip this DB round-trip when they already have identity in-hand.
    return { tenantId: '', campaignId: '' };
  }
}
