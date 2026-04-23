import {
  buildFollowUpPlan,
  classifyAssessmentStage,
  computeObstetricRiskScore,
  detectRedFlagSignals,
  detectRiskFactors,
} from '../../services/ai/obstetricRiskService.js';

describe('obstetric risk assistant helpers', () => {
  describe('classifyAssessmentStage', () => {
    it('returns pre_conception when gestational age is null', () => {
      expect(classifyAssessmentStage(null)).toBe('pre_conception');
    });

    it('returns pre_conception when gestational age is undefined', () => {
      expect(classifyAssessmentStage(undefined)).toBe('pre_conception');
    });

    it('returns pre_conception when gestational age is 0', () => {
      expect(classifyAssessmentStage(0)).toBe('pre_conception');
    });

    it('classifies 12 weeks as first_trimester', () => {
      expect(classifyAssessmentStage(12)).toBe('first_trimester');
    });

    it('classifies 13.9 weeks as first_trimester (upper edge)', () => {
      expect(classifyAssessmentStage(13.9)).toBe('first_trimester');
    });

    it('classifies 14 weeks as second_trimester (lower edge)', () => {
      expect(classifyAssessmentStage(14)).toBe('second_trimester');
    });

    it('classifies 20 weeks as second_trimester', () => {
      expect(classifyAssessmentStage(20)).toBe('second_trimester');
    });

    it('classifies 28 weeks as third_trimester (lower edge)', () => {
      expect(classifyAssessmentStage(28)).toBe('third_trimester');
    });

    it('classifies 35 weeks as third_trimester', () => {
      expect(classifyAssessmentStage(35)).toBe('third_trimester');
    });
  });

  describe('detectRiskFactors', () => {
    it('flags AGE_EXTREME when age is 17', () => {
      const factors = detectRiskFactors({ ageYears: 17, parity: 1 });
      expect(factors.some((f) => f.code === 'AGE_EXTREME' && f.severity === 'medium')).toBe(true);
    });

    it('flags AGE_EXTREME when age is 38', () => {
      const factors = detectRiskFactors({ ageYears: 38, parity: 1 });
      expect(factors.some((f) => f.code === 'AGE_EXTREME' && f.severity === 'medium')).toBe(true);
    });

    it('does not flag AGE_EXTREME for age 28', () => {
      const factors = detectRiskFactors({ ageYears: 28, parity: 1 });
      expect(factors.some((f) => f.code === 'AGE_EXTREME')).toBe(false);
    });

    it('flags GRAND_MULTIPARA when parity is 6', () => {
      const factors = detectRiskFactors({ ageYears: 30, parity: 6 });
      expect(factors.some((f) => f.code === 'GRAND_MULTIPARA' && f.severity === 'medium')).toBe(true);
    });

    it('flags NULLIPARA when parity is 0 and age is 32', () => {
      const factors = detectRiskFactors({ ageYears: 32, parity: 0 });
      expect(factors.some((f) => f.code === 'NULLIPARA' && f.severity === 'low')).toBe(true);
    });

    it('matches prior preeclampsia case-insensitively', () => {
      const factors = detectRiskFactors({
        ageYears: 30,
        parity: 1,
        priorConditions: ['History of PREECLAMPSIA in prior pregnancy'],
      });
      expect(factors.some((f) => f.code === 'PRIOR_PREECLAMPSIA' && f.severity === 'high')).toBe(true);
    });

    it('matches chronic hypertension via HTN abbreviation', () => {
      const factors = detectRiskFactors({
        ageYears: 30,
        parity: 1,
        priorConditions: ['HTN', 'asthma'],
      });
      expect(factors.some((f) => f.code === 'CHRONIC_HYPERTENSION' && f.severity === 'high')).toBe(true);
    });

    it('flags MULTIPLE_GESTATION when multipleGestation flag is true', () => {
      const factors = detectRiskFactors({ ageYears: 30, parity: 1, multipleGestation: true });
      expect(factors.some((f) => f.code === 'MULTIPLE_GESTATION' && f.severity === 'high')).toBe(true);
    });

    it('flags PRIOR_CESAREAN when prior conditions mention c-section', () => {
      const factors = detectRiskFactors({
        ageYears: 30,
        parity: 1,
        priorConditions: ['Previous C-Section in 2023'],
      });
      expect(factors.some((f) => f.code === 'PRIOR_CESAREAN' && f.severity === 'medium')).toBe(true);
    });

    it('flags PRE_EXISTING_DIABETES when priorConditions includes diabetes', () => {
      const factors = detectRiskFactors({
        ageYears: 30,
        parity: 1,
        priorConditions: ['Type 2 Diabetes'],
      });
      expect(factors.some((f) => f.code === 'PRE_EXISTING_DIABETES' && f.severity === 'high')).toBe(true);
    });

    it('returns empty array when no risk factors present', () => {
      const factors = detectRiskFactors({ ageYears: 28, parity: 1 });
      expect(factors).toEqual([]);
    });
  });

  describe('detectRedFlagSignals', () => {
    it('flags SEVERE_PREECLAMPSIA when SBP is 162 and DBP is 110', () => {
      const signals = detectRedFlagSignals({
        vitals: { systolic_bp: 162, diastolic_bp: 110 },
        gestationalAgeWeeks: 32,
      });
      expect(signals.some((s) => s.code === 'SEVERE_PREECLAMPSIA' && s.severity === 'critical')).toBe(true);
    });

    it('flags SEVERE_PREECLAMPSIA for DBP >= 110 even if SBP is lower', () => {
      const signals = detectRedFlagSignals({
        vitals: { systolic_bp: 150, diastolic_bp: 112 },
        gestationalAgeWeeks: 30,
      });
      expect(signals.some((s) => s.code === 'SEVERE_PREECLAMPSIA')).toBe(true);
    });

    it('flags PREECLAMPSIA_SUSPECTED when SBP 145 + DBP 92 + proteinuria symptom at 22 weeks', () => {
      const signals = detectRedFlagSignals({
        vitals: { systolic_bp: 145, diastolic_bp: 92 },
        symptoms: ['proteinuria'],
        gestationalAgeWeeks: 22,
      });
      expect(signals.some((s) => s.code === 'PREECLAMPSIA_SUSPECTED' && s.severity === 'high')).toBe(true);
      expect(signals.some((s) => s.code === 'SEVERE_PREECLAMPSIA')).toBe(false);
    });

    it('flags GESTATIONAL_HYPERTENSION when elevated BP without proteinuria', () => {
      const signals = detectRedFlagSignals({
        vitals: { systolic_bp: 145, diastolic_bp: 92 },
        symptoms: [],
        gestationalAgeWeeks: 22,
      });
      expect(signals.some((s) => s.code === 'GESTATIONAL_HYPERTENSION')).toBe(true);
    });

    it('flags POSSIBLE_ECLAMPSIA when symptoms include seizure', () => {
      const signals = detectRedFlagSignals({
        vitals: {},
        symptoms: ['seizure activity reported'],
      });
      expect(signals.some((s) => s.code === 'POSSIBLE_ECLAMPSIA' && s.severity === 'critical')).toBe(true);
    });

    it('flags POSSIBLE_PPH when symptoms mention heavy bleeding', () => {
      const signals = detectRedFlagSignals({
        vitals: {},
        symptoms: ['heavy bleeding postpartum'],
      });
      expect(signals.some((s) => s.code === 'POSSIBLE_PPH' && s.severity === 'critical')).toBe(true);
    });

    it('flags REDUCED_FETAL_MOVEMENT when symptom mentions reduced fetal movement', () => {
      const signals = detectRedFlagSignals({
        vitals: {},
        symptoms: ['reduced fetal movement since last night'],
      });
      expect(signals.some((s) => s.code === 'REDUCED_FETAL_MOVEMENT' && s.severity === 'high')).toBe(true);
    });

    it('flags FEVER_IN_PREGNANCY when temperature >= 38', () => {
      const signals = detectRedFlagSignals({
        vitals: { temperature: 38.4 },
        gestationalAgeWeeks: 24,
      });
      expect(signals.some((s) => s.code === 'FEVER_IN_PREGNANCY')).toBe(true);
    });

    it('flags LOW_FETAL_HEART_RATE when fetal_hr is 100', () => {
      const signals = detectRedFlagSignals({
        vitals: { fetal_hr: 100 },
        gestationalAgeWeeks: 32,
      });
      expect(signals.some((s) => s.code === 'LOW_FETAL_HEART_RATE' && s.severity === 'critical')).toBe(true);
    });

    it('flags HIGH_FETAL_HEART_RATE when fetal_hr is 170', () => {
      const signals = detectRedFlagSignals({
        vitals: { fetal_hr: 170 },
        gestationalAgeWeeks: 32,
      });
      expect(signals.some((s) => s.code === 'HIGH_FETAL_HEART_RATE')).toBe(true);
    });

    it('does not flag anything for normal vitals and no symptoms', () => {
      const signals = detectRedFlagSignals({
        vitals: { systolic_bp: 118, diastolic_bp: 76, temperature: 36.9, fetal_hr: 140 },
        symptoms: [],
        gestationalAgeWeeks: 24,
      });
      expect(signals).toEqual([]);
    });
  });

  describe('computeObstetricRiskScore', () => {
    it('returns low band and score 0 when both arrays are empty', () => {
      const result = computeObstetricRiskScore({ riskFactors: [], redFlagSignals: [] });
      expect(result.risk_band).toBe('low');
      expect(result.risk_score).toBe(0);
    });

    it('scores a single critical signal at 40 points', () => {
      const result = computeObstetricRiskScore({
        riskFactors: [],
        redFlagSignals: [{ code: 'SEVERE_PREECLAMPSIA', severity: 'critical' }],
      });
      expect(result.risk_score).toBe(40);
      // 40 is between the 20 moderate threshold and the 45 high threshold, so band is moderate.
      expect(result.risk_band).toBe('moderate');
    });

    it('returns critical band when total score reaches 70+ via multiple signals', () => {
      const result = computeObstetricRiskScore({
        riskFactors: [{ code: 'PRIOR_PREECLAMPSIA', severity: 'high' }],
        redFlagSignals: [
          { code: 'SEVERE_PREECLAMPSIA', severity: 'critical' },
          { code: 'LOW_FETAL_HEART_RATE', severity: 'critical' },
        ],
      });
      // 25 + 40 + 40 = 105 -> clamped to 100 -> critical
      expect(result.risk_band).toBe('critical');
      expect(result.risk_score).toBe(100);
    });

    it('returns moderate band for two medium-severity factors', () => {
      const result = computeObstetricRiskScore({
        riskFactors: [
          { code: 'AGE_EXTREME', severity: 'medium' },
          { code: 'GRAND_MULTIPARA', severity: 'medium' },
        ],
        redFlagSignals: [],
      });
      // 12 + 12 = 24 -> moderate (>= 20)
      expect(result.risk_score).toBe(24);
      expect(result.risk_band).toBe('moderate');
    });

    it('returns high band when score is in the 45-69 range', () => {
      const result = computeObstetricRiskScore({
        riskFactors: [
          { code: 'CHRONIC_HYPERTENSION', severity: 'high' },
          { code: 'PRE_EXISTING_DIABETES', severity: 'high' },
        ],
        redFlagSignals: [],
      });
      // 25 + 25 = 50 -> high
      expect(result.risk_score).toBe(50);
      expect(result.risk_band).toBe('high');
    });

    it('clamps score to 100 regardless of total weight', () => {
      const result = computeObstetricRiskScore({
        riskFactors: Array(5).fill({ severity: 'critical' }),
        redFlagSignals: Array(5).fill({ severity: 'critical' }),
      });
      expect(result.risk_score).toBe(100);
      expect(result.risk_band).toBe('critical');
    });
  });

  describe('buildFollowUpPlan', () => {
    it('returns 30 as next ANC visit when currently at 26 weeks and low risk', () => {
      const plan = buildFollowUpPlan({
        assessmentStage: 'second_trimester',
        riskBand: 'low',
        gestationalAgeWeeks: 26,
      });
      expect(plan.next_anc_weeks).toBe(30);
      expect(plan.required_investigations.length).toBeGreaterThan(0);
      expect(plan.escalation_criteria.length).toBeGreaterThan(0);
    });

    it('suggests earlier follow-up when risk_band is critical', () => {
      const plan = buildFollowUpPlan({
        assessmentStage: 'third_trimester',
        riskBand: 'critical',
        gestationalAgeWeeks: 32,
      });
      expect(plan.next_anc_weeks).toBe('within_48_hours');
    });

    it('suggests 1-2 week interval follow-up when risk_band is high', () => {
      const plan = buildFollowUpPlan({
        assessmentStage: 'third_trimester',
        riskBand: 'high',
        gestationalAgeWeeks: 30,
      });
      // When high risk and we know the gestation weeks, next visit should be earlier (within 1 week).
      expect(plan.next_anc_weeks).toBe(31);
    });

    it('returns non-empty escalation_criteria listing danger signs', () => {
      const plan = buildFollowUpPlan({
        assessmentStage: 'second_trimester',
        riskBand: 'low',
        gestationalAgeWeeks: 22,
      });
      expect(plan.escalation_criteria).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Systolic BP/i),
          expect.stringMatching(/seizure|convulsion/i),
          expect.stringMatching(/bleeding/i),
          expect.stringMatching(/fetal movement/i),
        ])
      );
    });

    it('adds OGTT requirement at 24-28 weeks for patients with pre-existing diabetes', () => {
      const plan = buildFollowUpPlan({
        assessmentStage: 'second_trimester',
        riskBand: 'moderate',
        gestationalAgeWeeks: 20,
        riskFactors: [{ code: 'PRE_EXISTING_DIABETES', severity: 'high' }],
      });
      expect(plan.required_investigations.some((line) => /OGTT/i.test(line))).toBe(true);
    });
  });
});
