import {
  buildAutoverificationDecision,
  calculateDelta,
  classifyCriticalBand,
} from '../../services/ai/labAutoverificationService.js';

describe('lab autoverification helpers', () => {
  describe('calculateDelta', () => {
    it('returns null delta_pct when priorValue is null', () => {
      const result = calculateDelta({ currentValue: 10, priorValue: null });
      expect(result.delta_pct).toBeNull();
      expect(result.delta_minor).toBeNull();
    });

    it('returns null when priorValue is undefined', () => {
      const result = calculateDelta({ currentValue: 10 });
      expect(result.delta_pct).toBeNull();
      expect(result.delta_minor).toBeNull();
    });

    it('returns null when priorValue is 0 (division safety)', () => {
      const result = calculateDelta({ currentValue: 10, priorValue: 0 });
      expect(result.delta_pct).toBeNull();
      expect(result.delta_minor).toBeNull();
    });

    it('returns null when currentValue is null', () => {
      const result = calculateDelta({ currentValue: null, priorValue: 10 });
      expect(result.delta_pct).toBeNull();
      expect(result.delta_minor).toBeNull();
    });

    it('computes 50% when current=15 and prior=10', () => {
      const result = calculateDelta({ currentValue: 15, priorValue: 10 });
      expect(result.delta_pct).toBe(50);
      expect(result.delta_minor).toBe(5);
    });

    it('computes -50% when current=5 and prior=10', () => {
      const result = calculateDelta({ currentValue: 5, priorValue: 10 });
      expect(result.delta_pct).toBe(-50);
      expect(result.delta_minor).toBe(-5);
    });

    it('rounds delta_pct to 2 decimals', () => {
      const result = calculateDelta({ currentValue: 10.3333, priorValue: 10 });
      expect(result.delta_pct).toBe(3.33);
    });

    it('uses absolute prior for negative priors (sign comes from diff)', () => {
      const result = calculateDelta({ currentValue: 5, priorValue: -10 });
      // diff = 5 - (-10) = 15; denominator = |-10| = 10; pct = +150
      expect(result.delta_pct).toBe(150);
      expect(result.delta_minor).toBe(15);
    });
  });

  describe('classifyCriticalBand', () => {
    it("returns 'unknown' when value is null", () => {
      const band = classifyCriticalBand({
        value: null,
        referenceLow: 3.5,
        referenceHigh: 5.0,
      });
      expect(band).toBe('unknown');
    });

    it("returns 'unknown' when no reference range and no critical thresholds", () => {
      const band = classifyCriticalBand({ value: 10 });
      expect(band).toBe('unknown');
    });

    it("returns 'critical_low' when value <= criticalLow", () => {
      const band = classifyCriticalBand({
        value: 2.4,
        referenceLow: 3.5,
        referenceHigh: 5.0,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      });
      expect(band).toBe('critical_low');
    });

    it("returns 'critical_low' at exact boundary (value === criticalLow)", () => {
      const band = classifyCriticalBand({
        value: 2.5,
        referenceLow: 3.5,
        referenceHigh: 5.0,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      });
      expect(band).toBe('critical_low');
    });

    it("returns 'critical_high' when value >= criticalHigh", () => {
      const band = classifyCriticalBand({
        value: 7.0,
        referenceLow: 3.5,
        referenceHigh: 5.0,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      });
      expect(band).toBe('critical_high');
    });

    it("returns 'borderline_low' when value < referenceLow but above criticalLow", () => {
      const band = classifyCriticalBand({
        value: 3.0,
        referenceLow: 3.5,
        referenceHigh: 5.0,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      });
      expect(band).toBe('borderline_low');
    });

    it("returns 'borderline_high' when value > referenceHigh", () => {
      const band = classifyCriticalBand({
        value: 5.5,
        referenceLow: 3.5,
        referenceHigh: 5.0,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      });
      expect(band).toBe('borderline_high');
    });

    it("returns 'normal' when value is within the reference range", () => {
      const band = classifyCriticalBand({
        value: 4.2,
        referenceLow: 3.5,
        referenceHigh: 5.0,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      });
      expect(band).toBe('normal');
    });

    it("returns 'normal' when only reference bounds are set and value is within", () => {
      const band = classifyCriticalBand({
        value: 1.0,
        referenceLow: 0.8,
        referenceHigh: 1.1,
      });
      expect(band).toBe('normal');
    });
  });

  describe('buildAutoverificationDecision', () => {
    it("returns decision 'critical' for critical_high band with non-empty suggested_actions", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'critical_high',
        deltaPct: 5,
        priorValue: 4.5,
      });
      expect(result.decision).toBe('critical');
      expect(Array.isArray(result.suggested_actions)).toBe(true);
      expect(result.suggested_actions.length).toBeGreaterThan(0);
      expect(result.suggested_actions.some((line) => /notify/i.test(line))).toBe(true);
    });

    it("returns decision 'critical' for critical_low band", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'critical_low',
        deltaPct: 0,
        priorValue: 3.2,
      });
      expect(result.decision).toBe('critical');
      expect(result.suggested_actions.some((line) => /repeat|confirm/i.test(line))).toBe(true);
    });

    it("returns 'hold_for_review' for a large delta (|deltaPct| = 80)", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'normal',
        deltaPct: 80,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('hold_for_review');
      expect(result.decision_reason).toMatch(/delta|swing|specimen/i);
    });

    it("returns 'hold_for_review' for a negative large delta (deltaPct = -75)", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'normal',
        deltaPct: -75,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('hold_for_review');
    });

    it("returns 'auto_verify' for normal band with prior present and small delta", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'normal',
        deltaPct: 5,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('auto_verify');
      expect(result.suggested_actions.length).toBeGreaterThan(0);
    });

    it("returns 'auto_verify' at boundary |deltaPct| == 20", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'normal',
        deltaPct: 20,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('auto_verify');
    });

    it("returns 'hold_for_review' for borderline_high", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'borderline_high',
        deltaPct: 10,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('hold_for_review');
      expect(result.decision_reason).toMatch(/borderline/i);
    });

    it("returns 'hold_for_review' for borderline_low", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'borderline_low',
        deltaPct: -5,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('hold_for_review');
    });

    it("returns 'hold_for_review' when priorValue is null (conservative)", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'normal',
        deltaPct: null,
        priorValue: null,
      });
      expect(result.decision).toBe('hold_for_review');
      expect(result.decision_reason).toMatch(/no prior|conservative/i);
    });

    it("returns 'hold_for_review' when hasAbnormalFlags is true", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'normal',
        deltaPct: 5,
        priorValue: 4.0,
        hasAbnormalFlags: true,
      });
      expect(result.decision).toBe('hold_for_review');
      expect(result.decision_reason).toMatch(/flag|abnormal/i);
    });

    it('prioritizes critical band over large delta', () => {
      // Even when delta is huge, critical trumps everything.
      const result = buildAutoverificationDecision({
        criticalBand: 'critical_high',
        deltaPct: 200,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('critical');
    });

    it('prioritizes large delta over borderline bands', () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'borderline_high',
        deltaPct: 80,
        priorValue: 4.0,
      });
      expect(result.decision).toBe('hold_for_review');
      expect(result.decision_reason).toMatch(/delta|swing/i);
    });

    it("unknown band with no prior falls through to 'hold_for_review'", () => {
      const result = buildAutoverificationDecision({
        criticalBand: 'unknown',
        deltaPct: null,
        priorValue: null,
      });
      expect(result.decision).toBe('hold_for_review');
      expect(Array.isArray(result.suggested_actions)).toBe(true);
      expect(result.suggested_actions.length).toBeGreaterThan(0);
    });
  });
});
