/**
 * Tier C clinical-assistant unit tests. Same mock pattern as tier A:
 * mocks prisma + getClinicalAiModule + generateClinicalText + runOutputDefenses.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn(() => []);

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
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
  generateAdverseDrugEventDetection,
  generateAkiRiskAlert,
  generateClinicLetterDraft,
  generateClinicalNoteCleanup,
  generateFallRiskPrediction,
  generateIcuRoundSummary,
  generateIntakeOutputSummary,
  generateLiverDoseCheck,
  generateMedicalCertificateDraft,
  generateMissingExaminationAssistant,
  generateMissingQuestionsAssistant,
  generateMissingTestsAssistant,
  generateOrderSetSuggestion,
  generatePregnancyLactationWarning,
  generatePressureUlcerRiskPrediction,
  generateRenalDoseCheck,
} = await import('../../services/ai/tierCAssistantsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function defaultModule(moduleKey, overrides = {}) {
  return {
    module_key: moduleKey, display_name: moduleKey, enabled: true,
    settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true },
    ...overrides,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      explanation_summary: 'OK',
      key_points: [], next_steps: [], when_to_seek_help: [],
      source_citations: [], safety_flags: [],
    }),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    usedAi: true, provider: 'mock', model: 'm', estimatedCostMinor: 0,
  });
});

// ---------------------------------------------------------------------------
describe('medical_certificate_draft', () => {
  it('rejects unknown cert_type', async () => {
    await expect(generateMedicalCertificateDraft({
      tenantId: TENANT, admissionId: 1, certType: 'magic',
    })).rejects.toThrow(/cert_type must be/);
  });
  it('throws 404 when admission missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateMedicalCertificateDraft({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts when admission exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT, admission_date: '2026-04-30' }]);
    getModuleMock.mockResolvedValue(defaultModule('medical_certificate_draft'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMedicalCertificateDraft({
      tenantId: TENANT, admissionId: 1, certType: 'sickness',
    });
    expect(out.module_key).toBe('medical_certificate_draft');
  });
});

describe('clinic_letter_draft', () => {
  it('throws 404 when admission missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateClinicLetterDraft({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts using admission + recent notes', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT,
      primary_diagnosis: 'CAP', admission_date: '2026-04-30' }]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 9, note_type: 'progress', note_text: 'improving', author_role: 'DOCTOR', created_at: '2026-05-01' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('clinic_letter_draft'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateClinicLetterDraft({ tenantId: TENANT, admissionId: 1 });
    expect(out.module_key).toBe('clinic_letter_draft');
  });
});

describe('clinical_note_cleanup', () => {
  it('rejects too-short note_text', async () => {
    await expect(generateClinicalNoteCleanup({ tenantId: TENANT, noteText: 'short' }))
      .rejects.toThrow(/at least 30 characters/);
  });
  it('drafts when note_text is sufficient', async () => {
    getModuleMock.mockResolvedValue(defaultModule('clinical_note_cleanup'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateClinicalNoteCleanup({
      tenantId: TENANT,
      noteText: 'pt c/o cough x 3 days, low grade fever, dry cough, no SOB',
    });
    expect(out.module_key).toBe('clinical_note_cleanup');
  });
});

describe('missing_questions_assistant', () => {
  it('rejects empty chief_complaint', async () => {
    await expect(generateMissingQuestionsAssistant({ tenantId: TENANT, chiefComplaint: '' }))
      .rejects.toThrow(/at least 3 characters/);
  });
  it('drafts suggestions', async () => {
    getModuleMock.mockResolvedValue(defaultModule('missing_questions_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMissingQuestionsAssistant({
      tenantId: TENANT, chiefComplaint: 'chest pain on exertion',
    });
    expect(out.module_key).toBe('missing_questions_assistant');
  });
});

describe('missing_examination_assistant', () => {
  it('drafts suggestions', async () => {
    getModuleMock.mockResolvedValue(defaultModule('missing_examination_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMissingExaminationAssistant({
      tenantId: TENANT, workingDiagnosis: 'Suspected pneumonia',
      examCompleted: ['general'],
    });
    expect(out.module_key).toBe('missing_examination_assistant');
  });
});

describe('missing_tests_assistant', () => {
  it('drafts gap list', async () => {
    getModuleMock.mockResolvedValue(defaultModule('missing_tests_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 600 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMissingTestsAssistant({
      tenantId: TENANT, workingDiagnosis: 'Suspected DKA',
      testsOrdered: ['glucose'],
    });
    expect(out.module_key).toBe('missing_tests_assistant');
  });
});

describe('order_set_suggestion', () => {
  it('rejects unknown acuity', async () => {
    await expect(generateOrderSetSuggestion({
      tenantId: TENANT, workingDiagnosis: 'sepsis', acuity: 'magic',
    })).rejects.toThrow(/acuity must be/);
  });
  it('drafts an order set bundle', async () => {
    getModuleMock.mockResolvedValue(defaultModule('order_set_suggestion'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 700 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateOrderSetSuggestion({
      tenantId: TENANT, workingDiagnosis: 'sepsis', acuity: 'urgent',
    });
    expect(out.module_key).toBe('order_set_suggestion');
  });
});

describe('renal_dose_check', () => {
  it('throws 404 when prescription missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateRenalDoseCheck({ tenantId: TENANT, prescriptionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts when prescription exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT,
      medication_name: 'gentamicin', dosage: '120mg', frequency: 'OD' }]);
    getModuleMock.mockResolvedValue(defaultModule('renal_dose_check'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 800 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateRenalDoseCheck({ tenantId: TENANT, prescriptionId: 1, eGfr: 35 });
    expect(out.module_key).toBe('renal_dose_check');
  });
});

describe('liver_dose_check', () => {
  it('drafts liver review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT,
      medication_name: 'paracetamol', dosage: '500mg' }]);
    getModuleMock.mockResolvedValue(defaultModule('liver_dose_check'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 900 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateLiverDoseCheck({
      tenantId: TENANT, prescriptionId: 1, ast: 42, alt: 38, bilirubin: 1.2,
    });
    expect(out.module_key).toBe('liver_dose_check');
  });
});

describe('pregnancy_lactation_warning', () => {
  it('drafts pregnancy review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT,
      medication_name: 'warfarin', dosage: '5mg' }]);
    getModuleMock.mockResolvedValue(defaultModule('pregnancy_lactation_warning'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1000 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePregnancyLactationWarning({
      tenantId: TENANT, prescriptionId: 1, pregnancyStatus: 'pregnant', trimester: 2,
    });
    expect(out.module_key).toBe('pregnancy_lactation_warning');
  });
});

describe('adverse_drug_event_detector', () => {
  it('rejects missing patient_uid', async () => {
    await expect(generateAdverseDrugEventDetection({
      tenantId: TENANT, signal: { type: 'rash' },
    })).rejects.toThrow(/required/);
  });
  it('rejects missing signal', async () => {
    await expect(generateAdverseDrugEventDetection({
      tenantId: TENANT, patientUid: PATIENT,
    })).rejects.toThrow(/signal must be/);
  });
  it('drafts ADE assessment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, medication_name: 'amoxicillin', dosage: '500mg', prescribed_at: '2026-04-30' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('adverse_drug_event_detector'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateAdverseDrugEventDetection({
      tenantId: TENANT, patientUid: PATIENT,
      signal: { type: 'rash', onset_hours_ago: 6 },
    });
    expect(out.module_key).toBe('adverse_drug_event_detector');
  });
});

describe('fall_risk_prediction', () => {
  it('throws 404 when no fall_risk_assessments rows', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateFallRiskPrediction({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts prediction when assessments exist', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, scale: 'MORSE', score: 65, risk_level: 'high', recorded_at: '2026-05-01' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('fall_risk_prediction'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateFallRiskPrediction({ tenantId: TENANT, patientUid: PATIENT });
    expect(out.module_key).toBe('fall_risk_prediction');
  });
});

describe('pressure_ulcer_risk_prediction', () => {
  it('drafts prediction', async () => {
    getModuleMock.mockResolvedValue(defaultModule('pressure_ulcer_risk_prediction'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePressureUlcerRiskPrediction({
      tenantId: TENANT, patientUid: PATIENT, admissionId: 1, bradenScore: 14,
    });
    expect(out.module_key).toBe('pressure_ulcer_risk_prediction');
  });
});

describe('aki_risk_alert', () => {
  it('drafts AKI assessment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, test_name: 'Creatinine', result_value: '1.6', result_unit: 'mg/dL', completed_at: '2026-05-01' },
      { id: 2, test_name: 'Creatinine', result_value: '1.0', result_unit: 'mg/dL', completed_at: '2026-04-29' },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 5, medication_name: 'gentamicin', dosage: '120mg', prescribed_at: '2026-04-29' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('aki_risk_alert'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateAkiRiskAlert({ tenantId: TENANT, patientUid: PATIENT });
    expect(out.module_key).toBe('aki_risk_alert');
  });
});

describe('intake_output_summary', () => {
  it('throws 404 when no I/O rows', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateIntakeOutputSummary({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts summary when rows exist', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT }]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, io_type: 'iv_intake', amount_ml: 1000, recorded_at: '2026-05-01' },
      { id: 11, io_type: 'urine_output', amount_ml: 800, recorded_at: '2026-05-01' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('intake_output_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateIntakeOutputSummary({ tenantId: TENANT, admissionId: 1 });
    expect(out.module_key).toBe('intake_output_summary');
  });
});

describe('icu_round_summary', () => {
  it('drafts ICU round summary', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, admission_date: '2026-04-29',
      primary_diagnosis: 'septic shock', ward: 'ICU', bed_number: 'ICU-3',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, recorded_at: '2026-05-01T08:00', heart_rate: 110, systolic_bp: 90,
        diastolic_bp: 60, spo2: 92, temperature_c: 38.5, respiratory_rate: 22 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 20, note_type: 'overnight', note_text: 'stable', author_role: 'NURSING_STAFF', created_at: '2026-05-01T03:00' },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 30, order_type: 'medication', details: 'noradrenaline drip', status: 'active', created_at: '2026-04-30' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('icu_round_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1600 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateIcuRoundSummary({ tenantId: TENANT, admissionId: 1 });
    expect(out.module_key).toBe('icu_round_summary');
  });
});
