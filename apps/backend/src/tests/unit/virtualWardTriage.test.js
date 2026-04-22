import { triageCheckIn } from '../../services/ai/virtualWardService.js';

describe('virtual ward triage', () => {
  it('returns green when everything is in range', () => {
    const out = triageCheckIn({
      vitals: { heart_rate: 72, systolic_bp: 120, spo2: 98, respiratory_rate: 14, temperature: 36.8 },
      symptoms: {},
      medicationAdherencePct: 95,
      moodScore: 8,
      painScore: 2,
    });
    expect(out.band).toBe('green');
    expect(out.reasons.length).toBe(0);
  });

  it('fires red on SpO2 below 88', () => {
    const out = triageCheckIn({
      vitals: { spo2: 85 },
    });
    expect(out.band).toBe('red');
    expect(out.reasons[0].code).toBe('LOW_SPO2');
  });

  it('fires red on a red-flag symptom', () => {
    const out = triageCheckIn({
      symptoms: { chest_pain: true, fever: false },
    });
    expect(out.band).toBe('red');
    expect(out.reasons[0].code).toBe('SYMPTOM_CHEST_PAIN');
  });

  it('combines multiple amber signals into red band when score >= 70', () => {
    const out = triageCheckIn({
      vitals: { spo2: 90, heart_rate: 125, systolic_bp: 185, temperature: 38.8 },
      symptoms: { cough: true, fever: true },
    });
    expect(out.band).toBe('red');
    expect(out.reasons.length).toBeGreaterThan(3);
  });

  it('fires amber on isolated symptom like fever', () => {
    const out = triageCheckIn({
      vitals: { heart_rate: 75 },
      symptoms: { fever: true },
    });
    expect(out.band).toBe('amber');
  });

  it('flags critical hypoglycemia', () => {
    const out = triageCheckIn({
      vitals: { blood_glucose: 45 },
    });
    expect(out.band).toBe('red');
    expect(out.reasons[0].code).toBe('GLUCOSE_CRITICAL');
  });

  it('fires amber on low medication adherence', () => {
    const out = triageCheckIn({
      medicationAdherencePct: 45,
    });
    expect(out.band).toBe('amber');
    expect(out.reasons[0].code).toBe('LOW_ADHERENCE');
  });

  it('fires red on very low adherence (< 30%)', () => {
    const out = triageCheckIn({
      medicationAdherencePct: 15,
    });
    expect(out.reasons[0].severity).toBe('red');
  });

  it('caps triage score at 100', () => {
    const out = triageCheckIn({
      vitals: { spo2: 80, heart_rate: 140, systolic_bp: 75, blood_glucose: 500, temperature: 40 },
      symptoms: { chest_pain: true, shortness_of_breath: true },
      painScore: 10,
      medicationAdherencePct: 10,
    });
    expect(out.score).toBe(100);
    expect(out.band).toBe('red');
  });
});
