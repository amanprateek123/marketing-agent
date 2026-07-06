import {
  ComputeError,
  DagValidationError,
  EngineError,
  MissingDependencyError,
  SkipError,
} from '../../../src/intelligence/shared/engine.errors';

describe('engine.errors', () => {
  it('EngineError carries engine + reason + fatal flag', () => {
    const err = new EngineError('snapshot', 'meta_5xx', 'meta returned 500', true);
    expect(err).toBeInstanceOf(Error);
    expect(err.engine).toBe('snapshot');
    expect(err.reason).toBe('meta_5xx');
    expect(err.fatal).toBe(true);
    expect(err.name).toBe('EngineError');
  });

  it('MissingDependencyError sets fatal=true', () => {
    const err = new MissingDependencyError('objective', 'snapshot');
    expect(err.fatal).toBe(true);
    expect(err.reason).toBe('missing_dependency');
    expect(err.message).toMatch(/missing snapshot/);
  });

  it('SkipError sets fatal=false', () => {
    const err = new SkipError('revenue', 'objective_not_sales');
    expect(err.fatal).toBe(false);
    expect(err.reason).toBe('objective_not_sales');
  });

  it('ComputeError wraps a cause', () => {
    const cause = new Error('typed');
    const err = new ComputeError('trend', 'div_by_zero', cause);
    expect(err.cause).toBe(cause);
    expect(err.message).toMatch(/div_by_zero/);
    expect(err.message).toMatch(/typed/);
  });

  it('DagValidationError is a plain Error subclass with proper name', () => {
    const err = new DagValidationError('bad dep');
    expect(err.name).toBe('DagValidationError');
    expect(err.message).toBe('bad dep');
  });
});
