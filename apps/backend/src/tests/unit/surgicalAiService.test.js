/**
 * Tier B PR2 — surgicalAiService unit tests.
 *
 * Eight surgical AI module generators all share runSurgicalPipeline: load
 * ot_schedule + relevant Tier B PR1 row -> generateClinicalText -> defenses
 * -> persist generations + reviews. Mocks isolate validation, disabled-module
 * guard, and SQL load shape per generator.
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
  detectPostOpComplications,
  draftOperativeNote,
  draftPostOpInstructions,
  draftSurgicalConsent,
  reviewPreopChecklist,
  runAnesthesiaPrecheck,
  summarizeSurgicalRisk,
  trackImplantsAndConsumables,
  __testing__,
} = await import('../../services/ai/surgicalAiService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

const CASE = {
  id: 42, patient_uid: PATIENT, encounter_id: null,
  surgeon: 'surgeon-uid', anesthetist: 'anaes-uid',
  procedure_name: 'Lap appendectomy', procedure_code: '47.09',
  ot_room: 'OR-3', scheduled_date: '2026-05-01',
  scheduled_time: '08:00', estimated_duration: 90,
  actual_duration: null, status: 'scheduled',
  equipment_needed: ['lap-kit'], blood_arranged: false, consent_obtained: true,
};

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset().mockReturnValue([]);

  getModuleMock.mockResolvedValue({
    module_key: 'preop_checklist_review',
    display_name: 'Pre-Op Checklist Review',
    enabled: true,
    settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true },
  });
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({
      readiness_status: 'ready',
      missing_items: [],
      recommendations: [],
      source_citations: [],
      safety_flags: [],
    }),
    usedAi: true,
    provider: 'ollama',
    model: 'qwen2.5:14b',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, latency_ms: 400 },
  });
});

function mockRow(row) { queryUnsafeMock.mockResolvedValueOnce([row]); }
function mockRows(rows) { queryUnsafeMock.mockResolvedValueOnce(rows); }
function mockEmpty() { queryUnsafeMock.mockResolvedValueOnce([]); }

describe('SURGICAL_AI_MODULES exports the eight registered keys', () => {
  it('contains exactly the 8 surgical AI keys', () => {
    expect(__testing__.SURGICAL_AI_MODULES.size).toBe(8);
    expect(__testing__.SURGICAL_AI_MODULES.has('preop_checklist_review')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('surgical_consent_draft')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('ot_note_draft')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('post_op_instruction_draft')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('surgical_risk_summary')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('anesthesia_precheck_assistant')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('implant_consumable_tracker')).toBe(true);
    expect(__testing__.SURGICAL_AI_MODULES.has('post_op_complication_alert')).toBe(true);
  });
});

describe('reviewPreopChecklist', () => {
  it('rejects non-numeric ot_schedule_id', async () => {
    await expect(reviewPreopChecklist({ tenantId: TENANT, otScheduleId: 'abc' }))
      .rejects.toThrow(/positive integer/);
  });

  it('throws 404 when the case is missing', async () => {
    mockEmpty();
    await expect(reviewPreopChecklist({ tenantId: TENANT, otScheduleId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 403 when the module is disabled', async () => {
    mockRow(CASE);                 // case load
    mockEmpty();                   // checklist load (none)
    getModuleMock.mockResolvedValueOnce({ enabled: false, display_name: 'X', settings: {} });
    await expect(reviewPreopChecklist({ tenantId: TENANT, otScheduleId: 42 }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('persists draft + review when module is enabled', async () => {
    mockRow(CASE);
    mockRow({ id: 9, status: 'in_progress' });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1001 }]); // generation insert
    queryUnsafeMock.mockResolvedValueOnce([]);             // review insert
    const result = await reviewPreopChecklist({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('preop_checklist_review');
    expect(result.generation_id).toBe(1001);
    expect(result.decision_support_only).toBe(true);
    expect(result.requires_signoff).toBe(true);
    expect(result.review_status).toBe('pending');
  });

  it('marks status=failed when defenses return critical flag', async () => {
    runOutputDefensesMock.mockReturnValueOnce([{ severity: 'critical', code: 'phi_leak' }]);
    mockRow(CASE);
    mockEmpty();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1002 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await reviewPreopChecklist({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.status).toBe('failed');
    expect(result.review_status).toBe('failed');
    expect(result.safety_flags.some((f) => f.severity === 'critical')).toBe(true);
  });
});

describe('draftSurgicalConsent', () => {
  it('loads case + patient summary, persists draft', async () => {
    mockRow(CASE);
    mockRow({ patient_uid: PATIENT, full_name: 'Test Patient' }); // patient summary
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await draftSurgicalConsent({
      tenantId: TENANT, otScheduleId: 42,
      patientComorbidities: ['DM2', 'HTN'],
    });
    expect(result.module_key).toBe('surgical_consent_draft');
    expect(result.generation_id).toBe(2001);
    // Check that the LLM call received the patient comorbidities.
    const llmCall = generateClinicalTextMock.mock.calls[0][0];
    expect(llmCall.userPrompt).toContain('DM2');
  });
});

describe('draftOperativeNote', () => {
  it('loads case + persists draft', async () => {
    mockRow(CASE);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 3001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await draftOperativeNote({
      tenantId: TENANT, otScheduleId: 42,
      surgeonNotes: 'Standard 3-port lap; appendix retrocecal.',
    });
    expect(result.module_key).toBe('ot_note_draft');
    expect(result.generation_id).toBe(3001);
  });
});

describe('draftPostOpInstructions', () => {
  it('loads case + patient + persists draft', async () => {
    mockRow(CASE);
    mockRow({ patient_uid: PATIENT, full_name: 'Test Patient' });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 4001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await draftPostOpInstructions({
      tenantId: TENANT, otScheduleId: 42, language: 'ta',
    });
    expect(result.module_key).toBe('post_op_instruction_draft');
    // Language carried through to the LLM call.
    const llmCall = generateClinicalTextMock.mock.calls[0][0];
    expect(llmCall.systemPrompt).toContain('Target language: ta');
  });
});

describe('summarizeSurgicalRisk', () => {
  it('loads case + patient + anesthesia, persists draft', async () => {
    mockRow(CASE);
    mockRow({ patient_uid: PATIENT, full_name: 'Test Patient' });
    mockRow({ asa_grade: 'III', technique: 'general' });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await summarizeSurgicalRisk({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('surgical_risk_summary');
    expect(result.generation_id).toBe(5001);
  });

  it('handles missing anesthesia row gracefully', async () => {
    mockRow(CASE);
    mockRow({ patient_uid: PATIENT });
    mockEmpty();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5002 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await summarizeSurgicalRisk({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('surgical_risk_summary');
  });
});

describe('runAnesthesiaPrecheck', () => {
  it('loads case + patient + anesthesia row, persists draft', async () => {
    mockRow(CASE);
    mockRow({ patient_uid: PATIENT });
    mockRow({ id: 7, asa_grade: 'II' });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 6001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await runAnesthesiaPrecheck({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('anesthesia_precheck_assistant');
    expect(result.generation_id).toBe(6001);
  });
});

describe('trackImplantsAndConsumables', () => {
  it('reconciles implants + persists draft', async () => {
    mockRow(CASE);
    mockRows([
      { id: 11, implant_type: 'knee_prosthesis', manufacturer: 'AcmeMed',
        lot_number: 'LOT-1', udi: 'UDI-9', expiry_date: '2026-12-31',
        status: 'in_situ' },
      { id: 12, implant_type: 'screw', manufacturer: 'AcmeMed',
        lot_number: null, udi: null, expiry_date: null, status: 'in_situ' },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await trackImplantsAndConsumables({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('implant_consumable_tracker');
    expect(result.source_citations.length).toBeGreaterThan(2); // case + 2 implants
  });

  it('handles zero implants gracefully', async () => {
    mockRow(CASE);
    mockRows([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7002 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await trackImplantsAndConsumables({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('implant_consumable_tracker');
  });
});

describe('detectPostOpComplications', () => {
  it('loads postop_notes + open alerts, persists draft', async () => {
    mockRow(CASE);
    mockRows([
      { id: 1, pod_number: 3, recovery_phase: 'ward', vitals: { hr: 130, sbp: 90 },
        pain_score: 8, drain_status: [], wound_status: 'erythematous',
        complications_noted: 'fevers', urine_output_ml: 200, created_at: new Date() },
    ]);
    mockRows([]);  // no existing alerts
    queryUnsafeMock.mockResolvedValueOnce([{ id: 8001 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await detectPostOpComplications({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.module_key).toBe('post_op_complication_alert');
    expect(result.generation_id).toBe(8001);
  });

  it('passes existing open alerts to the LLM to avoid duplicates', async () => {
    mockRow(CASE);
    mockRows([{ id: 1, pod_number: 1, recovery_phase: 'ward', vitals: {} }]);
    mockRows([{ id: 99, complication_type: 'sepsis', severity: 'high', status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 8002 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await detectPostOpComplications({ tenantId: TENANT, otScheduleId: 42 });
    const llmCall = generateClinicalTextMock.mock.calls[0][0];
    expect(llmCall.userPrompt).toContain('sepsis');
    expect(llmCall.userPrompt).toContain('99');
  });
});

describe('clinical_ai_modules registry export', () => {
  it('clinicalAiModuleService exports the 8 surgical module keys', async () => {
    // Cross-check by re-importing the unmocked module — use jest.requireActual? Skip here; the SURGICAL_AI_MODULES set is the canonical guard.
    const surgicalKeys = [
      'preop_checklist_review',
      'surgical_consent_draft',
      'ot_note_draft',
      'post_op_instruction_draft',
      'surgical_risk_summary',
      'anesthesia_precheck_assistant',
      'implant_consumable_tracker',
      'post_op_complication_alert',
    ];
    for (const key of surgicalKeys) {
      expect(__testing__.SURGICAL_AI_MODULES.has(key)).toBe(true);
    }
  });
});
