import { LIFECYCLE_GATES } from '../../../src/intelligence/lifecycle/lifecycle-gates';

describe('lifecycle action reachability', () => {
  it.each(['scaling', 'stable', 'fatigue'] as const)(
    'makes total-budget reduction reachable when %s exposes canReduceBudget',
    (stage) => {
      expect(LIFECYCLE_GATES[stage].gates.canReduceBudget).toBe(true);
      expect(LIFECYCLE_GATES[stage].allowedActions).toContain(
        'reduce_total_budget',
      );
    },
  );

  it('keeps ordinary learning-stage budget changes protected', () => {
    expect(LIFECYCLE_GATES.learning.gates.canReduceBudget).toBe(false);
    expect(LIFECYCLE_GATES.learning.allowedActions).not.toContain(
      'reduce_total_budget',
    );
  });
});
