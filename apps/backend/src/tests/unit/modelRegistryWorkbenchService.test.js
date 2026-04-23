import {
  computeRate,
  computeDelta,
  classifyLatencyBand,
  classifyFallbackBand,
  classifySafetyFlagBand,
  classifyAccuracyBand,
  classifyDriftBand,
  classifyEvalRecommendation,
  escalateSeverity,
  escalateRecommendation,
  buildRegistryActions,
  summarizeEval,
} from '../../services/ai/modelRegistryWorkbenchService.js';

describe('model registry workbench helpers', () => {
  describe('computeRate', () => {
    it('returns 5.00 for 5 over 100', () => {
      expect(computeRate({ numerator: 5, denominator: 100 })).toBe(5);
    });

    it('returns 0 when denominator is zero', () => {
      expect(computeRate({ numerator: 5, denominator: 0 })).toBe(0);
    });
  });

  describe('computeDelta', () => {
    it('returns delta close to 0.1 for 0.9 vs 0.8', () => {
      const result = computeDelta({ current: 0.9, previous: 0.8 });
      expect(result.delta).toBeCloseTo(0.1, 2);
    });

    it('returns delta_pct of 0 when previous is zero', () => {
      const result = computeDelta({ current: 1, previous: 0 });
      expect(result.delta_pct).toBe(0);
    });
  });

  describe('classifyLatencyBand', () => {
    it('classifies 300ms as fast', () => {
      expect(classifyLatencyBand(300)).toBe('fast');
    });

    it('classifies 1000ms as acceptable', () => {
      expect(classifyLatencyBand(1000)).toBe('acceptable');
    });

    it('classifies 2500ms as slow', () => {
      expect(classifyLatencyBand(2500)).toBe('slow');
    });

    it('classifies 5000ms as breach', () => {
      expect(classifyLatencyBand(5000)).toBe('breach');
    });
  });

  describe('classifyFallbackBand', () => {
    it('classifies 0.5% as ok', () => {
      expect(classifyFallbackBand(0.5)).toBe('ok');
    });

    it('classifies 3% as watch', () => {
      expect(classifyFallbackBand(3)).toBe('watch');
    });

    it('classifies 8% as warning', () => {
      expect(classifyFallbackBand(8)).toBe('warning');
    });

    it('classifies 20% as breach', () => {
      expect(classifyFallbackBand(20)).toBe('breach');
    });
  });

  describe('classifySafetyFlagBand', () => {
    it('classifies 0.1% as ok', () => {
      expect(classifySafetyFlagBand(0.1)).toBe('ok');
    });

    it('classifies 1% as watch', () => {
      expect(classifySafetyFlagBand(1)).toBe('watch');
    });

    it('classifies 3% as warning', () => {
      expect(classifySafetyFlagBand(3)).toBe('warning');
    });

    it('classifies 6% as breach', () => {
      expect(classifySafetyFlagBand(6)).toBe('breach');
    });
  });

  describe('classifyAccuracyBand', () => {
    it('classifies 0.97 as excellent', () => {
      expect(classifyAccuracyBand(0.97)).toBe('excellent');
    });

    it('classifies 0.92 as good', () => {
      expect(classifyAccuracyBand(0.92)).toBe('good');
    });

    it('classifies 0.82 as acceptable', () => {
      expect(classifyAccuracyBand(0.82)).toBe('acceptable');
    });

    it('classifies 0.7 as poor', () => {
      expect(classifyAccuracyBand(0.7)).toBe('poor');
    });
  });

  describe('classifyDriftBand', () => {
    it('classifies 0.02 as stable', () => {
      expect(classifyDriftBand(0.02)).toBe('stable');
    });

    it('classifies 0.1 as watch', () => {
      expect(classifyDriftBand(0.1)).toBe('watch');
    });

    it('classifies 0.2 as warning', () => {
      expect(classifyDriftBand(0.2)).toBe('warning');
    });

    it('classifies 0.4 as breach', () => {
      expect(classifyDriftBand(0.4)).toBe('breach');
    });
  });

  describe('classifyEvalRecommendation', () => {
    it('quarantines with critical severity when latency breaches', () => {
      const result = classifyEvalRecommendation({
        current: {
          avg_latency_ms: 5000,
          fallback_rate_pct: 1,
          safety_flag_rate_pct: 0.1,
          accuracy: 0.9,
          f1_score: 0.9,
          drift_score: 0.02,
        },
      });
      expect(result.recommendation).toBe('quarantine');
      expect(result.severity).toBe('critical');
    });

    it('rolls back with high severity when accuracy is poor', () => {
      const result = classifyEvalRecommendation({
        current: {
          avg_latency_ms: 1000,
          fallback_rate_pct: 1,
          safety_flag_rate_pct: 0.1,
          accuracy: 0.7,
          f1_score: 0.7,
          drift_score: 0.02,
        },
      });
      expect(result.recommendation).toBe('rollback');
      expect(result.severity).toBe('high');
    });

    it('recommends promote with READY_TO_PROMOTE signal when current beats baseline', () => {
      const result = classifyEvalRecommendation({
        current: {
          avg_latency_ms: 500,
          fallback_rate_pct: 0.5,
          safety_flag_rate_pct: 0.1,
          accuracy: 0.96,
          f1_score: 0.95,
          drift_score: 0.02,
        },
        baseline: { accuracy: 0.9, f1_score: 0.89 },
      });
      expect(result.recommendation).toBe('promote');
      expect(result.severity).toBe('low');
      expect(result.signals.some((s) => s.code === 'READY_TO_PROMOTE')).toBe(true);
    });

    it('rolls back with REGRESSION signal when current regresses against baseline', () => {
      const result = classifyEvalRecommendation({
        current: {
          avg_latency_ms: 500,
          fallback_rate_pct: 0.5,
          safety_flag_rate_pct: 0.1,
          accuracy: 0.85,
          f1_score: 0.84,
          drift_score: 0.02,
        },
        baseline: { accuracy: 0.92, f1_score: 0.9 },
      });
      expect(result.recommendation).toBe('rollback');
      expect(result.severity).toBe('high');
      expect(result.signals.some((s) => s.code === 'REGRESSION')).toBe(true);
    });

    it('recommends no_action with STABLE signal when metrics are healthy and no baseline', () => {
      const result = classifyEvalRecommendation({
        current: {
          avg_latency_ms: 500,
          fallback_rate_pct: 0.5,
          safety_flag_rate_pct: 0.1,
          accuracy: 0.9,
          f1_score: 0.9,
          drift_score: 0.02,
        },
      });
      expect(result.recommendation).toBe('no_action');
      expect(result.severity).toBe('low');
      expect(result.signals.some((s) => s.code === 'STABLE')).toBe(true);
    });
  });

  describe('escalateSeverity', () => {
    it('returns the highest severity in the list', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateRecommendation', () => {
    it('returns the highest-priority recommendation in the list', () => {
      expect(escalateRecommendation(['no_action', 'rollback', 'promote'])).toBe('rollback');
    });
  });

  describe('buildRegistryActions', () => {
    it('includes at least one quarantine-related line for a quarantine recommendation', () => {
      const actions = buildRegistryActions({
        recommendation: 'quarantine',
        signals: [],
      });
      expect(actions.some((line) => /quarantine/i.test(line))).toBe(true);
    });
  });

  describe('summarizeEval', () => {
    it('includes model key and recommendation in the summary string', () => {
      const summary = summarizeEval({
        modelKey: 'gpt-x',
        version: 'v1',
        suite: 'canary',
        recommendation: 'no_action',
        severity: 'low',
        accuracy: 0.9,
        driftScore: 0.01,
      });
      expect(summary).toContain('gpt-x');
      expect(summary).toContain('no_action');
    });
  });
});
