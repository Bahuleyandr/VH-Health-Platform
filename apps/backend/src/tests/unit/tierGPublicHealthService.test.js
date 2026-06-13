/**
 * Tier G public-health unit tests.
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
  generateChronicDiseaseRegistry,
  generateHighRiskCohorts,
  generatePhiDeidentification,
  generatePublicHealthReport,
  generateScreeningGapDetection,
} = await import('../../services/ai/tierGPublicHealthService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function defaultModule(moduleKey) {
  return { module_key: moduleKey, display_name: moduleKey, enabled: true,
    settings: { reviewRoles: ['ADMIN'], requiresClinicianSignoff: false } };
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

describe('chronic_disease_registry', () => {
  it('rejects unknown condition', async () => {
    await expect(generateChronicDiseaseRegistry({ tenantId: TENANT, condition: 'magic' }))
      .rejects.toThrow(/condition must be one of/);
  });
  it('drafts registry overview', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ active_patients: 412 }]);
    getModuleMock.mockResolvedValue(defaultModule('chronic_disease_registry'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateChronicDiseaseRegistry({
      tenantId: TENANT, condition: 'diabetes',
    });
    expect(out.module_key).toBe('chronic_disease_registry');
  });
});

describe('screening_gap_detection', () => {
  it('rejects unknown screening_type', async () => {
    await expect(generateScreeningGapDetection({ tenantId: TENANT, screeningType: 'magic' }))
      .rejects.toThrow(/screening_type must be one of/);
  });
  it('drafts gap report', async () => {
    getModuleMock.mockResolvedValue(defaultModule('screening_gap_detection'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 200 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateScreeningGapDetection({
      tenantId: TENANT, screeningType: 'cervical',
    });
    expect(out.module_key).toBe('screening_gap_detection');
  });
});

describe('high_risk_patient_cohorts', () => {
  it('drafts cohort definition', async () => {
    getModuleMock.mockResolvedValue(defaultModule('high_risk_patient_cohorts'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 300 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generateHighRiskCohorts({
      tenantId: TENANT, criteria: { admissions_in_12mo: 3, comorbidity_count: 3 },
    });
    expect(out.module_key).toBe('high_risk_patient_cohorts');
  });
});

describe('public_health_report_generator', () => {
  it('rejects unknown report_type', async () => {
    await expect(generatePublicHealthReport({
      tenantId: TENANT, reportType: 'magic',
    })).rejects.toThrow(/report_type must be one of/);
  });
  it('drafts notifiable_disease report', async () => {
    getModuleMock.mockResolvedValue(defaultModule('public_health_report_generator'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 400 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePublicHealthReport({
      tenantId: TENANT, reportType: 'notifiable_disease', periodDays: 30,
    });
    expect(out.module_key).toBe('public_health_report_generator');
  });
});

describe('phi_deidentification', () => {
  it('rejects too-short source', async () => {
    await expect(generatePhiDeidentification({ tenantId: TENANT, sourceText: 'short' }))
      .rejects.toThrow(/at least 30 characters/);
  });
  it('drafts de-identified output', async () => {
    getModuleMock.mockResolvedValue(defaultModule('phi_deidentification'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 500 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await generatePhiDeidentification({
      tenantId: TENANT,
      sourceText: 'Patient John Doe, phone 9876543210, presented on 2026-04-30 with cough x 3 days.',
    });
    expect(out.module_key).toBe('phi_deidentification');
  });
});
