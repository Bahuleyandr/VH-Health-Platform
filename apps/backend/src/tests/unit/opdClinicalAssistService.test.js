import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getClinicalAiModuleMock = jest.fn();
const listClinicalAiModulesMock = jest.fn();
const listClinicalAiTenantModulesMock = jest.fn();
const runExplainerPipelineMock = jest.fn();
const reviewPolypharmacyMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getClinicalAiModuleMock,
  listClinicalAiModules: listClinicalAiModulesMock,
  listClinicalAiTenantModules: listClinicalAiTenantModulesMock,
}));

jest.unstable_mockModule('../../services/ai/patientExplainersService.js', () => ({
  runExplainerPipeline: runExplainerPipelineMock,
}));

jest.unstable_mockModule('../../services/ai/polypharmacyAiService.js', () => ({
  reviewPolypharmacy: reviewPolypharmacyMock,
}));

const {
  OPD_AI_MODULES,
  generateOpDifferentialRedFlags,
  generateOpInvestigationReview,
  generateOpVisitPrep,
  listOpdAiModules,
} = await import('../../services/ai/opdClinicalAssistService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

function moduleRow(moduleKey, overrides = {}) {
  return {
    module_key: moduleKey,
    display_name: moduleKey,
    description: `${moduleKey} description`,
    enabled: true,
    settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  getClinicalAiModuleMock.mockReset();
  listClinicalAiModulesMock.mockReset();
  listClinicalAiTenantModulesMock.mockReset();
  runExplainerPipelineMock.mockReset();
  reviewPolypharmacyMock.mockReset();

  getClinicalAiModuleMock.mockImplementation(async (moduleKey) => moduleRow(moduleKey));
  listClinicalAiModulesMock.mockResolvedValue(OPD_AI_MODULES.map((module) => moduleRow(module.key)));
  listClinicalAiTenantModulesMock.mockResolvedValue(OPD_AI_MODULES.map((module) => moduleRow(module.key)));
});

describe('opdClinicalAssistService module governance', () => {
  it('lists tenant-effective OP AI modules for Staff/Admin controls', async () => {
    listClinicalAiTenantModulesMock.mockResolvedValue(
      OPD_AI_MODULES.map((module) => moduleRow(module.key, {
        enabled: module.key !== 'op_referral_draft',
        settings: { tenant_id: TENANT_ID },
      })),
    );

    const result = await listOpdAiModules({ tenantId: TENANT_ID });

    expect(result.count).toBe(OPD_AI_MODULES.length);
    expect(result.modules.map((module) => module.module_key)).toEqual(
      OPD_AI_MODULES.map((module) => module.key),
    );
    expect(result.modules.find((module) => module.module_key === 'op_referral_draft')).toEqual(
      expect.objectContaining({
        enabled: false,
        settings: { tenant_id: TENANT_ID },
      }),
    );
    expect(listClinicalAiTenantModulesMock).toHaveBeenCalledTimes(1);
    expect(listClinicalAiTenantModulesMock).toHaveBeenCalledWith({ tenantId: TENANT_ID });
    expect(getClinicalAiModuleMock).not.toHaveBeenCalled();
  });

  it('blocks disabled OP visit prep before appointment or chart context is loaded', async () => {
    getClinicalAiModuleMock.mockResolvedValueOnce(moduleRow('op_visit_prep', {
      display_name: 'OP Visit Prep',
      enabled: false,
    }));

    await expect(generateOpVisitPrep({
      tenantId: TENANT_ID,
      appointmentId: 42,
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Clinical AI module is disabled: OP Visit Prep',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(runExplainerPipelineMock).not.toHaveBeenCalled();
  });

  it('blocks disabled investigation review before investigation or patient context is loaded', async () => {
    getClinicalAiModuleMock.mockResolvedValueOnce(moduleRow('op_investigation_review', {
      display_name: 'Investigation Review Aid',
      enabled: false,
    }));

    await expect(generateOpInvestigationReview({
      tenantId: TENANT_ID,
      investigationId: 9,
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Clinical AI module is disabled: Investigation Review Aid',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(runExplainerPipelineMock).not.toHaveBeenCalled();
  });

  it('blocks disabled differential support before patient chart context is loaded', async () => {
    getClinicalAiModuleMock.mockResolvedValueOnce(moduleRow('op_differential_red_flags', {
      display_name: 'Differential / Red Flag Checklist',
      enabled: false,
    }));

    await expect(generateOpDifferentialRedFlags({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      chiefComplaint: 'fever and cough for three days',
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Clinical AI module is disabled: Differential / Red Flag Checklist',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(runExplainerPipelineMock).not.toHaveBeenCalled();
  });
});
