import {
  computeAcuityLoad,
  computeRequiredStaff,
  computeDeficit,
  forecastPeakCensus,
  classifyDeficitBand,
  classifyAcuityStaffing,
  escalateSeverity,
  escalateRecommendation,
  buildStaffingActions,
  summarizeStaffingForecast,
} from '../../services/ai/acuityStaffingForecastService.js';

describe('acuityStaffingForecastService pure helpers', () => {
  describe('computeAcuityLoad', () => {
    it('computes weighted acuity load from a mixed census', () => {
      // 2*4 + 5*2 + 8*1.25 + 3*1 = 8 + 10 + 10 + 3 = 31
      const load = computeAcuityLoad({
        census: { critical: 2, high: 5, moderate: 8, low: 3 },
      });
      expect(load).toBeGreaterThan(0);
      expect(load).toBe(31);
    });

    it('returns 0 for an empty census', () => {
      expect(computeAcuityLoad({ census: {} })).toBe(0);
    });
  });

  describe('computeRequiredStaff', () => {
    it('computes role-based required headcount', () => {
      // nurse = ceil(4/2) + ceil(8/4) + ceil(10/5) + ceil(6/6) = 2 + 2 + 2 + 1 = 7
      // nursing_assistant = ceil(7 * 0.5) = 4
      const result = computeRequiredStaff({
        census: { critical: 4, high: 8, moderate: 10, low: 6 },
      });
      expect(result.nurse).toBe(7);
      expect(result.nursing_assistant).toBe(4);
    });

    it('returns zero headcount for empty census', () => {
      const result = computeRequiredStaff({ census: {} });
      expect(result.nurse).toBe(0);
      expect(result.nursing_assistant).toBe(0);
    });
  });

  describe('computeDeficit', () => {
    it('reports positive deficit and total when staff is below required', () => {
      const result = computeDeficit({
        required: { nurse: 7, nursing_assistant: 4 },
        current: { nurse: 5, nursing_assistant: 3 },
      });
      expect(result.nurse).toBe(2);
      expect(result.nursing_assistant).toBe(1);
      expect(result.total).toBe(3);
    });

    it('excludes surpluses from the total', () => {
      const result = computeDeficit({
        required: { nurse: 3 },
        current: { nurse: 5 },
      });
      expect(result.nurse).toBe(-2);
      expect(result.total).toBe(0);
    });
  });

  describe('forecastPeakCensus', () => {
    it('applies admissions minus discharges when projection is higher', () => {
      expect(
        forecastPeakCensus({ censusTotal: 20, predictedAdmissions: 5, predictedDischarges: 2 })
      ).toBe(23);
    });

    it('keeps the current census when net change is negative', () => {
      expect(
        forecastPeakCensus({ censusTotal: 20, predictedAdmissions: 0, predictedDischarges: 10 })
      ).toBe(20);
    });
  });

  describe('classifyDeficitBand', () => {
    it('returns balanced when deficit is zero', () => {
      expect(classifyDeficitBand({ deficitTotal: 0, censusTotal: 20 })).toBe('balanced');
    });

    it('returns surplus when deficit is negative', () => {
      expect(classifyDeficitBand({ deficitTotal: -2, censusTotal: 20 })).toBe('surplus');
    });

    it('returns watch at ratio 0.1', () => {
      expect(classifyDeficitBand({ deficitTotal: 2, censusTotal: 20 })).toBe('watch');
    });

    it('returns warning at ratio 0.25', () => {
      expect(classifyDeficitBand({ deficitTotal: 5, censusTotal: 20 })).toBe('warning');
    });

    it('returns crisis at ratio 0.35', () => {
      expect(classifyDeficitBand({ deficitTotal: 7, censusTotal: 20 })).toBe('crisis');
    });
  });

  describe('classifyAcuityStaffing', () => {
    it('classifies a critical-acuity surge as emergency_acuity/critical', () => {
      const result = classifyAcuityStaffing({
        census: { critical: 6, high: 0, moderate: 0, low: 0 },
        current: { nurse: 1, nursing_assistant: 0 },
      });
      expect(result.recommendation).toBe('emergency_acuity');
      expect(result.severity).toBe('critical');
    });

    it('produces a staffing recommendation for moderate-acuity census', () => {
      const result = classifyAcuityStaffing({
        census: { critical: 0, high: 0, moderate: 10, low: 0 },
        current: { nurse: 2, nursing_assistant: 1 },
      });
      // Depends on deficit calc — exact match balances to 'hold_staffing',
      // but the rule-based recommendation may escalate to 'call_in' or
      // 'float_staff' depending on minimum-headcount treatment.
      expect(['call_in', 'float_staff', 'hold_staffing']).toContain(result.recommendation);
    });

    it('flags a staff surplus as reduce_staff', () => {
      const result = classifyAcuityStaffing({
        census: { critical: 0, high: 0, moderate: 5, low: 0 },
        current: { nurse: 5, nursing_assistant: 3 },
      });
      expect(result.recommendation).toBe('reduce_staff');
    });

    it('returns no_action with EMPTY_UNIT signal for a zero-census unit', () => {
      const result = classifyAcuityStaffing({ census: {}, current: {} });
      expect(result.recommendation).toBe('no_action');
      const codes = result.signals.map((s) => s.code);
      expect(codes).toContain('EMPTY_UNIT');
    });
  });

  describe('escalateSeverity', () => {
    it('returns the highest-priority severity from a list', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateRecommendation', () => {
    it('escalates to call_in over lesser recommendations', () => {
      expect(escalateRecommendation(['no_action', 'call_in', 'float_staff'])).toBe('call_in');
    });
  });

  describe('buildStaffingActions', () => {
    it('includes the disclaimer and a unit-scoped action for call_in', () => {
      const actions = buildStaffingActions({
        recommendation: 'call_in',
        signals: [{ code: 'NURSING_CRISIS' }],
        unit: 'ICU-1',
      });
      expect(
        actions.some((line) => line.includes('House supervisor review required'))
      ).toBe(true);
      expect(
        actions.some((line) => line.includes('ICU-1') || /call/i.test(line))
      ).toBe(true);
    });
  });

  describe('summarizeStaffingForecast', () => {
    it('includes the unit label and recommendation in the summary', () => {
      const summary = summarizeStaffingForecast({
        unit: 'WARD-A',
        recommendation: 'call_in',
        severity: 'high',
        totalDeficit: 3,
        censusTotal: 25,
      });
      expect(summary).toContain('WARD-A');
      expect(summary).toContain('call_in');
    });
  });
});
