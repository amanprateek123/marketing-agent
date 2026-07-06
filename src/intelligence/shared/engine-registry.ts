import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DagValidationError } from './engine.errors';
import { EngineDescriptor } from './engine.interface';
import { EngineSliceKey, ENGINE_STEP } from '../orchestrator/decision-context';

/**
 * Central registry of engine descriptors. Enforces the DAG contract at
 * bootstrap: every dependency must point at an engine with a strictly
 * lower step.
 *
 * Validation runs in onApplicationBootstrap (fires *after* all engine
 * providers' onModuleInit has completed), so every engine has a chance
 * to register itself before the DAG is checked.
 */
@Injectable()
export class EngineRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(EngineRegistry.name);
  private readonly registry = new Map<EngineSliceKey, EngineDescriptor>();

  register(descriptor: EngineDescriptor): void {
    if (this.registry.has(descriptor.name)) {
      throw new DagValidationError(
        `Duplicate engine registration: ${descriptor.name}`,
      );
    }
    if (ENGINE_STEP[descriptor.name] !== descriptor.step) {
      throw new DagValidationError(
        `${descriptor.name} declared step ${descriptor.step} but canonical step is ${ENGINE_STEP[descriptor.name]}`,
      );
    }
    this.registry.set(descriptor.name, descriptor);
    this.logger.log(
      `registered ${descriptor.name}@${descriptor.version} (step ${descriptor.step})`,
    );
  }

  get(name: EngineSliceKey): EngineDescriptor | undefined {
    return this.registry.get(name);
  }

  all(): EngineDescriptor[] {
    return Array.from(this.registry.values()).sort((a, b) => a.step - b.step);
  }

  onApplicationBootstrap(): void {
    this.validateDag();
  }

  /**
   * Called at bootstrap. Every engine's dependsOn must reference an engine
   * with a strictly lower step. Throws DagValidationError on any violation.
   */
  validateDag(): void {
    for (const engine of this.all()) {
      for (const dep of engine.dependsOn) {
        const depStep = ENGINE_STEP[dep];
        if (depStep === undefined) {
          throw new DagValidationError(
            `${engine.name} depends on unknown engine ${dep}`,
          );
        }
        if (depStep >= engine.step) {
          throw new DagValidationError(
            `${engine.name}(step ${engine.step}) cannot depend on ${dep}(step ${depStep})`,
          );
        }
      }
    }
    this.logger.log(`DAG validated across ${this.registry.size} engine(s)`);
  }
}
