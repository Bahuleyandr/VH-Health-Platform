/**
 * Tier A "fastest wins" assistant unit tests.
 * Mocks prisma + getClinicalAiModule + generateClinicalText + runOutputDefenses
 * to verify each generator's load shape, validation, and the shared pipeline
 * round-trip.
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
  generateAuditLogSummary,
  generateCallSummary,
  generateDischargeMedicationExplanation,
  generateFrontDeskResponse,
  generateHandwrittenNoteStructure,
  generateLabPendingReminder,
  generateLabTrendSummary,
  generatePatientFaqAnswer,
  generatePendingReportTracker,
  generateVoiceToPrescriptionDraft,
} = await import('../../services/ai/tierAAssistantsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function defaultModule(moduleKey, overrides = {}) {
  return {
    module_key: moduleKey,
    display_name: moduleKey,
    enabled: true,
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
// Lab trend summary
// ---------------------------------------------------------------------------

describe('generateLabTrendSummary', () => {
  it('rejects missing patient_uid', async () => {
    await expect(generateLabTrendSummary({ tenantId: TENANT, analyte: 'HbA1c' }))
      .rejects.toThrow(/patient_uid is required/);
  });

  it('rejects short analyte', async () => {
    await expect(generateLabTrendSummary({
      tenantId: TENANT, patientUid: PATIENT, analyte: 'a',
    })).rejects.toThrow(/at least 2 characters/);
  });

  it('throws 404 when no completed results in window', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateLabTrendSummary({
      tenantId: TENANT, patientUid: PATIENT, analyte: 'HbA1c',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('drafts a trend summary when results exist', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, test_name: 'HbA1c', completed_at: '2026-04-15', result_value: '6.8',
        result_unit: '%', reference_range: '<5.7', abnormal_flag: 'high' },
      { id: 2, test_name: 'HbA1c', completed_at: '2026-01-15', result_value: '7.2',
        result_unit: '%', reference_range: '<5.7', abnormal_flag: 'high' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('lab_trend_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateLabTrendSummary({
      tenantId: TENANT, patientUid: PATIENT, analyte: 'HbA1c', windowDays: 365,
    });
    expect(out.module_key).toBe('lab_trend_summary');
    expect(out.generation_id).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Discharge medication explanation
// ---------------------------------------------------------------------------

describe('generateDischargeMedicationExplanation', () => {
  it('rejects missing admission_id', async () => {
    await expect(generateDischargeMedicationExplanation({ tenantId: TENANT }))
      .rejects.toThrow(/admission_id/);
  });

  it('throws 404 when admission missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateDischargeMedicationExplanation({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 404 when no discharge prescriptions', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT, discharge_date: '2026-04-30' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateDischargeMedicationExplanation({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('drafts when admission + medications exist', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, discharge_date: '2026-04-30',
      discharge_diagnosis: 'CAP, resolving',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, medication_name: 'amoxicillin', dosage: '500mg', frequency: 'TDS', duration: '7 days' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('discharge_medication_explanation'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateDischargeMedicationExplanation({ tenantId: TENANT, admissionId: 1 });
    expect(out.module_key).toBe('discharge_medication_explanation');
  });
});

// ---------------------------------------------------------------------------
// Patient FAQ assistant
// ---------------------------------------------------------------------------

describe('generatePatientFaqAnswer', () => {
  it('rejects empty query', async () => {
    await expect(generatePatientFaqAnswer({ tenantId: TENANT, query: 'hi' }))
      .rejects.toThrow(/at least 5 characters/);
  });

  it('drafts an answer using retrieved KB chunks', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, knowledge_base_id: 5, document_id: 7,
        content: 'Visiting hours are 10am to 8pm.', kb_title: 'Hospital FAQ' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('patient_faq_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePatientFaqAnswer({
      tenantId: TENANT, query: 'When can I visit?',
    });
    expect(out.module_key).toBe('patient_faq_assistant');
  });

  it('still drafts when KB returns no passages (the model decides what to do)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    getModuleMock.mockResolvedValue(defaultModule('patient_faq_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 301 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePatientFaqAnswer({
      tenantId: TENANT, query: 'Where do I park?',
    });
    expect(out.module_key).toBe('patient_faq_assistant');
  });
});

// ---------------------------------------------------------------------------
// Lab pending reminder
// ---------------------------------------------------------------------------

describe('generateLabPendingReminder', () => {
  it('rejects missing patient_uid', async () => {
    await expect(generateLabPendingReminder({ tenantId: TENANT }))
      .rejects.toThrow(/patient_uid is required/);
  });

  it('throws 404 when no pending labs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateLabPendingReminder({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('drafts when there are overdue pending labs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, test_name: 'CBC', status: 'pending', requested_at: '2026-04-25', days_pending: 5 },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('lab_pending_result_reminder'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateLabPendingReminder({ tenantId: TENANT, patientUid: PATIENT });
    expect(out.module_key).toBe('lab_pending_result_reminder');
  });
});

// ---------------------------------------------------------------------------
// Front desk assistant
// ---------------------------------------------------------------------------

describe('generateFrontDeskResponse', () => {
  it('rejects empty query', async () => {
    await expect(generateFrontDeskResponse({ tenantId: TENANT, query: '' }))
      .rejects.toThrow(/at least 3 characters/);
  });

  it('drafts a response with KB passages', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, knowledge_base_id: 5, document_id: 7,
        content: 'Cardiology is on the 3rd floor.', kb_title: 'Reception FAQ' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('front_desk_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateFrontDeskResponse({
      tenantId: TENANT, query: 'Where is cardiology?',
    });
    expect(out.module_key).toBe('front_desk_assistant');
  });
});

// ---------------------------------------------------------------------------
// Audit log summary
// ---------------------------------------------------------------------------

describe('generateAuditLogSummary', () => {
  it('throws 404 when audit_log empty', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateAuditLogSummary({ tenantId: TENANT, windowDays: 7 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('drafts when there is activity', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { method: 'POST', path: '/api/v1/appointments', module: 'appointments', status_code: 500, occurrences: 25 },
      { method: 'GET', path: '/api/v1/users/:id', module: 'users', status_code: 200, occurrences: 1200 },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('audit_log_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 600 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateAuditLogSummary({ tenantId: TENANT, windowDays: 7 });
    expect(out.module_key).toBe('audit_log_summary');
  });
});

// ---------------------------------------------------------------------------
// Call summary
// ---------------------------------------------------------------------------

describe('generateCallSummary', () => {
  it('rejects too-short transcript', async () => {
    await expect(generateCallSummary({ tenantId: TENANT, transcript: 'short' }))
      .rejects.toThrow(/at least 50 characters/);
  });

  it('drafts when transcript is sufficient', async () => {
    getModuleMock.mockResolvedValue(defaultModule('call_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 700 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateCallSummary({
      tenantId: TENANT,
      transcript: 'Doctor: How are you feeling? Patient: Better but still some chest tightness in the mornings.',
      patientUid: PATIENT,
    });
    expect(out.module_key).toBe('call_summary');
  });
});

// ---------------------------------------------------------------------------
// Handwritten note assistant
// ---------------------------------------------------------------------------

describe('generateHandwrittenNoteStructure', () => {
  it('rejects too-short OCR text', async () => {
    await expect(generateHandwrittenNoteStructure({ tenantId: TENANT, ocrText: 'too short' }))
      .rejects.toThrow(/at least 30 characters/);
  });

  it('drafts when OCR text is sufficient', async () => {
    getModuleMock.mockResolvedValue(defaultModule('handwritten_note_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 800 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateHandwrittenNoteStructure({
      tenantId: TENANT,
      ocrText: 'Patient c/o cough x 3 days, low grade fever, dry cough, no SOB. Rx amoxicillin 500 mg TDS x 5/7.',
    });
    expect(out.module_key).toBe('handwritten_note_assistant');
  });
});

// ---------------------------------------------------------------------------
// Voice-to-prescription
// ---------------------------------------------------------------------------

describe('generateVoiceToPrescriptionDraft', () => {
  it('rejects too-short transcript', async () => {
    await expect(generateVoiceToPrescriptionDraft({ tenantId: TENANT, transcript: 'short' }))
      .rejects.toThrow(/at least 30 characters/);
  });

  it('drafts when transcript is sufficient', async () => {
    getModuleMock.mockResolvedValue(defaultModule('voice_to_prescription_draft'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 900 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateVoiceToPrescriptionDraft({
      tenantId: TENANT,
      transcript: 'Start the patient on metformin 500 mg twice daily for diabetes, recheck HbA1c in 3 months.',
    });
    expect(out.module_key).toBe('voice_to_prescription_draft');
  });
});

// ---------------------------------------------------------------------------
// Pending report tracker
// ---------------------------------------------------------------------------

describe('generatePendingReportTracker', () => {
  it('throws 404 when nothing overdue', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generatePendingReportTracker({ tenantId: TENANT, staleDays: 3 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('drafts when there is overdue work', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, test_name: 'CBC', status: 'pending', requested_at: '2026-04-20', days_pending: 10 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 2, modality: 'MRI', body_part: 'brain', status: 'awaiting_report',
        ordered_date: '2026-04-22', days_pending: 8 },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('pending_report_tracker'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1000 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePendingReportTracker({ tenantId: TENANT, staleDays: 3 });
    expect(out.module_key).toBe('pending_report_tracker');
  });

  it('rejects unknown scope by silently coercing to all (defensive)', async () => {
    // Both scoped queries return [], so we expect 404
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generatePendingReportTracker({ tenantId: TENANT, scope: 'magic' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
