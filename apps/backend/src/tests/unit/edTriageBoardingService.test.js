import {
  classifyTriageLevel,
  computeBoardingRisk,
  predictDisposition,
  predictSpecialty,
} from '../../services/ai/edTriageBoardingService.js';

describe('ED triage + boarding predictor helpers', () => {
  describe('classifyTriageLevel', () => {
    it('returns ESI 1 when SpO2 is below 85', () => {
      const level = classifyTriageLevel({ vitals: { spo2: 80 }, chiefComplaint: 'shortness of breath' });
      expect(level).toBe(1);
    });

    it('returns ESI 1 for unresponsive / arrest keywords even with no vitals', () => {
      const level = classifyTriageLevel({ chiefComplaint: 'Patient unresponsive after collapse' });
      expect(level).toBe(1);
    });

    it('returns ESI 1 when systolic BP below 80', () => {
      const level = classifyTriageLevel({ vitals: { systolic_bp: 70 }, chiefComplaint: 'dizzy' });
      expect(level).toBe(1);
    });

    it('returns ESI 2 for chest pain with age >= 40', () => {
      const level = classifyTriageLevel({
        chiefComplaint: 'chest pain radiating to left arm',
        ageYears: 60,
        vitals: { heart_rate: 95, systolic_bp: 130, spo2: 97 },
      });
      expect(level).toBe(2);
    });

    it('returns ESI 2 for stroke keyword', () => {
      const level = classifyTriageLevel({
        chiefComplaint: 'acute stroke symptoms with facial droop',
        ageYears: 55,
        vitals: { heart_rate: 90, systolic_bp: 150, spo2: 97 },
      });
      expect(level).toBe(2);
    });

    it('returns ESI 2 when SpO2 is below 92', () => {
      const level = classifyTriageLevel({
        chiefComplaint: 'worsening shortness of breath',
        vitals: { spo2: 89, heart_rate: 110 },
        ageYears: 70,
      });
      expect(level).toBe(2);
    });

    it('defaults to ESI 3 when only age is provided and no vitals', () => {
      const level = classifyTriageLevel({ ageYears: 35 });
      expect(level).toBe(3);
    });

    it('returns ESI 5 for stable minor complaint with low pain', () => {
      const level = classifyTriageLevel({
        chiefComplaint: 'minor cough for two days, requesting medication refill',
        ageYears: 28,
        vitals: { heart_rate: 78, systolic_bp: 120, spo2: 98, resp_rate: 16 },
        painScore: 1,
      });
      expect(level).toBe(5);
    });
  });

  describe('predictSpecialty', () => {
    it('routes chest pain in elderly to cardiology', () => {
      const specialty = predictSpecialty({ chiefComplaint: 'chest pain', ageYears: 65 });
      expect(specialty).toBe('cardiology');
    });

    it('routes pregnancy / labour keywords to obstetrics', () => {
      const specialty = predictSpecialty({
        chiefComplaint: 'pregnant, bleeding per vagina at 32 weeks',
        ageYears: 29,
      });
      expect(specialty).toBe('obstetrics');
    });

    it('routes pediatric age (under 18) to pediatrics when no specialty-specific keyword', () => {
      const specialty = predictSpecialty({ chiefComplaint: 'fever and cough', ageYears: 6 });
      expect(specialty).toBe('pediatrics');
    });

    it('routes trauma / fracture to orthopedics', () => {
      const specialty = predictSpecialty({ chiefComplaint: 'fall from ladder, suspected fracture of wrist', ageYears: 45 });
      expect(specialty).toBe('orthopedics');
    });

    it('routes stroke keyword to neurology', () => {
      const specialty = predictSpecialty({ chiefComplaint: 'sudden onset slurred speech and weakness, possible stroke', ageYears: 72 });
      expect(specialty).toBe('neurology');
    });

    it('falls back to internal medicine when nothing matches', () => {
      const specialty = predictSpecialty({ chiefComplaint: 'fatigue and malaise', ageYears: 40 });
      expect(specialty).toBe('internal');
    });
  });

  describe('predictDisposition', () => {
    it('routes triage 1 to ICU', () => {
      const dispo = predictDisposition({ triageLevel: 1, vitals: { spo2: 80 } });
      expect(dispo).toBe('icu');
    });

    it('routes triage 2 + respiratory failure to ICU', () => {
      const dispo = predictDisposition({
        triageLevel: 2,
        vitals: { spo2: 85, systolic_bp: 88 },
        predictedSpecialty: 'cardiology',
      });
      expect(dispo).toBe('icu');
    });

    it('routes triage 2 without decompensation to admission', () => {
      const dispo = predictDisposition({
        triageLevel: 2,
        vitals: { spo2: 96, systolic_bp: 130, heart_rate: 100 },
        predictedSpecialty: 'neurology',
      });
      expect(dispo).toBe('admission');
    });

    it('routes triage 3 with stable vitals to observation', () => {
      const dispo = predictDisposition({
        triageLevel: 3,
        vitals: { heart_rate: 85, systolic_bp: 130, spo2: 98 },
        ageYears: 40,
        predictedSpecialty: 'internal',
      });
      expect(dispo).toBe('observation');
    });

    it('routes triage 5 to discharge', () => {
      const dispo = predictDisposition({
        triageLevel: 5,
        vitals: { heart_rate: 75, systolic_bp: 118, spo2: 99 },
        ageYears: 24,
        predictedSpecialty: 'internal',
      });
      expect(dispo).toBe('discharge');
    });
  });

  describe('computeBoardingRisk', () => {
    it('returns critical band when occupancy + triage + ICU disposition all align', () => {
      const result = computeBoardingRisk({
        triageLevel: 2,
        occupancy: 0.97,
        staffLoad: 'high',
        predictedDisposition: 'icu',
        arrivalMode: 'ambulance',
      });
      expect(result.boarding_risk_band).toBe('critical');
      expect(result.boarding_risk_score).toBeGreaterThanOrEqual(70);
      expect(result.predicted_boarding_minutes).toBeGreaterThan(60);
    });

    it('returns low / moderate band for a stable walk-in with empty ED', () => {
      const result = computeBoardingRisk({
        triageLevel: 4,
        occupancy: 0.3,
        staffLoad: 'normal',
        predictedDisposition: 'discharge',
        arrivalMode: 'walk_in',
      });
      expect(['low', 'moderate']).toContain(result.boarding_risk_band);
      expect(result.boarding_risk_score).toBeLessThan(45);
    });

    it('always includes the review-only disclaimer in recommended_actions', () => {
      const result = computeBoardingRisk({
        triageLevel: 3,
        occupancy: 0.5,
        staffLoad: 'normal',
        predictedDisposition: 'observation',
        arrivalMode: 'walk_in',
      });
      expect(result.recommended_actions[result.recommended_actions.length - 1])
        .toMatch(/review-only forecast/i);
      expect(result.recommended_actions.some((line) => /charge nurse/i.test(line))).toBe(true);
    });

    it('emits an OCCUPANCY_UNKNOWN signal when occupancy is null', () => {
      const result = computeBoardingRisk({
        triageLevel: 3,
        occupancy: null,
        staffLoad: 'normal',
        predictedDisposition: 'observation',
        arrivalMode: 'walk_in',
      });
      expect(result.signals.some((s) => s.code === 'OCCUPANCY_UNKNOWN')).toBe(true);
    });

    it('flags HIGH_ACUITY with critical severity when triage level is 1', () => {
      const result = computeBoardingRisk({
        triageLevel: 1,
        occupancy: 0.5,
        staffLoad: 'normal',
        predictedDisposition: 'icu',
        arrivalMode: 'ambulance',
      });
      const highAcuity = result.signals.find((s) => s.code === 'HIGH_ACUITY');
      expect(highAcuity).toBeDefined();
      expect(highAcuity.severity).toBe('critical');
    });
  });
});
