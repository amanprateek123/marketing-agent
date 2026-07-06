export interface Evidence {
  kind:
    | 'snapshot'
    | 'history'
    | 'benchmark'
    | 'company_config'
    | 'context'
    | 'memory'
    | 'learning'
    | 'external_api';
  ref: string;
  weight: number;
  note?: string;
}

export interface EngineContext<T> {
  data: T;
  confidence: number;
  evidence: Evidence[];
  version: string;
  computedAt: Date;
  ms: number;
  deterministic: boolean;
  degraded?: { mode: string; fullDataAvailable: boolean };
}

export function clampConfidence(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function weightedConfidence(components: Array<{ value: number; weight: number }>): number {
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const sum = components.reduce((s, c) => s + clampConfidence(c.value) * c.weight, 0);
  return clampConfidence(sum / totalWeight);
}
