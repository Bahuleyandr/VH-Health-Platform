/**
 * Tier D ED/triage assistant unit tests.
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
  generateAmbulanceHandoverSummary,
  generateChestPainProtocol,
  generateEdRedFlagDetection,
  generateEmergencyTriageForm,
  generateEmergencyVisitSummary,
  generateMlcDocumentation,
  generateStrokeFastCheckAssistant,
  generateTraumaChecklist,
  generateTriagePrioritySuggestion,
} = await import('../../services/ai/tierDEmergencyService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function defaultModule(moduleKey) {
  return {
    module_key: moduleKey, display_name: moduleKey, enabled: true,
    settings: { reviewRoles: ['DOCTOR'], requiresClinicianSignoff: true },
  };
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

describe('emergency_triage_form_assistant', () => {
  it('rejects too-short transcript', async () => {
    await expect(generateEmergencyTriageForm({ tenantId: TENANT, transcript: 'short' }))
      .rejects.toThrow(/at least 30 characters/);
  });
  it('drafts when transcript present', async () => {
    getModuleMock.mockResolvedValue(defaultModule('emergency_triage_form_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateEmergencyTriageForm({
      tenantId: TENANT,
      transcript: '54-year-old male, chest pain x 2 hours, BP 110/70, HR 95, SpO2 96.',
    });
    expect(out.module_key).toBe('emergency_triage_form_assistant');
  });
});

describe('triage_priority_suggestion', () => {
  it('rejects unknown scale', async () => {
    await expect(generateTriagePrioritySuggestion({
      tenantId: TENANT, scale: 'magic', chiefComplaint: 'chest pain',
    })).rejects.toThrow(/scale must be/);
  });
  it('drafts ESI priority', async () => {
    getModuleMock.mockResolvedValue(defaultModule('triage_priority_suggestion'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateTriagePrioritySuggestion({
      tenantId: TENANT, scale: 'ESI', chiefComplaint: 'chest pain',
      vitals: { hr: 105, spo2: 96 },
    });
    expect(out.module_key).toBe('triage_priority_suggestion');
  });
});

describe('ed_red_flag_detection', () => {
  it('rejects empty chief complaint', async () => {
    await expect(generateEdRedFlagDetection({ tenantId: TENANT, chiefComplaint: '' }))
      .rejects.toThrow(/at least 3 characters/);
  });
  it('drafts red flag screen', async () => {
    getModuleMock.mockResolvedValue(defaultModule('ed_red_flag_detection'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateEdRedFlagDetection({
      tenantId: TENANT, chiefComplaint: 'sudden severe headache + neck stiffness',
      ageYears: 45,
    });
    expect(out.module_key).toBe('ed_red_flag_detection');
  });
});

describe('emergency_visit_summary', () => {
  it('throws 404 when visit missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateEmergencyVisitSummary({ tenantId: TENANT, emergencyVisitId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts when visit + triage exist', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, arrival_at: '2026-05-01', disposition: 'discharge',
      chief_complaint: 'chest pain',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 5, scale: 'ESI', score: 3, priority: 'urgent', recorded_at: '2026-05-01' },
    ]);
    getModuleMock.mockResolvedValue(defaultModule('emergency_visit_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateEmergencyVisitSummary({ tenantId: TENANT, emergencyVisitId: 1 });
    expect(out.module_key).toBe('emergency_visit_summary');
  });
});

describe('ambulance_handover_summary', () => {
  it('throws 404 when ambulance missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateAmbulanceHandoverSummary({ tenantId: TENANT, ambulanceRequestId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts handover', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, dispatched_at: '2026-05-01T08:00',
      chief_complaint: 'MVC', dispatch_kind: 'emergency',
    }]);
    getModuleMock.mockResolvedValue(defaultModule('ambulance_handover_summary'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateAmbulanceHandoverSummary({
      tenantId: TENANT, ambulanceRequestId: 1,
    });
    expect(out.module_key).toBe('ambulance_handover_summary');
  });
});

describe('stroke_fast_check_assistant', () => {
  it('drafts FAST screen', async () => {
    getModuleMock.mockResolvedValue(defaultModule('stroke_fast_check_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 600 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateStrokeFastCheckAssistant({
      tenantId: TENANT,
      observations: 'Right facial droop, slurred speech, last well 2h ago',
    });
    expect(out.module_key).toBe('stroke_fast_check_assistant');
  });
});

describe('chest_pain_protocol_assistant', () => {
  it('drafts HEART scoring', async () => {
    getModuleMock.mockResolvedValue(defaultModule('chest_pain_protocol_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 700 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateChestPainProtocol({
      tenantId: TENANT,
      observations: 'central chest pain, radiates to left arm, diaphoresis',
      riskFactors: ['hypertension', 'smoker'],
      ecg: 'sinus rhythm with mild ST depression',
      troponin: 0.05,
    });
    expect(out.module_key).toBe('chest_pain_protocol_assistant');
  });
});

describe('trauma_checklist_assistant', () => {
  it('drafts ATLS checklist', async () => {
    getModuleMock.mockResolvedValue(defaultModule('trauma_checklist_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 800 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateTraumaChecklist({
      tenantId: TENANT,
      observations: 'unrestrained MVC, GCS 13, BP 90/60, abdomen tender RUQ',
      mechanism: 'MVC',
    });
    expect(out.module_key).toBe('trauma_checklist_assistant');
  });
});

describe('mlc_documentation_assistant', () => {
  it('throws 404 when MLC missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateMlcDocumentation({ tenantId: TENANT, mlcRecordId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts MLC pack with linked visit', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, emergency_visit_id: 9, mlc_kind: 'assault', status: 'open',
      opened_at: '2026-05-01', informant_relationship: 'self',
      alleged_history: 'allegedly assaulted at home', mlc_number: 'MLC-2026-001',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 9, patient_uid: PATIENT, arrival_at: '2026-05-01', chief_complaint: 'head injury',
    }]);
    getModuleMock.mockResolvedValue(defaultModule('mlc_documentation_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 900 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMlcDocumentation({ tenantId: TENANT, mlcRecordId: 1 });
    expect(out.module_key).toBe('mlc_documentation_assistant');
  });
});
