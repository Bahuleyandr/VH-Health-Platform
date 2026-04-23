import {
  determineCleaningLevel,
  estimateTurnoverMinutes,
  computePriorityScore,
  classifyTurnoverPriority,
} from '../../services/ai/housekeepingBedTurnoverService.js';

describe('housekeeping and bed turnover helpers', () => {
  describe('determineCleaningLevel', () => {
    it('returns isolation when MRSA appears in priorDiagnoses', () => {
      const level = determineCleaningLevel({
        priorDiagnoses: ['MRSA bacteremia resolved'],
      });
      expect(level).toBe('isolation');
    });

    it('returns isolation when an isolation precaution keyword is supplied', () => {
      const level = determineCleaningLevel({
        isolationPrecautions: ['Contact precaution — droplet'],
      });
      expect(level).toBe('isolation');
    });

    it('returns isolation when mrsaStatus is explicitly positive', () => {
      const level = determineCleaningLevel({ mrsaStatus: 'positive' });
      expect(level).toBe('isolation');
    });

    it('returns deep_clean when C. diff is explicitly named in diagnoses', () => {
      const level = determineCleaningLevel({
        priorDiagnoses: ['Clostridium difficile colitis'],
      });
      expect(level).toBe('deep_clean');
    });

    it('returns deep_clean for the "c. diff" shorthand in diagnoses', () => {
      const level = determineCleaningLevel({
        priorDiagnoses: ['Hospital-acquired C. diff infection'],
      });
      expect(level).toBe('deep_clean');
    });

    it('returns terminal when hadSurgicalProcedure is true with no isolation signal', () => {
      const level = determineCleaningLevel({
        hadSurgicalProcedure: true,
        priorDiagnoses: ['Cholecystitis'],
      });
      expect(level).toBe('terminal');
    });

    it('returns standard when inputs are present but none warrant higher-level cleaning', () => {
      const level = determineCleaningLevel({
        priorDiagnoses: ['Uncomplicated pneumonia'],
      });
      expect(level).toBe('standard');
    });

    it('returns unknown when no inputs are provided at all', () => {
      const level = determineCleaningLevel({});
      expect(level).toBe('unknown');
    });
  });

  describe('estimateTurnoverMinutes', () => {
    it('uses the standard base of 25 minutes at normal staffing with bathroom', () => {
      const minutes = estimateTurnoverMinutes({
        cleaningLevel: 'standard',
        staffingLoad: 'normal',
        hasPrivateBathroom: true,
      });
      // 25 base + 10 bathroom = 35
      expect(minutes).toBe(35);
    });

    it('returns 25 for standard at normal staffing without private bathroom', () => {
      const minutes = estimateTurnoverMinutes({
        cleaningLevel: 'standard',
        staffingLoad: 'normal',
        hasPrivateBathroom: false,
      });
      expect(minutes).toBe(25);
    });

    it('increases turnover by 1.2x under high staffing load', () => {
      const minutes = estimateTurnoverMinutes({
        cleaningLevel: 'standard',
        staffingLoad: 'high',
        hasPrivateBathroom: false,
      });
      // 25 * 1.2 = 30
      expect(minutes).toBe(30);
    });

    it('decreases turnover by 0.9x under low staffing load (more staff available)', () => {
      const minutes = estimateTurnoverMinutes({
        cleaningLevel: 'isolation',
        staffingLoad: 'low',
        hasPrivateBathroom: false,
      });
      // 75 * 0.9 = 67.5 → 68
      expect(minutes).toBe(68);
    });

    it('returns 45 for an unknown cleaning level', () => {
      const minutes = estimateTurnoverMinutes({
        cleaningLevel: 'unknown',
        staffingLoad: 'normal',
        hasPrivateBathroom: true,
      });
      expect(minutes).toBe(45);
    });

    it('applies the bathroom adder after the staffing multiplier', () => {
      const minutes = estimateTurnoverMinutes({
        cleaningLevel: 'terminal',
        staffingLoad: 'normal',
        hasPrivateBathroom: true,
      });
      // 55 * 1 + 10 = 65
      expect(minutes).toBe(65);
    });
  });

  describe('computePriorityScore', () => {
    it('returns critical band when demand is critical and bed feeds the ED doorway', () => {
      const result = computePriorityScore({
        bedDemand: 'critical',
        discharge: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        cleaningLevel: 'isolation',
        isEdDoorway: true,
        isIsolationWard: false,
      });
      expect(result.priority_band).toBe('critical');
      expect(result.priority_score).toBeGreaterThanOrEqual(75);
      // Always-on review disclaimer present last.
      expect(result.recommended_actions[result.recommended_actions.length - 1])
        .toMatch(/decision-support only/i);
    });

    it('returns moderate band with only one moderate-signal source', () => {
      // Only bedDemand=high (+20) and isIsolationWard=true (+5) => 25 → moderate.
      const result = computePriorityScore({
        bedDemand: 'high',
        discharge: null,
        cleaningLevel: 'standard',
        isEdDoorway: false,
        isIsolationWard: true,
      });
      expect(result.priority_band).toBe('moderate');
      expect(result.priority_score).toBeGreaterThanOrEqual(25);
      expect(result.priority_score).toBeLessThan(50);
    });

    it('always includes the review-only disclaimer as the final recommended action', () => {
      const result = computePriorityScore({
        bedDemand: 'normal',
        discharge: null,
        cleaningLevel: 'standard',
        isEdDoorway: false,
        isIsolationWard: false,
      });
      expect(result.recommended_actions.length).toBeGreaterThan(0);
      expect(result.recommended_actions[result.recommended_actions.length - 1])
        .toMatch(/decision-support only/i);
      expect(result.recommended_actions[result.recommended_actions.length - 1])
        .toMatch(/charge nurse/i);
    });

    it('emits a DISCHARGE_WAIT_LONG signal when discharge time is more than 60 minutes ago', () => {
      const result = computePriorityScore({
        bedDemand: 'normal',
        discharge: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
        cleaningLevel: 'standard',
        isEdDoorway: false,
        isIsolationWard: false,
      });
      expect(result.contributing_signals.some((s) => s.code === 'DISCHARGE_WAIT_LONG')).toBe(true);
    });
  });

  describe('classifyTurnoverPriority', () => {
    it('composes cleaning level, predicted minutes, and priority band together', () => {
      const result = classifyTurnoverPriority({
        priorDiagnoses: ['Uncomplicated pneumonia'],
        staffingLoad: 'normal',
        hasPrivateBathroom: false,
        bedDemand: 'normal',
        discharge: null,
        isEdDoorway: false,
        isIsolationWard: false,
      });
      expect(result.cleaning_level).toBe('standard');
      expect(result.predicted_minutes).toBe(25);
      expect(['low', 'moderate']).toContain(result.priority_band);
      expect(Array.isArray(result.contributing_signals)).toBe(true);
      expect(result.recommended_actions[result.recommended_actions.length - 1])
        .toMatch(/decision-support only/i);
    });

    it('escalates a C. diff discharge from an ED-doorway bed to critical priority', () => {
      const result = classifyTurnoverPriority({
        priorDiagnoses: ['Severe C. diff colitis'],
        staffingLoad: 'high',
        hasPrivateBathroom: true,
        bedDemand: 'critical',
        discharge: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        isEdDoorway: true,
        isIsolationWard: false,
      });
      expect(result.cleaning_level).toBe('deep_clean');
      expect(result.priority_band).toBe('critical');
      expect(result.predicted_minutes).toBeGreaterThan(60);
      expect(result.contributing_signals.some((s) => s.code === 'ED_DOORWAY_BED')).toBe(true);
      expect(result.contributing_signals.some((s) => s.code === 'BED_DEMAND_CRITICAL')).toBe(true);
    });
  });
});
