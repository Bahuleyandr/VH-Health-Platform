import {
  computeSuccessRate,
  computeErrorRate,
  classifySuccessBand,
  classifyErrorBand,
  classifyLatencyBand,
  classifyLastSeenBand,
  classifyExpiryBand,
  classifyAgentHealth,
  escalateSeverity,
  escalateRecommendation,
  buildAgentActions,
  summarizeAgent,
} from '../../services/ai/aiAgentLifecycleService.js';

describe('ai agent lifecycle helpers', () => {
  describe('computeSuccessRate', () => {
    it('returns percentage rounded to 2dp', () => {
      expect(computeSuccessRate({ successCount: 95, invocationCount: 100 })).toBe(95.00);
    });

    it('treats zero invocations as healthy baseline (100)', () => {
      expect(computeSuccessRate({ successCount: 0, invocationCount: 0 })).toBe(100);
    });

    it('caps at 100 when successes exceed invocations', () => {
      expect(computeSuccessRate({ successCount: 120, invocationCount: 100 })).toBe(100);
    });
  });

  describe('computeErrorRate', () => {
    it('returns percentage rounded to 2dp', () => {
      expect(computeErrorRate({ errorCount: 3, invocationCount: 100 })).toBe(3.00);
    });

    it('returns 0 when no invocations recorded', () => {
      expect(computeErrorRate({ errorCount: 0, invocationCount: 0 })).toBe(0);
    });
  });

  describe('classifySuccessBand', () => {
    it('classifies excellent at >= 99', () => {
      expect(classifySuccessBand(99.5)).toBe('excellent');
    });

    it('classifies good at >= 95', () => {
      expect(classifySuccessBand(96)).toBe('good');
    });

    it('classifies acceptable at >= 80', () => {
      expect(classifySuccessBand(85)).toBe('acceptable');
    });

    it('classifies poor below 80', () => {
      expect(classifySuccessBand(70)).toBe('poor');
    });

    it('returns unknown for null', () => {
      expect(classifySuccessBand(null)).toBe('unknown');
    });
  });

  describe('classifyErrorBand', () => {
    it('classifies ok below 1', () => {
      expect(classifyErrorBand(0.5)).toBe('ok');
    });

    it('classifies watch below 5', () => {
      expect(classifyErrorBand(3)).toBe('watch');
    });

    it('classifies warning below 15', () => {
      expect(classifyErrorBand(8)).toBe('warning');
    });

    it('classifies breach at >= 15', () => {
      expect(classifyErrorBand(20)).toBe('breach');
    });

    it('returns unknown for null', () => {
      expect(classifyErrorBand(null)).toBe('unknown');
    });
  });

  describe('classifyLatencyBand', () => {
    it('classifies fast below 500ms', () => {
      expect(classifyLatencyBand(200)).toBe('fast');
    });

    it('classifies acceptable below 1500ms', () => {
      expect(classifyLatencyBand(1000)).toBe('acceptable');
    });

    it('classifies slow below 3000ms', () => {
      expect(classifyLatencyBand(2500)).toBe('slow');
    });

    it('classifies breach at >= 3000ms', () => {
      expect(classifyLatencyBand(5000)).toBe('breach');
    });
  });

  describe('classifyLastSeenBand', () => {
    it('returns unknown for null', () => {
      expect(classifyLastSeenBand(null)).toBe('unknown');
    });

    it('classifies active within a week', () => {
      expect(classifyLastSeenBand(3)).toBe('active');
    });

    it('classifies watch within a month', () => {
      expect(classifyLastSeenBand(20)).toBe('watch');
    });

    it('classifies dormant within 90 days', () => {
      expect(classifyLastSeenBand(60)).toBe('dormant');
    });

    it('classifies stale beyond 90 days', () => {
      expect(classifyLastSeenBand(200)).toBe('stale');
    });
  });

  describe('classifyExpiryBand', () => {
    it('returns unknown for null', () => {
      expect(classifyExpiryBand(null)).toBe('unknown');
    });

    it('classifies expired for negative values', () => {
      expect(classifyExpiryBand(-3)).toBe('expired');
    });

    it('classifies imminent within 30 days', () => {
      expect(classifyExpiryBand(20)).toBe('imminent');
    });

    it('classifies warning within 90 days', () => {
      expect(classifyExpiryBand(60)).toBe('warning');
    });

    it('classifies watch within 180 days', () => {
      expect(classifyExpiryBand(150)).toBe('watch');
    });

    it('classifies ok beyond 180 days', () => {
      expect(classifyExpiryBand(300)).toBe('ok');
    });
  });

  describe('classifyAgentHealth', () => {
    it('returns no_action/low for a healthy agent', () => {
      const result = classifyAgentHealth({
        successRatePct: 98,
        errorRatePct: 2,
        avgLatencyMs: 500,
        permissionMismatchCount: 0,
        daysSinceLastSeen: 3,
        daysToExpiry: 200,
        invocationCount: 100,
      });
      expect(result.recommendation).toBe('no_action');
      expect(result.severity).toBe('low');
    });

    it('quarantines agents with permission mismatches >= 5', () => {
      const result = classifyAgentHealth({
        successRatePct: 98,
        errorRatePct: 2,
        avgLatencyMs: 500,
        permissionMismatchCount: 6,
        daysSinceLastSeen: 3,
        daysToExpiry: 200,
        invocationCount: 100,
      });
      expect(result.recommendation).toBe('quarantine');
      expect(result.severity).toBe('critical');
    });

    it('retires an expired agent with EXPIRED signal', () => {
      const result = classifyAgentHealth({
        successRatePct: 98,
        errorRatePct: 2,
        avgLatencyMs: 500,
        permissionMismatchCount: 0,
        daysSinceLastSeen: 3,
        daysToExpiry: -3,
        invocationCount: 100,
      });
      expect(result.recommendation).toBe('retire');
      expect(result.severity).toBe('critical');
      expect(result.signals.some((s) => s.code === 'EXPIRED')).toBe(true);
    });

    it('renews when expiry is imminent', () => {
      const result = classifyAgentHealth({
        successRatePct: 98,
        errorRatePct: 2,
        avgLatencyMs: 500,
        permissionMismatchCount: 0,
        daysSinceLastSeen: 3,
        daysToExpiry: 20,
        invocationCount: 100,
      });
      expect(result.recommendation).toBe('renew');
      expect(result.severity).toBe('high');
      expect(result.signals.some((s) => s.code === 'EXPIRY_IMMINENT')).toBe(true);
    });

    it('holds agents with degraded health (poor success, warning errors)', () => {
      const result = classifyAgentHealth({
        successRatePct: 70,
        errorRatePct: 8,
        avgLatencyMs: 500,
        permissionMismatchCount: 0,
        daysSinceLastSeen: 3,
        daysToExpiry: 200,
        invocationCount: 100,
      });
      expect(result.recommendation).toBe('hold');
      expect(result.severity).toBe('high');
      expect(result.signals.some((s) => s.code === 'DEGRADED_HEALTH')).toBe(true);
    });

    it('retires a stale (inactive) agent', () => {
      const result = classifyAgentHealth({
        successRatePct: 99,
        errorRatePct: 0,
        avgLatencyMs: null,
        permissionMismatchCount: 0,
        daysSinceLastSeen: 150,
        daysToExpiry: 200,
        invocationCount: 10,
      });
      expect(result.recommendation).toBe('retire');
      expect(result.severity).toBe('moderate');
      expect(result.signals.some((s) => s.code === 'INACTIVE_AGENT')).toBe(true);
    });
  });

  describe('escalateSeverity', () => {
    it('picks the highest severity in the list', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateRecommendation', () => {
    it('picks the highest recommendation in the list', () => {
      expect(escalateRecommendation(['no_action', 'renew', 'quarantine'])).toBe('quarantine');
    });
  });

  describe('buildAgentActions', () => {
    it('mentions the agent key and retire action, plus the disclaimer', () => {
      const actions = buildAgentActions({
        recommendation: 'retire',
        signals: [{ code: 'EXPIRED' }],
        agentKey: 'agent-x',
      });
      expect(actions.some((line) => line.includes('AI governance review required'))).toBe(true);
      expect(
        actions.some((line) => line.includes('agent-x') || /retire/i.test(line))
      ).toBe(true);
    });
  });

  describe('summarizeAgent', () => {
    it('summarizes a no_action agent with its key and recommendation', () => {
      const summary = summarizeAgent({
        agentKey: 'a1',
        recommendation: 'no_action',
        severity: 'low',
        successRatePct: 99,
        errorRatePct: 0.5,
        daysToExpiry: 200,
      });
      expect(summary).toContain('a1');
      expect(summary).toContain('no_action');
    });
  });
});
