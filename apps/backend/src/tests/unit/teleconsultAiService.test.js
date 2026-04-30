/**
 * Phase B1 — teleconsultAiService unit tests.
 *
 * Two AI generators (pre-visit summary + note draft) sharing
 * runTeleconsultPipeline. Mocks isolate validation, the disabled-module
 * guard, and the FK-link back onto teleconsultations.
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
  generatePreVisitSummary,
  generateTeleconsultNoteDraft,
  __testing__,
} = await import('../../services/ai/teleconsultAiService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

const CONSULT = {
  id: 7, patient_uid: PATIENT, doctor_uid: null,
  chief_complaint: 'fever 3 days',
  pre_consult_form: { duration: '3 days' },
  consult_type: 'video', status: 'in_progress',
};

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);

  getModuleMock.mockResolvedValue({
    module_key: 'teleconsult_pre_visit_summary',
    display_name: 'Teleconsult Pre-Visit Summary',
    enabled: true,
    settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true },
  });
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      chief_complaint: 'fever 3 days',
      suggested_questions: ['onset?'],
      red_flags: [],
      source_citations: [],
      safety_flags: [],
    }),
    usedAi: true,
    provider: 'ollama',
    model: 'qwen2.5:14b',
    usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120, latency_ms: 200 },
  });
});

describe('TELECONSULT_AI_MODULES set', () => {
  it('contains exactly the 2 keys', () => {
    expect(__testing__.TELECONSULT_AI_MODULES.size).toBe(2);
    expect(__testing__.TELECONSULT_AI_MODULES.has('teleconsult_pre_visit_summary')).toBe(true);
    expect(__testing__.TELECONSULT_AI_MODULES.has('teleconsult_note_draft')).toBe(true);
  });
});

describe('generatePreVisitSummary', () => {
  it('rejects non-numeric teleconsultation_id', async () => {
    await expect(generatePreVisitSummary({ tenantId: TENANT, teleconsultationId: 'abc' }))
      .rejects.toThrow(/positive integer/);
  });

  it('throws 404 when consult missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generatePreVisitSummary({ tenantId: TENANT, teleconsultationId: 7 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 403 when module disabled', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONSULT]);
    getModuleMock.mockResolvedValueOnce({ enabled: false, display_name: 'X', settings: {} });
    await expect(generatePreVisitSummary({ tenantId: TENANT, teleconsultationId: 7 }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('persists draft + review + back-links onto consult', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONSULT]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1001 }]); // generation insert
    queryUnsafeMock.mockResolvedValueOnce([]); // review insert
    queryUnsafeMock.mockResolvedValueOnce([]); // back-link UPDATE
    const result = await generatePreVisitSummary({ tenantId: TENANT, teleconsultationId: 7 });
    expect(result.module_key).toBe('teleconsult_pre_visit_summary');
    expect(result.generation_id).toBe(1001);
    const linkCall = queryUnsafeMock.mock.calls[3][0];
    expect(linkCall).toMatch(/UPDATE teleconsultations/);
    expect(linkCall).toMatch(/ai_pre_visit_summary_id = \$1/);
  });

  it('marks status=failed on critical defense flag', async () => {
    runOutputDefensesMock.mockReturnValueOnce([{ severity: 'critical', code: 'phi_leak' }]);
    queryUnsafeMock.mockResolvedValueOnce([CONSULT]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1002 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await generatePreVisitSummary({ tenantId: TENANT, teleconsultationId: 7 });
    expect(result.status).toBe('failed');
    expect(result.review_status).toBe('failed');
  });
});

describe('generateTeleconsultNoteDraft', () => {
  it('loads chat transcript and persists draft', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONSULT]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, authored_role: 'patient', body: 'fever 3 days', body_kind: 'text', created_at: new Date() },
      { id: 2, authored_role: 'doctor', body: 'any cough?', body_kind: 'text', created_at: new Date() },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await generateTeleconsultNoteDraft({ tenantId: TENANT, teleconsultationId: 7 });
    expect(result.module_key).toBe('teleconsult_note_draft');
    expect(result.generation_id).toBe(2001);
    const linkCall = queryUnsafeMock.mock.calls[4][0];
    expect(linkCall).toMatch(/ai_note_generation_id = \$1/);
    // 2 chat messages should be appended as citations.
    expect(result.source_citations.length).toBeGreaterThanOrEqual(3);
  });

  it('handles empty transcript gracefully', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONSULT]);
    queryUnsafeMock.mockResolvedValueOnce([]);  // empty transcript
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2002 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await generateTeleconsultNoteDraft({ tenantId: TENANT, teleconsultationId: 7 });
    expect(result.module_key).toBe('teleconsult_note_draft');
  });

  it('degrades gracefully when chat schema missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([CONSULT]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "chat_session_messages" does not exist'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2003 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await generateTeleconsultNoteDraft({ tenantId: TENANT, teleconsultationId: 7 });
    expect(result.generation_id).toBe(2003);
  });
});
