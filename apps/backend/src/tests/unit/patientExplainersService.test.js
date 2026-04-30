/**
 * Tier A patient explainer unit tests.
 *
 * Each generator: load row → call shared pipeline → persist generation +
 * review row. Mocks prisma, getClinicalAiModule, generateClinicalText, and
 * runOutputDefenses to assert per-explainer SQL load shape, validation,
 * and the disabled-module guard.
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
  generateInvoicePatientExplanation,
  generateLabPatientExplanation,
  generatePatientReportExplanation,
  generatePrescriptionPatientExplanation,
  generateRadiologyPatientExplanation,
  __testing__,
} = await import('../../services/ai/patientExplainersService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);

  // Default: module enabled, AI returns a clean draft, persistence succeeds.
  getModuleMock.mockResolvedValue({
    module_key: 'lab_patient_explanation',
    display_name: 'Lab Result Patient Explanation',
    enabled: true,
    settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true },
  });
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      explanation_summary: 'Your hemoglobin is slightly low.',
      key_points: [{ label: 'Hemoglobin', value: '9.2 g/dL', what_it_means: 'below typical range' }],
      next_steps: ['Discuss with your doctor at your next visit.'],
      when_to_seek_help: ['Severe weakness or shortness of breath'],
      source_citations: [],
      safety_flags: [],
    }),
    usedAi: true,
    provider: 'ollama',
    model: 'qwen2.5:14b',
    usage: { prompt_tokens: 200, completion_tokens: 150, total_tokens: 350, latency_ms: 850 },
  });
  // Three DB writes per pipeline call: domain SELECT (in tests where the
  // generator loads a row), then INSERT generations, then INSERT reviews.
});

function mockRow(row) {
  queryUnsafeMock.mockResolvedValueOnce([row]);
}
function mockEmpty() {
  queryUnsafeMock.mockResolvedValueOnce([]);
}
function mockGenInsertOk(generationId = 99) {
  queryUnsafeMock.mockResolvedValueOnce([{ id: generationId }]);
}
function mockReviewInsertOk() {
  queryUnsafeMock.mockResolvedValueOnce([]);
}

describe('generateLabPatientExplanation', () => {
  it('rejects non-numeric investigation_id', async () => {
    await expect(
      generateLabPatientExplanation({ tenantId: TENANT, investigationId: 'abc' }),
    ).rejects.toThrow(/positive integer/);
  });

  it('throws 404 when the investigation row is missing', async () => {
    mockEmpty();
    await expect(
      generateLabPatientExplanation({ tenantId: TENANT, investigationId: 999 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 400 when the row has no test_name', async () => {
    mockRow({ id: 5, test_name: null });
    await expect(
      generateLabPatientExplanation({ tenantId: TENANT, investigationId: 5 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects when the module is disabled', async () => {
    getModuleMock.mockResolvedValueOnce({ module_key: 'lab_patient_explanation', display_name: 'Lab', enabled: false, settings: {} });
    mockRow({ id: 5, uid: '11111111-1111-4111-8111-111111111111', test_name: 'Hemoglobin', result_value: '9.2', result_unit: 'g/dL', reference_range: '12-16' });
    await expect(
      generateLabPatientExplanation({ tenantId: TENANT, investigationId: 5 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('runs the pipeline + persists generation + review on the happy path', async () => {
    mockRow({
      id: 5,
      uid: '11111111-1111-4111-8111-111111111111',
      test_name: 'Hemoglobin',
      result_value: '9.2',
      result_unit: 'g/dL',
      reference_range: '12-16',
      abnormal_flag: 'low',
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    mockGenInsertOk(101);
    mockReviewInsertOk();

    const result = await generateLabPatientExplanation({
      tenantId: TENANT,
      investigationId: 5,
      generatedBy: 'admin-uid',
    });

    expect(result.module_key).toBe('lab_patient_explanation');
    expect(result.generation_id).toBe(101);
    expect(result.review_status).toBe('pending');
    expect(result.draft.explanation_summary).toMatch(/hemoglobin/i);
    expect(result.source_citations[0]).toMatchObject({ source_type: 'investigation', source_id: '5' });

    // Verify generateClinicalText was called with the lab payload.
    const llmCall = generateClinicalTextMock.mock.calls[0][0];
    expect(llmCall.taskType).toBe('lab_patient_explanation');
    const userPayload = JSON.parse(llmCall.userPrompt);
    expect(userPayload.test_name).toBe('Hemoglobin');
    expect(userPayload.reference_range).toBe('12-16');
  });

  it('marks status="failed" when defenses report a critical safety flag', async () => {
    mockRow({ id: 5, uid: '11111111-1111-4111-8111-111111111111', test_name: 'Hemoglobin', result_value: '9.2', result_unit: 'g/dL', reference_range: '12-16' });
    runOutputDefensesMock.mockReturnValueOnce([{ severity: 'critical', code: 'PHI_LEAK_SUSPECTED', message: 'leak' }]);
    mockGenInsertOk(102);
    mockReviewInsertOk();

    const result = await generateLabPatientExplanation({ tenantId: TENANT, investigationId: 5 });
    expect(result.status).toBe('failed');
    expect(result.review_status).toBe('failed');
    expect(result.safety_flags.some((f) => f.severity === 'critical')).toBe(true);
  });
});

describe('generateRadiologyPatientExplanation', () => {
  it('throws 404 when the radiology order is missing', async () => {
    mockEmpty();
    await expect(
      generateRadiologyPatientExplanation({ tenantId: TENANT, radiologyOrderId: 5 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 400 when modality + body_part are both empty', async () => {
    mockRow({ id: 5, modality: null, body_part: null });
    await expect(
      generateRadiologyPatientExplanation({ tenantId: TENANT, radiologyOrderId: 5 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('runs the pipeline with modality + body_part + findings', async () => {
    getModuleMock.mockResolvedValue({ module_key: 'radiology_patient_explanation', display_name: 'Radiology', enabled: true, settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true } });
    mockRow({ id: 7, patient_uid: '22222222-2222-4222-8222-222222222222', modality: 'CT', body_part: 'chest', findings: 'No acute abnormality.', impression: 'Normal' });
    mockGenInsertOk(202);
    mockReviewInsertOk();

    const result = await generateRadiologyPatientExplanation({ tenantId: TENANT, radiologyOrderId: 7 });
    expect(result.module_key).toBe('radiology_patient_explanation');
    const userPayload = JSON.parse(generateClinicalTextMock.mock.calls[0][0].userPrompt);
    expect(userPayload.modality).toBe('CT');
    expect(userPayload.body_part).toBe('chest');
  });
});

describe('generatePatientReportExplanation', () => {
  it('rejects empty report_type', async () => {
    await expect(
      generatePatientReportExplanation({ tenantId: TENANT, reportType: '', reportText: 'x'.repeat(50) }),
    ).rejects.toThrow(/report_type/);
  });

  it('rejects very short report_text', async () => {
    await expect(
      generatePatientReportExplanation({ tenantId: TENANT, reportType: 'consultation', reportText: 'short' }),
    ).rejects.toThrow(/at least 30 characters/);
  });

  it('does NOT load any DB row (free-text path) and runs pipeline', async () => {
    getModuleMock.mockResolvedValue({ module_key: 'patient_report_explainer', display_name: 'Generic', enabled: true, settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true } });
    mockGenInsertOk(303);
    mockReviewInsertOk();

    const reportText = 'Patient seen for a 2-week cough; chest exam clear; advised supportive care and review in 5 days.';
    const result = await generatePatientReportExplanation({
      tenantId: TENANT,
      reportType: 'consultation',
      reportText,
    });
    expect(result.module_key).toBe('patient_report_explainer');
    const userPayload = JSON.parse(generateClinicalTextMock.mock.calls[0][0].userPrompt);
    expect(userPayload.report_type).toBe('consultation');
    expect(userPayload.report_text).toContain('2-week cough');
  });
});

describe('generatePrescriptionPatientExplanation', () => {
  it('throws 404 when the row is missing', async () => {
    mockEmpty();
    await expect(
      generatePrescriptionPatientExplanation({ tenantId: TENANT, prescriptionId: 5 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('runs the pipeline with medication context', async () => {
    getModuleMock.mockResolvedValue({ module_key: 'prescription_patient_explainer', display_name: 'Rx', enabled: true, settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true } });
    mockRow({ id: 9, patient_uid: '33333333-3333-4333-8333-333333333333', medication_name: 'Amoxicillin', dosage: '500 mg', frequency: 'BD', duration: '5 days', instructions: 'After food', status: 'active' });
    mockGenInsertOk(404);
    mockReviewInsertOk();

    const result = await generatePrescriptionPatientExplanation({ tenantId: TENANT, prescriptionId: 9 });
    expect(result.module_key).toBe('prescription_patient_explainer');
    const userPayload = JSON.parse(generateClinicalTextMock.mock.calls[0][0].userPrompt);
    expect(userPayload.medication_name).toBe('Amoxicillin');
    expect(userPayload.dosage).toBe('500 mg');
  });
});

describe('generateInvoicePatientExplanation', () => {
  it('throws 404 when the invoice is missing', async () => {
    mockEmpty();
    await expect(
      generateInvoicePatientExplanation({ tenantId: TENANT, invoiceId: 5 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('runs the pipeline with billing context', async () => {
    getModuleMock.mockResolvedValue({ module_key: 'invoice_patient_explainer', display_name: 'Invoice', enabled: true, settings: { reviewRoles: ['BILLING_STAFF'], requiresClinicianSignoff: false } });
    mockRow({
      id: 11,
      patient_uid: '44444444-4444-4444-8444-444444444444',
      total_amount: 12500,
      paid_amount: 5000,
      balance_amount: 7500,
      insurance_covered_amount: 3000,
      status: 'partially_paid',
      line_items: [{ name: 'Room charges', amount: 8000 }, { name: 'Medications', amount: 4500 }],
    });
    mockGenInsertOk(505);
    mockReviewInsertOk();

    const result = await generateInvoicePatientExplanation({ tenantId: TENANT, invoiceId: 11 });
    expect(result.module_key).toBe('invoice_patient_explainer');
    expect(result.requires_signoff).toBe(false);
  });
});

describe('explainer module set', () => {
  it('exposes exactly the five Tier A module keys', () => {
    expect([...__testing__.EXPLAINER_MODULES].sort()).toEqual([
      'invoice_patient_explainer',
      'lab_patient_explanation',
      'patient_report_explainer',
      'prescription_patient_explainer',
      'radiology_patient_explanation',
    ]);
  });
});
