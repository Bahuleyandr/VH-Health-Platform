import { jest } from '@jest/globals';

const findUniqueMock = jest.fn();
const updateMock = jest.fn();
const auditCreateMock = jest.fn();
const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    admissions: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
    audit_logs: {
      create: auditCreateMock,
    },
    $queryRawUnsafe: queryUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
jest.unstable_mockModule('../../services/emr/dischargeSummaryGenerator.js', () => ({
  generateDischargeSummary: jest.fn(),
}));
jest.unstable_mockModule('../../services/ipd/ipdSupportService.js', () => ({
  issueDefaultAttendantPasses: jest.fn(),
  expireAttendantPassesForAdmission: jest.fn(),
  relocateActiveAttendantPasses: jest.fn(),
  createWardIndentForClinicalMedicationOrder: jest.fn(),
}));
jest.unstable_mockModule('../../services/insurance/claimsService.js', () => ({
  createClaim: jest.fn(),
  createPreauth: jest.fn(),
}));

const admissionService = (await import('../../services/emr/admissionService.js')).default;

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PHARMACY = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-05-23T12:00:00.000Z'));
  findUniqueMock.mockReset();
  updateMock.mockReset();
  auditCreateMock.mockReset();
  queryUnsafeMock.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('admissionService.markDischargeDrugsDispensed evidence gate', () => {
  it('rejects loose dispense stamping without pharmacy or med-rec evidence', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 42,
      patient_uid: PATIENT,
      status: 'admitted',
      discharge_initiated_at: new Date('2026-05-23T11:00:00.000Z'),
      discharge_drugs_dispensed_at: null,
    });
    queryUnsafeMock.mockResolvedValueOnce([{ has_evidence: false }]);

    await expect(admissionService.markDischargeDrugsDispensed(42, PHARMACY))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'DISCHARGE_DRUG_EVIDENCE_REQUIRED',
      });

    expect(updateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it('stamps dispense when linked evidence exists', async () => {
    const stamped = {
      id: 42,
      patient_uid: PATIENT,
      discharge_drugs_dispensed_at: new Date('2026-05-23T12:00:00.000Z'),
    };
    findUniqueMock.mockResolvedValueOnce({
      id: 42,
      patient_uid: PATIENT,
      status: 'admitted',
      discharge_initiated_at: new Date('2026-05-23T11:00:00.000Z'),
      discharge_drugs_dispensed_at: null,
    });
    queryUnsafeMock.mockResolvedValueOnce([{ has_evidence: true }]);
    updateMock.mockResolvedValueOnce(stamped);
    auditCreateMock.mockResolvedValueOnce({});

    const result = await admissionService.markDischargeDrugsDispensed(42, PHARMACY);

    expect(result).toBe(stamped);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/pharmacy_orders/);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42 },
      data: expect.objectContaining({
        discharge_drugs_dispensed_at: expect.any(Date),
      }),
    }));
  });
});
