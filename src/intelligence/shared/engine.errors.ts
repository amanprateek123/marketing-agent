/**
 * Base class for typed intelligence-pipeline errors. Engines throw these;
 * BaseEngine catches, records on the cycle, and emits <name>.failed.
 */
export class EngineError extends Error {
  constructor(
    public readonly engine: string,
    public readonly reason: string,
    message: string,
    public readonly fatal: boolean = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class MissingDependencyError extends EngineError {
  constructor(engine: string, dependency: string) {
    super(
      engine,
      'missing_dependency',
      `${engine} cannot run: missing ${dependency} slice on cycle`,
      true,
    );
  }
}

export class SkipError extends EngineError {
  constructor(engine: string, reason: string) {
    super(engine, reason, `${engine} skipped: ${reason}`, false);
  }
}

export class ComputeError extends EngineError {
  constructor(engine: string, reason: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? '');
    super(engine, reason, `${engine} compute failed: ${reason}${detail ? ` (${detail})` : ''}`, false, cause);
  }
}

export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}
