import { EngineRegistry } from '../../../src/intelligence/shared/engine-registry';
import { DagValidationError } from '../../../src/intelligence/shared/engine.errors';

describe('EngineRegistry: registration + DAG validation', () => {
  let registry: EngineRegistry;

  beforeEach(() => {
    registry = new EngineRegistry();
  });

  it('registers valid engine descriptors', () => {
    registry.register({ name: 'snapshot', step: 1, version: '1.0.0', dependsOn: [] });
    registry.register({ name: 'objective', step: 2, version: '1.0.0', dependsOn: ['snapshot'] });
    expect(registry.all()).toHaveLength(2);
    expect(registry.get('snapshot')?.step).toBe(1);
  });

  it('rejects duplicate engine registration', () => {
    registry.register({ name: 'snapshot', step: 1, version: '1.0.0', dependsOn: [] });
    expect(() =>
      registry.register({ name: 'snapshot', step: 1, version: '2.0.0', dependsOn: [] }),
    ).toThrow(DagValidationError);
  });

  it('rejects step number not matching canonical position', () => {
    expect(() =>
      registry.register({ name: 'objective', step: 99, version: '1.0.0', dependsOn: [] }),
    ).toThrow(DagValidationError);
  });

  it('validateDag() throws on unknown dependency name', () => {
    // Bypass the register-time step check by ignoring the type
    (registry as unknown as { registry: Map<string, unknown> }).registry.set('objective', {
      name: 'objective',
      step: 2,
      version: '1.0.0',
      dependsOn: ['not_a_real_engine'],
    });
    expect(() => registry.validateDag()).toThrow(DagValidationError);
  });

  it('validateDag() throws when a dep points at a higher-step engine', () => {
    registry.register({ name: 'snapshot', step: 1, version: '1.0.0', dependsOn: [] });
    (registry as unknown as { registry: Map<string, unknown> }).registry.set('objective', {
      name: 'objective',
      step: 2,
      version: '1.0.0',
      dependsOn: ['signal'], // step 6 > 2 → invalid
    });
    expect(() => registry.validateDag()).toThrow(/cannot depend on signal/);
  });

  it('all() returns descriptors sorted by step', () => {
    registry.register({ name: 'trend', step: 4, version: '1.0.0', dependsOn: ['snapshot'] });
    registry.register({ name: 'snapshot', step: 1, version: '1.0.0', dependsOn: [] });
    registry.register({ name: 'objective', step: 2, version: '1.0.0', dependsOn: ['snapshot'] });
    const names = registry.all().map((d) => d.name);
    expect(names).toEqual(['snapshot', 'objective', 'trend']);
  });

  it('onApplicationBootstrap runs validateDag', () => {
    registry.register({ name: 'snapshot', step: 1, version: '1.0.0', dependsOn: [] });
    registry.register({ name: 'objective', step: 2, version: '1.0.0', dependsOn: ['snapshot'] });
    expect(() => registry.onApplicationBootstrap()).not.toThrow();
  });
});
