import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();
const getClinicalAiModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetyMock,
}));

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getClinicalAiModuleMock,
}));

jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: generateClinicalTextMock,
}));

jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: runOutputDefensesMock,
}));

const {
  reviewPolypharmacy,
} = await import('../../services/ai/polypharmacyAiService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function moduleRow(overrides = {}) {
  return {
    module_key: 'polypharmacy_ai_review',
    display_name: 'Prescription Safety Assistant',
    enabled: true,
    settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  validatePrescriptionSafetyMock.mockReset();
  getClinicalAiModuleMock.mockReset();
  generateClinicalTextMock.mockReset();
  runOutputDefensesMock.mockReset();

  getClinicalAiModuleMock.mockResolvedValue(moduleRow());
  validatePrescriptionSafetyMock.mockResolvedValue({ blockers: [], warnings: [] });
  generateClinicalTextMock.mockResolvedValue({
    text: JSON.stringify({ findings: [] }),
    usedAi: true,
    provider: 'mock',
    model: 'mock-model',
  });
  runOutputDefensesMock.mockReturnValue([]);
  queryRawUnsafeMock.mockResolvedValue([{ id: 101 }]);
});

describe('reviewPolypharmacy module governance', () => {
  it('blocks disabled AI review before rules, AI, or persistence work runs', async () => {
    getClinicalAiModuleMock.mockResolvedValueOnce(moduleRow({ enabled: false }));

    await expect(reviewPolypharmacy({
      patientId: 55,
      medications: [{ name: 'Aspirin', dose: '75 mg' }],
      req: { tenantId: TENANT_ID },
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Clinical AI module is disabled: Prescription Safety Assistant',
    });

    expect(validatePrescriptionSafetyMock).not.toHaveBeenCalled();
    expect(generateClinicalTextMock).not.toHaveBeenCalled();
    expect(runOutputDefensesMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('runs rule review and advisory AI when the module is enabled', async () => {
    const result = await reviewPolypharmacy({
      patientId: 55,
      patientUid: '22222222-2222-4222-8222-222222222222',
      medications: [{ name: 'Aspirin', dose: '75 mg' }],
      req: { tenantId: TENANT_ID, tenant: { region: 'IN' } },
    });

    expect(getClinicalAiModuleMock).toHaveBeenCalledWith('polypharmacy_ai_review', { tenantId: TENANT_ID });
    expect(validatePrescriptionSafetyMock).toHaveBeenCalledWith(55, [{ name: 'Aspirin', dose: '75 mg' }]);
    expect(generateClinicalTextMock).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'polypharmacy_ai_review',
      tenantRegion: 'IN',
    }));
    expect(queryRawUnsafeMock).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      review_id: 101,
      module_key: 'polypharmacy_ai_review',
      used_ai: true,
    }));
  });
});
