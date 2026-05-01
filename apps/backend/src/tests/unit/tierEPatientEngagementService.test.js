/**
 * Tier E patient-engagement unit tests.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn(() => []);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getModuleMock,
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: generateClinicalTextMock,
}));
jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: runOutputDefensesMock,
}));

const {
  generateChronicDiseaseCoaching,
  generateDietAdviceDraft,
  generateExerciseAdviceDraft,
  generateFamilyHealthRiskSummary,
  generateFollowUpReminders,
  generateHomeVitalsInsights,
  generateMedicationReminders,
  generateMentalHealthScreening,
  generatePostDischargeCheckIn,
  generatePostSurgeryMonitoring,
  generatePreVisitForm,
  generatePreventiveHealthRecommendations,
  generateSymptomRedFlagCheck,
} = await import('../../services/ai/tierEPatientEngagementService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function defaultModule(moduleKey) {
  return { module_key: moduleKey, display_name: moduleKey, enabled: true,
    settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true } };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      explanation_summary: 'OK', key_points: [], next_steps: [], when_to_seek_help: [],
      source_citations: [], safety_flags: [],
    }),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    usedAi: true, provider: 'mock', model: 'm', estimatedCostMinor: 0,
  });
});

describe('symptom_red_flag_checker', () => {
  it('rejects too-short description', async () => {
    await expect(generateSymptomRedFlagCheck({ tenantId: TENANT, symptomDescription: 'short' }))
      .rejects.toThrow(/at least 10 characters/);
  });
  it('drafts triage advice', async () => {
    getModuleMock.mockResolvedValue(defaultModule('symptom_red_flag_checker'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateSymptomRedFlagCheck({
      tenantId: TENANT, symptomDescription: 'crushing chest pain radiating to left arm',
    });
    expect(out.module_key).toBe('symptom_red_flag_checker');
  });
});

describe('chronic_disease_coach', () => {
  it('rejects unknown condition', async () => {
    await expect(generateChronicDiseaseCoaching({
      tenantId: TENANT, patientUid: PATIENT, condition: 'magic',
    })).rejects.toThrow(/condition must be one of/);
  });
  it('drafts coaching message', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, test_name: 'HbA1c', result_value: '7.4', completed_at: '2026-04-15' },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 2, medication_name: 'metformin', dosage: '500mg', frequency: 'BD' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('chronic_disease_coach'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateChronicDiseaseCoaching({
      tenantId: TENANT, patientUid: PATIENT, condition: 'diabetes',
    });
    expect(out.module_key).toBe('chronic_disease_coach');
  });
});

describe('post_discharge_checkin_bot', () => {
  it('rejects unsupported day', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT }]);
    await expect(generatePostDischargeCheckIn({
      tenantId: TENANT, admissionId: 1, dayPostDischarge: 5,
    })).rejects.toThrow(/day_post_discharge must be one of/);
  });
  it('drafts day-1 check-in', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT,
      discharge_date: '2026-04-30', primary_diagnosis: 'CAP' }]);
    getModuleMock.mockResolvedValue(defaultModule('post_discharge_checkin_bot'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePostDischargeCheckIn({
      tenantId: TENANT, admissionId: 1, dayPostDischarge: 1,
    });
    expect(out.module_key).toBe('post_discharge_checkin_bot');
  });
});

describe('post_surgery_monitoring_bot', () => {
  it('drafts day-3 monitoring', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT, ward: 'Surg' }]);
    getModuleMock.mockResolvedValue(defaultModule('post_surgery_monitoring_bot'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePostSurgeryMonitoring({
      tenantId: TENANT, admissionId: 1, postOpDay: 3, procedureName: 'lap-chole',
    });
    expect(out.module_key).toBe('post_surgery_monitoring_bot');
  });
});

describe('home_vitals_insights', () => {
  it('rejects empty series', async () => {
    await expect(generateHomeVitalsInsights({
      tenantId: TENANT, patientUid: PATIENT, vitalsSeries: [],
    })).rejects.toThrow(/non-empty array/);
  });
  it('drafts trend summary', async () => {
    getModuleMock.mockResolvedValue(defaultModule('home_vitals_insights'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateHomeVitalsInsights({
      tenantId: TENANT, patientUid: PATIENT,
      vitalsSeries: [
        { vital: 'BP', sys: 150, dia: 95, at: '2026-05-01' },
        { vital: 'BP', sys: 145, dia: 90, at: '2026-04-30' },
      ],
    });
    expect(out.module_key).toBe('home_vitals_insights');
  });
});

describe('diet_advice_draft', () => {
  it('drafts diet guidance', async () => {
    getModuleMock.mockResolvedValue(defaultModule('diet_advice_draft'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 600 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateDietAdviceDraft({
      tenantId: TENANT, condition: 'diabetes type 2', restrictions: ['vegetarian'],
    });
    expect(out.module_key).toBe('diet_advice_draft');
  });
});

describe('exercise_advice_draft', () => {
  it('drafts exercise guidance', async () => {
    getModuleMock.mockResolvedValue(defaultModule('exercise_advice_draft'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 700 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateExerciseAdviceDraft({
      tenantId: TENANT, condition: 'post-MI cardiac rehab phase 2',
    });
    expect(out.module_key).toBe('exercise_advice_draft');
  });
});

describe('mental_health_screening_bot', () => {
  it('rejects unknown screen', async () => {
    await expect(generateMentalHealthScreening({
      tenantId: TENANT, patientUid: PATIENT, screen: 'magic',
    })).rejects.toThrow(/screen must be one of/);
  });
  it('drafts PHQ9 questions', async () => {
    getModuleMock.mockResolvedValue(defaultModule('mental_health_screening_bot'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 800 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMentalHealthScreening({
      tenantId: TENANT, patientUid: PATIENT, screen: 'PHQ9',
    });
    expect(out.module_key).toBe('mental_health_screening_bot');
  });
});

describe('medication_reminder_generator', () => {
  it('throws 404 when no active prescriptions', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateMedicationReminders({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts schedule', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, medication_name: 'lisinopril', dosage: '10mg', frequency: 'OD' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('medication_reminder_generator'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 900 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMedicationReminders({ tenantId: TENANT, patientUid: PATIENT });
    expect(out.module_key).toBe('medication_reminder_generator');
  });
});

describe('follow_up_reminder_generator', () => {
  it('throws 404 when admission missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateFollowUpReminders({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts follow-up plan', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT,
      discharge_date: '2026-04-30', primary_diagnosis: 'AMI',
      discharge_summary: 'follow up cards in 1 week, repeat lipids in 6 weeks' }]);
    getModuleMock.mockResolvedValue(defaultModule('follow_up_reminder_generator'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1000 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateFollowUpReminders({ tenantId: TENANT, admissionId: 1 });
    expect(out.module_key).toBe('follow_up_reminder_generator');
  });
});

describe('pre_visit_form_assistant', () => {
  it('drafts pre-visit checklist', async () => {
    getModuleMock.mockResolvedValue(defaultModule('pre_visit_form_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePreVisitForm({
      tenantId: TENANT, appointmentReason: 'cardiology follow-up after MI',
      departmentSpecialty: 'cardiology',
    });
    expect(out.module_key).toBe('pre_visit_form_assistant');
  });
});

describe('preventive_health_recommender', () => {
  it('rejects unknown sex', async () => {
    await expect(generatePreventiveHealthRecommendations({
      tenantId: TENANT, ageYears: 40, sex: 'magic',
    })).rejects.toThrow(/sex must be/);
  });
  it('drafts recommendations', async () => {
    getModuleMock.mockResolvedValue(defaultModule('preventive_health_recommender'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePreventiveHealthRecommendations({
      tenantId: TENANT, ageYears: 50, sex: 'FEMALE',
      comorbidities: ['hypertension'], familyHistory: ['mother: breast cancer'],
    });
    expect(out.module_key).toBe('preventive_health_recommender');
  });
});

describe('family_health_risk_summary', () => {
  it('rejects empty entries', async () => {
    await expect(generateFamilyHealthRiskSummary({ tenantId: TENANT, familyHistoryEntries: [] }))
      .rejects.toThrow(/non-empty/);
  });
  it('drafts risk summary', async () => {
    getModuleMock.mockResolvedValue(defaultModule('family_health_risk_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateFamilyHealthRiskSummary({
      tenantId: TENANT,
      familyHistoryEntries: [
        { relative: 'father', condition: 'CAD', age_at_diagnosis: 55 },
        { relative: 'paternal_uncle', condition: 'CAD', age_at_diagnosis: 60 },
      ],
    });
    expect(out.module_key).toBe('family_health_risk_summary');
  });
});
