import {
  resolveOptimizationGoalEvidenceSpec,
  selectOptimizationGoalEvidence,
} from './optimization-goal-metrics';

describe('optimization-goal metric evidence', () => {
  describe('supported goal mappings', () => {
    it('derives VALUE sales raw ROAS only from persisted spend and revenue', () => {
      const selected = selectOptimizationGoalEvidence({
        objective: 'OUTCOME_SALES',
        optimizationGoals: ['VALUE'],
        metrics: { spend: 250, revenue: 500, roas: 99 },
      });

      expect(selected).toMatchObject({
        status: 'available',
        value: 2,
        spec: {
          normalizedObjective: 'sales',
          evidenceKind: 'sales_value',
          metricKey: 'rawRoas',
          sourceMetricKeys: ['spend', 'revenue'],
          label: 'Raw ROAS',
          unit: 'x',
          lowerIsBetter: false,
        },
      });
    });

    it.each([
      {
        objective: 'sales',
        goal: 'OFFSITE_CONVERSIONS',
        metrics: { conversions: 7 },
        metricKey: 'conversions',
        label: 'Attributed sales conversions',
        unit: 'conversions',
        kind: 'sales_conversion',
        value: 7,
      },
      {
        objective: 'OUTCOME_AWARENESS',
        goal: 'REACH',
        metrics: { reach: 1500 },
        metricKey: 'reach',
        label: 'People reached',
        unit: 'people',
        kind: 'awareness',
        value: 1500,
      },
      {
        objective: 'awareness',
        goal: 'IMPRESSIONS',
        metrics: { impressions: 2000 },
        metricKey: 'impressions',
        label: 'Impressions',
        unit: 'impressions',
        kind: 'awareness',
        value: 2000,
      },
      {
        objective: 'OUTCOME_TRAFFIC',
        goal: 'LANDING_PAGE_VIEWS',
        metrics: { landingPageView: 82 },
        metricKey: 'landingPageView',
        label: 'Landing-page views',
        unit: 'views',
        kind: 'traffic',
        value: 82,
      },
      {
        objective: 'traffic',
        goal: 'LINK_CLICKS',
        metrics: { inlineLinkClicks: 91 },
        metricKey: 'inlineLinkClicks',
        label: 'Inline link clicks',
        unit: 'clicks',
        kind: 'traffic',
        value: 91,
      },
      {
        objective: 'OUTCOME_ENGAGEMENT',
        goal: 'THRUPLAY',
        metrics: { thruplay: 44 },
        metricKey: 'thruplay',
        label: 'ThruPlays',
        unit: 'plays',
        kind: 'video',
        value: 44,
      },
    ])(
      'selects $goal evidence using its exact persisted metric',
      ({ objective, goal, metrics, metricKey, label, unit, kind, value }) => {
        const selected = selectOptimizationGoalEvidence({
          objective,
          optimizationGoals: [goal],
          metrics,
        });

        expect(selected).toMatchObject({
          status: 'available',
          value,
          spec: {
            metricKey,
            label,
            unit,
            evidenceKind: kind,
            lowerIsBetter: false,
          },
        });
      },
    );

    it('treats repeated casing variants of one goal as one goal', () => {
      const resolved = resolveOptimizationGoalEvidenceSpec({
        objective: 'OUTCOME_AWARENESS',
        optimizationGoals: [' reach ', 'REACH'],
      });

      expect(resolved).toMatchObject({
        supported: true,
        optimizationGoals: ['REACH'],
        spec: { metricKey: 'reach' },
      });
    });

    it('recognizes legacy video_views plus THRUPLAY as video evidence', () => {
      const resolved = resolveOptimizationGoalEvidenceSpec({
        objective: 'video_views',
        optimizationGoals: ['THRUPLAY'],
      });

      expect(resolved).toMatchObject({
        supported: true,
        spec: {
          normalizedObjective: 'video_views',
          objectiveLabel: 'Video views',
          evidenceKind: 'video',
        },
      });
    });
  });

  describe('availability is fail closed', () => {
    it('keeps missing metrics unavailable instead of manufacturing zero', () => {
      const selected = selectOptimizationGoalEvidence({
        objective: 'OUTCOME_TRAFFIC',
        optimizationGoals: ['LANDING_PAGE_VIEWS'],
        metrics: { clicks: 900 },
      });

      expect(selected).toMatchObject({
        status: 'unavailable',
        code: 'metric_unavailable',
        value: null,
        missingMetricKeys: ['landingPageView'],
      });
      expect(selected.reason).toContain('persisted landingPageView');
    });

    it('accepts an explicitly persisted zero result as observed evidence', () => {
      const selected = selectOptimizationGoalEvidence({
        objective: 'OUTCOME_SALES',
        optimizationGoals: ['OFFSITE_CONVERSIONS'],
        metrics: { conversions: 0 },
      });

      expect(selected).toMatchObject({
        status: 'available',
        available: true,
        value: 0,
      });
    });

    it('accepts zero VALUE revenue when spend is positive', () => {
      const selected = selectOptimizationGoalEvidence({
        objective: 'OUTCOME_SALES',
        optimizationGoals: ['VALUE'],
        metrics: { spend: 100, revenue: 0 },
      });

      expect(selected).toMatchObject({ status: 'available', value: 0 });
    });

    it.each([
      [{ revenue: 100 }, ['spend']],
      [{ spend: 0, revenue: 100 }, ['spend']],
      [{ spend: '100', revenue: 100 }, ['spend']],
      [{ spend: 100, revenue: Number.NaN }, ['revenue']],
      [{ spend: 100, revenue: -1 }, ['revenue']],
    ])(
      'withholds VALUE evidence when its exact inputs are invalid: %p',
      (metrics, missingMetricKeys) => {
        const selected = selectOptimizationGoalEvidence({
          objective: 'OUTCOME_SALES',
          optimizationGoals: ['VALUE'],
          metrics,
        });

        expect(selected).toMatchObject({
          status: 'unavailable',
          value: null,
          missingMetricKeys,
        });
      },
    );

    it('does not accept a broader clicks field for LINK_CLICKS', () => {
      const selected = selectOptimizationGoalEvidence({
        objective: 'OUTCOME_TRAFFIC',
        optimizationGoals: ['LINK_CLICKS'],
        metrics: { clicks: 25 },
      });

      expect(selected).toMatchObject({
        status: 'unavailable',
        value: null,
        missingMetricKeys: ['inlineLinkClicks'],
      });
    });
  });

  describe('unsupported inputs do not fall back', () => {
    it.each([
      {
        objective: 'OUTCOME_SALES',
        goals: [],
        code: 'missing_optimization_goal',
      },
      {
        objective: 'OUTCOME_SALES',
        goals: ['VALUE', ''],
        code: 'missing_optimization_goal',
      },
      {
        objective: 'OUTCOME_SALES',
        goals: ['VALUE', 'OFFSITE_CONVERSIONS'],
        code: 'mixed_optimization_goals',
      },
      {
        objective: 'OUTCOME_SALES',
        goals: ['POST_ENGAGEMENT'],
        code: 'unsupported_optimization_goal',
      },
      {
        objective: 'SOMETHING_NEW',
        goals: ['VALUE'],
        code: 'unsupported_objective',
      },
      {
        objective: 'OUTCOME_AWARENESS',
        goals: ['VALUE'],
        code: 'objective_goal_mismatch',
      },
      {
        objective: 'OUTCOME_SALES',
        goals: ['THRUPLAY'],
        code: 'objective_goal_mismatch',
      },
    ])(
      'returns $code for $objective / $goals',
      ({ objective, goals, code }) => {
        const selected = selectOptimizationGoalEvidence({
          objective,
          optimizationGoals: goals,
          metrics: {},
        });

        expect(selected).toMatchObject({
          status: 'unsupported',
          supported: false,
          available: false,
          code,
          spec: null,
          value: null,
        });
        expect(selected.unsupportedReason).toEqual(expect.any(String));
        expect(selected.unsupportedReason?.length).toBeGreaterThan(10);
      },
    );
  });
});
