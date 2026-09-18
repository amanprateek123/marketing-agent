import {
  INTELLIGENCE_CADENCE_MS,
  INTELLIGENCE_QUEUES,
  tenantJobName,
} from '../../../../src/intelligence/scheduler/intelligence-queue.constants';

describe('intelligence-queue constants', () => {
  it('locks queue names to the expected strings', () => {
    expect(INTELLIGENCE_QUEUES.SNAPSHOT).toBe('intelligence-snapshot');
    expect(INTELLIGENCE_QUEUES.CYCLE).toBe('intelligence-cycle');
  });

  it('locks cadences to 15 min and 1 hour', () => {
    expect(INTELLIGENCE_CADENCE_MS.SNAPSHOT).toBe(15 * 60 * 1000);
    expect(INTELLIGENCE_CADENCE_MS.CYCLE).toBe(60 * 60 * 1000);
  });

  it('tenantJobName produces the {base}:tenant:{id} format', () => {
    expect(tenantJobName('snapshot', 'astro')).toBe('snapshot:tenant:astro');
    expect(tenantJobName('cycle', 'cosmo')).toBe('cycle:tenant:cosmo');
  });
});
