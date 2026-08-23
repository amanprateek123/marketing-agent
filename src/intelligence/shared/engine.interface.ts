import {
  DecisionContext,
  EngineSliceKey,
} from '../orchestrator/decision-context';
import type { SliceIdentity } from './slice-repository.service';

/**
 * The contract every intelligence engine implements. Engines rarely
 * implement this directly — they extend BaseEngine which handles
 * subscription / load / persist / emit around the abstract compute()
 * method.
 */
export interface Engine<K extends EngineSliceKey = EngineSliceKey> {
  readonly name: K;
  readonly step: number;
  readonly version: string;
  readonly dependsOn: readonly EngineSliceKey[];
  readonly triggerOn: readonly string[];

  execute(cycleId: string, identityHint?: SliceIdentity): Promise<void>;
  canRun?(cycleId: string): Promise<boolean>;
}

/**
 * Descriptor engines expose for DAG validation at bootstrap.
 * The registry checks all deps have a strictly lower step.
 */
export interface EngineDescriptor {
  name: EngineSliceKey;
  step: number;
  version: string;
  dependsOn: readonly EngineSliceKey[];
}

/**
 * What a subclass's compute() receives — a Partial view of DecisionContext.
 * The base class validates that every slice in `dependsOn` is present
 * before invoking compute, so subclass code may access those slices
 * without null-checks; other slices remain optional.
 *
 * `K` is retained for future generic constraints (e.g. narrowing the
 * required slices via a mapped-type) but for now every engine gets the
 * same permissive shape — Partial<DecisionContext>.
 */
export type ComputeDeps<K extends EngineSliceKey> = K extends K
  ? Partial<DecisionContext>
  : never;
