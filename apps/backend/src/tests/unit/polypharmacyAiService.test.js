import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();
const getClinicalAiModuleMock = jest.fn();
const generateClinicalTextMock = jest.fn();
const runOutputDefensesMock = jest.fn();
const raiseCdsAlertMock = jest.fn();

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

jest.unstable_mockModule('../../services/cds/cdsAlertSurfacing.js', () => ({
  raiseCdsAlert: raiseCdsAlertMock,
  default: { raiseCdsAlert: raiseCdsAlertMock },
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
  raiseCdsAlertMock.mockReset();
  raiseCdsAlertMock.mockResolvedValue({ raised: true });

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
    expect(validatePrescriptionSafetyMock).toHaveBeenCalledWith(
      55,
      [{ name: 'Aspirin', dose: '75 mg' }],
      { tenantId: TENANT_ID },
    );
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

describe('reviewPolypharmacy CDS surfacing', () => {
  it('raises a critical POLYPHARMACY_RISK cds alert when a rule blocker fires', async () => {
    validatePrescriptionSafetyMock.mockResolvedValueOnce({ blockers: [{ code: 'DUP', message: 'Duplicate anticoagulant' }], warnings: [] });
    await reviewPolypharmacy({
      patientId: 55,
      patientUid: '22222222-2222-4222-8222-222222222222',
      admissionId: 7,
      medications: [{ name: 'Warfarin' }, { name: 'Apixaban' }],
      req: { tenantId: TENANT_ID },
    });
    expect(raiseCdsAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'POLYPHARMACY_RISK',
      severity: 'critical',
      patientUid: '22222222-2222-4222-8222-222222222222',
      encounterId: 7,
    }));
  });

  it('does NOT raise a cds alert for a low-severity review (no dashboard noise)', async () => {
    await reviewPolypharmacy({
      patientId: 55,
      patientUid: '22222222-2222-4222-8222-222222222222',
      medications: [{ name: 'Paracetamol' }],
      req: { tenantId: TENANT_ID },
    });
    expect(raiseCdsAlertMock).not.toHaveBeenCalled();
  });

  it('does NOT raise when there is no patientUid to key the alert on', async () => {
    validatePrescriptionSafetyMock.mockResolvedValueOnce({ blockers: [{ code: 'X', message: 'bad' }], warnings: [] });
    await reviewPolypharmacy({
      patientId: 55,
      medications: [{ name: 'Warfarin' }],
      req: { tenantId: TENANT_ID },
    });
    expect(raiseCdsAlertMock).not.toHaveBeenCalled();
  });
});
