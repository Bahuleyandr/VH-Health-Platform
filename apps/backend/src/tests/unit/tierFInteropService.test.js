/**
 * Tier F interoperability unit tests.
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
  generateAbdmCareContext,
  generateDocumentPatientMatching,
  generateFhirValidation,
  generateHealthRecordReconciliation,
  generateMedicalRecordBundle,
} = await import('../../services/ai/tierFInteropService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function defaultModule(moduleKey) {
  return { module_key: moduleKey, display_name: moduleKey, enabled: true,
    settings: { reviewRoles: ['INTEGRATION_ADMIN'], requiresClinicianSignoff: true } };
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

describe('fhir_validation_assistant', () => {
  it('rejects unknown resource_type', async () => {
    await expect(generateFhirValidation({ tenantId: TENANT, resourceType: 'magic',
      resourceJson: { resourceType: 'Magic' } })).rejects.toThrow(/resource_type must be/);
  });
  it('drafts validation report', async () => {
    getModuleMock.mockResolvedValue(defaultModule('fhir_validation_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateFhirValidation({
      tenantId: TENANT, resourceType: 'Patient',
      resourceJson: { resourceType: 'Patient', id: 'p1', name: [{ family: 'X' }] },
    });
    expect(out.module_key).toBe('fhir_validation_assistant');
  });
});

describe('abdm_care_context_assistant', () => {
  it('throws 404 when admission missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(generateAbdmCareContext({ tenantId: TENANT, admissionId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('drafts care context payload', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, admission_date: '2026-04-30', discharge_date: '2026-05-02',
      primary_diagnosis: 'CAP',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // labs
    queryUnsafeMock.mockResolvedValueOnce([]); // meds
    getModuleMock.mockResolvedValue(defaultModule('abdm_care_context_assistant'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateAbdmCareContext({ tenantId: TENANT, admissionId: 1 });
    expect(out.module_key).toBe('abdm_care_context_assistant');
  });
});

describe('health_record_reconciliation', () => {
  it('rejects missing record_a', async () => {
    await expect(generateHealthRecordReconciliation({
      tenantId: TENANT, recordB: { foo: 'bar' },
    })).rejects.toThrow(/record_a/);
  });
  it('drafts conflict surfacing', async () => {
    getModuleMock.mockResolvedValue(defaultModule('health_record_reconciliation'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateHealthRecordReconciliation({
      tenantId: TENANT,
      recordA: { name: 'Mahalakshmi', dob: '1985-04-12', sex: 'F' },
      recordB: { name: 'Mahalakshmi S', dob: '1985-04-12', sex: 'F' },
    });
    expect(out.module_key).toBe('health_record_reconciliation');
  });
});

describe('document_patient_matching', () => {
  it('rejects too-short document', async () => {
    await expect(generateDocumentPatientMatching({
      tenantId: TENANT, documentText: 'short',
    })).rejects.toThrow(/at least 30 characters/);
  });
  it('drafts matching candidates', async () => {
    getModuleMock.mockResolvedValue(defaultModule('document_patient_matching'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateDocumentPatientMatching({
      tenantId: TENANT,
      documentText: 'Discharge summary for patient with CAP, follow-up in 1 week.',
      candidatePatients: [
        { uid: PATIENT, name: 'Test Patient', phone: '+919876543210' },
      ],
    });
    expect(out.module_key).toBe('document_patient_matching');
  });
});

describe('medical_record_bundle_generator', () => {
  it('rejects unknown scope', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, patient_uid: PATIENT }]);
    await expect(generateMedicalRecordBundle({
      tenantId: TENANT, admissionId: 1, scope: 'magic',
    })).rejects.toThrow(/scope must be/);
  });
  it('drafts insurance bundle', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, patient_uid: PATIENT, admission_date: '2026-04-30',
      primary_diagnosis: 'CAP', total_charges: 50000,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    getModuleMock.mockResolvedValue(defaultModule('medical_record_bundle_generator'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateMedicalRecordBundle({
      tenantId: TENANT, admissionId: 1, scope: 'insurance',
    });
    expect(out.module_key).toBe('medical_record_bundle_generator');
  });
});
