import {
  calculateMaxDose,
  classifyPediatricAgeBand,
  evaluateDoseSafety,
  lookupPediatricReference,
} from '../../services/ai/pediatricDosingSafetyService.js';

describe('pediatric dosing safety helpers', () => {
  describe('classifyPediatricAgeBand', () => {
    it('returns unknown when age is null', () => {
      expect(classifyPediatricAgeBand(null)).toBe('unknown');
    });

    it('returns unknown when age is undefined', () => {
      expect(classifyPediatricAgeBand(undefined)).toBe('unknown');
    });

    it('returns unknown when age is negative', () => {
      expect(classifyPediatricAgeBand(-1)).toBe('unknown');
    });

    it('classifies 14 days as neonate', () => {
      expect(classifyPediatricAgeBand(14)).toBe('neonate');
    });

    it('classifies 180 days as infant', () => {
      expect(classifyPediatricAgeBand(180)).toBe('infant');
    });

    it('classifies 800 days as toddler', () => {
      expect(classifyPediatricAgeBand(800)).toBe('toddler');
    });

    it('classifies 2000 days as child', () => {
      expect(classifyPediatricAgeBand(2000)).toBe('child');
    });

    it('classifies 5000 days as adolescent', () => {
      expect(classifyPediatricAgeBand(5000)).toBe('adolescent');
    });

    it('classifies 8000 days as adult', () => {
      expect(classifyPediatricAgeBand(8000)).toBe('adult');
    });
  });

  describe('calculateMaxDose', () => {
    it('returns null when weightKg is null and no absolute cap is supplied', () => {
      expect(calculateMaxDose({ weightKg: null, maxPerKgMg: 90, absoluteMaxMg: null })).toBeNull();
    });

    it('clamps to absoluteMaxMg when per-kg product exceeds absolute cap', () => {
      // 50 kg * 90 mg/kg = 4500 > cap 4000 → returns 4000
      expect(calculateMaxDose({ weightKg: 50, maxPerKgMg: 90, absoluteMaxMg: 4000 })).toBe(4000);
    });

    it('returns per-kg * weight when well under the absolute cap', () => {
      // 10 kg * 90 mg/kg = 900 < 4000
      expect(calculateMaxDose({ weightKg: 10, maxPerKgMg: 90, absoluteMaxMg: 4000 })).toBe(900);
    });

    it('rounds the result to 2 decimals', () => {
      // 7.5 kg * 0.15 mg/kg = 1.125 → rounds to 1.13
      expect(calculateMaxDose({ weightKg: 7.5, maxPerKgMg: 0.15, absoluteMaxMg: 16 })).toBe(1.13);
    });

    it('returns weight × per-kg when only per-kg is supplied', () => {
      expect(calculateMaxDose({ weightKg: 12, maxPerKgMg: 30, absoluteMaxMg: null })).toBe(360);
    });
  });

  describe('lookupPediatricReference', () => {
    it('matches amoxicillin from various casings', () => {
      expect(lookupPediatricReference('Amoxicillin')?.display).toBe('Amoxicillin');
      expect(lookupPediatricReference('AMOXICILLIN 500mg')?.display).toBe('Amoxicillin');
      expect(lookupPediatricReference('amoxicillin suspension')?.display).toBe('Amoxicillin');
    });

    it('prefers amoxicillin-clavulanate entry when both tokens are present', () => {
      expect(lookupPediatricReference('Amoxicillin-Clavulanate')?.display).toBe('Amoxicillin-clavulanate');
    });

    it('matches paracetamol via acetaminophen alias', () => {
      expect(lookupPediatricReference('Acetaminophen')?.display).toBe('Paracetamol (acetaminophen)');
    });

    it('returns null for unknown medication', () => {
      expect(lookupPediatricReference('Unobtanium 500mg')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(lookupPediatricReference('')).toBeNull();
      expect(lookupPediatricReference(null)).toBeNull();
    });
  });

  describe('evaluateDoseSafety', () => {
    const reference = lookupPediatricReference('Amoxicillin');

    it('returns missing_data when weightKg is null', () => {
      const result = evaluateDoseSafety({
        prescribedDoseMg: 400,
        calculatedMaxDoseMg: null,
        ageBand: 'child',
        ageDays: 2000,
        weightKg: null,
        medicationName: 'Amoxicillin',
        reference,
      });
      expect(result.safety_band).toBe('missing_data');
      expect(result.suggested_actions.length).toBeGreaterThan(0);
    });

    it('returns missing_data when reference is null', () => {
      const result = evaluateDoseSafety({
        prescribedDoseMg: 400,
        calculatedMaxDoseMg: null,
        ageBand: 'child',
        ageDays: 2000,
        weightKg: 15,
        medicationName: 'Unobtanium',
        reference: null,
      });
      expect(result.safety_band).toBe('missing_data');
    });

    it('flags unsafe when prescribed is 20% over the calculated max', () => {
      const result = evaluateDoseSafety({
        prescribedDoseMg: 500,
        calculatedMaxDoseMg: 400,
        ageBand: 'child',
        ageDays: 2000,
        weightKg: 10,
        medicationName: 'Amoxicillin',
        reference,
      });
      expect(result.safety_band).toBe('unsafe');
      expect(result.variance_pct).toBeCloseTo(25, 0);
      expect(result.suggested_actions.some((line) => /hold order/i.test(line))).toBe(true);
    });

    it('flags caution when prescribed is ~97% of the calculated max', () => {
      const result = evaluateDoseSafety({
        prescribedDoseMg: 388,
        calculatedMaxDoseMg: 400,
        ageBand: 'child',
        ageDays: 2000,
        weightKg: 10,
        medicationName: 'Amoxicillin',
        reference,
      });
      expect(result.safety_band).toBe('caution');
      expect(result.suggested_actions.some((line) => /verify dose/i.test(line))).toBe(true);
    });

    it('returns safe when prescribed is well under the calculated max', () => {
      const result = evaluateDoseSafety({
        prescribedDoseMg: 200,
        calculatedMaxDoseMg: 400,
        ageBand: 'child',
        ageDays: 2000,
        weightKg: 10,
        medicationName: 'Amoxicillin',
        reference,
      });
      expect(result.safety_band).toBe('safe');
      expect(result.suggested_actions[0]).toMatch(/no immediate action/i);
    });

    it('returns safe and notes non-pediatric rationale for adult age band', () => {
      const result = evaluateDoseSafety({
        prescribedDoseMg: 10000,
        calculatedMaxDoseMg: 400,
        ageBand: 'adult',
        ageDays: 8000,
        weightKg: 80,
        medicationName: 'Amoxicillin',
        reference,
      });
      expect(result.safety_band).toBe('safe');
      expect(result.rationale.toLowerCase()).toContain('adult');
    });

    it('downgrades to caution when patient is younger than reference min_age_band', () => {
      const ibuprofenRef = lookupPediatricReference('Ibuprofen');
      expect(ibuprofenRef).toBeTruthy();
      const result = evaluateDoseSafety({
        prescribedDoseMg: 20,
        calculatedMaxDoseMg: 200,
        ageBand: 'neonate',
        ageDays: 10,
        weightKg: 5,
        medicationName: 'Ibuprofen',
        reference: ibuprofenRef,
      });
      expect(result.safety_band).toBe('caution');
      expect(result.rationale.toLowerCase()).toMatch(/younger|specialist/);
    });
  });
});
