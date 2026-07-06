/**
 * BullMQ queue names owned by the intelligence pipeline. Kept in their
 * own file so the legacy `src/scheduler/queue.constants.ts` stays
 * untouched during the coexistence phase.
 */
export const INTELLIGENCE_QUEUES = {
  SNAPSHOT: 'intelligence-snapshot', // 15-min per-tenant tick
  CYCLE: 'intelligence-cycle', // 1-hour per-tenant tick
} as const;

export type IntelligenceQueueName =
  (typeof INTELLIGENCE_QUEUES)[keyof typeof INTELLIGENCE_QUEUES];

/**
 * Repeatable-job cadences in ms.
 */
export const INTELLIGENCE_CADENCE_MS = {
  SNAPSHOT: 15 * 60 * 1000, // 900_000
  CYCLE: 60 * 60 * 1000, //  3_600_000
} as const;

/**
 * Job payloads.
 */
export interface SnapshotJobPayload {
  tenantId: string;
}

export interface CycleJobPayload {
  tenantId: string;
}

/**
 * Per-tenant repeatable-job key format. BullMQ derives the actual key
 * from the job name + tenantId + cron/every string; we reserve the
 * `tenant:` prefix on the job name so the two queues can host many
 * tenants independently.
 */
export function tenantJobName(base: string, tenantId: string): string {
  return `${base}:tenant:${tenantId}`;
}
