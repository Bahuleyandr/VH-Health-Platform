import { jest } from '@jest/globals';

const findUniqueMock = jest.fn();
const findFirstMock = jest.fn();
const updateMock = jest.fn();
const auditCreateMock = jest.fn();
const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const lockMock = jest.fn();
const consultMock = jest.fn();
const emitDischargeWorkflowOpenedMock = jest.fn();
const emitDischargeDrugsDispensedMock = jest.fn();
const publishInpatientSourceEventTxMock = jest.fn();

const prismaDefaultMock = {
  admissions: {
    findUnique: findUniqueMock,
    findFirst: findFirstMock,
    update: updateMock,
  },
  audit_logs: {
    create: auditCreateMock,
  },
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock,
  $queryRaw: lockMock,
  discharge_consults: { upsert: consultMock },
  $transaction: jest.fn(async (callback) => callback(prismaDefaultMock)),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenant: jest.fn(async (_tenantId, callback) => callback(prismaDefaultMock)),
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(prismaDefaultMock)),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
jest.unstable_mockModule('../../services/emr/dischargeSummaryGenerator.js', () => ({
  generateDischargeSummary: jest.fn(),
  getLatestDischargeSummary: jest.fn(),
  saveDischargeSummary: jest.fn(),
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
jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  safeCanonical: jest.fn(async (_label, task) => task()),
  emitPharmacyOrderEvent: jest.fn(),
  emitHousekeepingRequestRaised: jest.fn(),
  emitHousekeepingRequestStatus: jest.fn(),
  emitBedMarkedReady: jest.fn(),
  emitDischargeDrugsDispensed: emitDischargeDrugsDispensedMock,
  emitDischargeWorkflowOpened: emitDischargeWorkflowOpenedMock,
  emitDischargeWorkItemCompleted: jest.fn(),
  emitFinalDischargeCompleted: jest.fn(),
  emitCriticalLabAlertAcknowledged: jest.fn(),
  emitCdsAlertAcknowledged: jest.fn(),
}));
jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  establishInitialPrimaryPhysicianTx: jest.fn(),
  getInpatientDischargeEvidence: jest.fn(),
  getInpatientDischargeEvidenceTx: jest.fn(),
  publishInpatientSourceEventTx: publishInpatientSourceEventTxMock,
  recordPrimaryPhysicianChangeTx: jest.fn(),
  resolveInpatientPathwayModeTx: jest.fn(),
}));

const admissionService = (await import('../../services/emr/admissionService.js')).default;

const PATIENT = '11111111-1111-4111-8111-111111111111';
const PHARMACY = '22222222-2222-4222-8222-222222222222';
const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-05-23T12:00:00.000Z'));
  findUniqueMock.mockReset();
  findFirstMock.mockReset();
  updateMock.mockReset();
  auditCreateMock.mockReset();
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset().mockResolvedValue(0);
  lockMock.mockReset();
  consultMock.mockReset();
  emitDischargeWorkflowOpenedMock.mockReset().mockResolvedValue({});
  emitDischargeDrugsDispensedMock.mockReset().mockResolvedValue({});
  publishInpatientSourceEventTxMock.mockReset().mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('admissionService.markDischargeDrugsDispensed evidence gate', () => {
  it('uses tenant-scoped admission lookup before stamping dispense', async () => {
    findFirstMock.mockResolvedValueOnce(null);

    await expect(admissionService.markDischargeDrugsDispensed(42, PHARMACY, { tenantId: TENANT }))
      .rejects.toMatchObject({
        statusCode: 404,
      });

    expect(findFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42, tenant_id: TENANT },
    }));
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

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
      tenant_id: TENANT,
      patient_uid: PATIENT,
      discharge_drugs_dispensed_at: new Date('2026-05-23T12:00:00.000Z'),
    };
    findFirstMock.mockResolvedValueOnce({
      id: 42,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'admitted',
      discharge_initiated_at: new Date('2026-05-23T11:00:00.000Z'),
      discharge_drugs_dispensed_at: null,
    });
    queryUnsafeMock.mockResolvedValueOnce([{ has_evidence: true }])
      .mockResolvedValueOnce([{ recorded_at_epoch_ms: BigInt(stamped.discharge_drugs_dispensed_at.getTime()) }]);
    updateMock.mockResolvedValueOnce(stamped);
    auditCreateMock.mockResolvedValueOnce({});

    const result = await admissionService.markDischargeDrugsDispensed(42, PHARMACY, {
      tenantId: TENANT,
      actorRole: 'PHARMACY_STAFF',
    });

    expect(result).toBe(stamped);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/pharmacy_orders/);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42 },
      data: expect.objectContaining({
        discharge_drugs_dispensed_at: expect.any(Date),
      }),
    }));
    expect(emitDischargeDrugsDispensedMock).toHaveBeenCalledWith(expect.objectContaining({
      db: prismaDefaultMock,
      admission: stamped,
      actorUid: PHARMACY,
      actorRole: 'PHARMACY_STAFF',
    }));
    expect(publishInpatientSourceEventTxMock).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaDefaultMock,
      tenantId: TENANT,
      eventType: 'discharge.drugs_dispensed',
      admission: stamped,
    }));
  });
});

describe('discharge database-clock binding', () => {
  const recordedAt = new Date('2026-05-23T12:00:00.123Z');
  const admission = { id: 42, tenant_id: TENANT, patient_uid: PATIENT, status: 'admitted' };

  it.each([-86_400_000, 86_400_000])('opens the cascade using the database instant with %i ms host skew', async (skew) => {
    jest.setSystemTime(new Date(recordedAt.getTime() + skew));
    lockMock.mockResolvedValue([admission]);
    queryUnsafeMock.mockImplementation(async (sql) => sql.includes('clock_timestamp()')
      ? [{ recorded_at_epoch_ms: BigInt(recordedAt.getTime()) }] : []);
    updateMock.mockImplementation(async ({ data }) => ({ ...admission, ...data }));
    consultMock.mockImplementation(async ({ create }) => ({ id: 9, ...create }));

    const result = await admissionService.markForDischarge(42, PHARMACY, 'DOCTOR', { tenantId: TENANT });

    expect(result.admission.discharge_initiated_at).toEqual(recordedAt);
    expect(executeUnsafeMock).toHaveBeenCalledWith("SET LOCAL TIME ZONE 'UTC'");
    expect(executeUnsafeMock.mock.invocationCallOrder[0]).toBeLessThan(queryUnsafeMock.mock.invocationCallOrder[1]);
    expect(updateMock.mock.calls[0][0].data).toEqual({
      discharge_initiated_at: recordedAt, billing_closed_at: recordedAt, updated_at: recordedAt,
    });
    expect(consultMock.mock.calls.length).toBeGreaterThan(0);
    for (const [{ create }] of consultMock.mock.calls) expect(create.requested_at).toEqual(recordedAt);
    expect(auditCreateMock.mock.calls[0][0].data.metadata.billing_closed_at).toBe(recordedAt.toISOString());
    expect(emitDischargeWorkflowOpenedMock).toHaveBeenCalledWith(expect.objectContaining({
      db: prismaDefaultMock, admission: result.admission, occurredAt: recordedAt,
    }));
    expect(publishInpatientSourceEventTxMock).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaDefaultMock,
      payload: expect.objectContaining({ discharge_initiated_at: recordedAt.toISOString() }),
    }));
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(queryUnsafeMock.mock.invocationCallOrder[0]);
    expect(queryUnsafeMock.mock.invocationCallOrder[1]).toBeLessThan(updateMock.mock.invocationCallOrder[0]);
  });

  it.each([-86_400_000, 86_400_000])('stamps the evidence-backed T3 with %i ms host skew', async (skew) => {
    jest.setSystemTime(new Date(recordedAt.getTime() + skew));
    findFirstMock.mockResolvedValue({ ...admission, discharge_initiated_at: new Date(recordedAt.getTime() - 1000) });
    queryUnsafeMock.mockResolvedValueOnce([{ has_evidence: true }])
      .mockResolvedValueOnce([{ recorded_at_epoch_ms: BigInt(recordedAt.getTime()) }]);
    updateMock.mockImplementation(async ({ data }) => ({ ...admission, ...data }));
    const result = await admissionService.markDischargeDrugsDispensed(42, PHARMACY, { tenantId: TENANT });
    expect(result.discharge_drugs_dispensed_at).toEqual(recordedAt);
    expect(executeUnsafeMock).toHaveBeenCalledWith("SET LOCAL TIME ZONE 'UTC'");
    expect(executeUnsafeMock.mock.invocationCallOrder[0]).toBeLessThan(queryUnsafeMock.mock.invocationCallOrder[1]);
    expect(updateMock.mock.calls[0][0].data).toEqual({ discharge_drugs_dispensed_at: recordedAt, updated_at: recordedAt });
    expect(auditCreateMock.mock.calls[0][0].data.metadata.dispensed_at).toBe(recordedAt.toISOString());
    expect(emitDischargeDrugsDispensedMock).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: recordedAt, db: prismaDefaultMock }));
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('po.dispensed_at >= $3::timestamptz');
    expect(queryUnsafeMock.mock.calls[1]).toEqual(['SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS recorded_at_epoch_ms']);
  });

  it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ recorded_at_epoch_ms: 'invalid' }] }])('refuses an unusable database clock without writing: $rows', async ({ rows }) => {
    lockMock.mockResolvedValue([admission]);
    queryUnsafeMock.mockImplementation(async (sql) => sql.includes('clock_timestamp()') ? rows : []);
    await expect(admissionService.markForDischarge(42, PHARMACY, 'DOCTOR', { tenantId: TENANT }))
      .rejects.toMatchObject({ code: 'DISCHARGE_DB_CLOCK_UNAVAILABLE' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(consultMock).not.toHaveBeenCalled();
    expect(emitDischargeWorkflowOpenedMock).not.toHaveBeenCalled();
  });

  it('propagates a database clock failure without stamping T3 or emitting evidence', async () => {
    findFirstMock.mockResolvedValue({ ...admission, discharge_initiated_at: recordedAt });
    const failure = new Error('synthetic database clock failure');
    queryUnsafeMock.mockResolvedValueOnce([{ has_evidence: true }]).mockRejectedValueOnce(failure);
    await expect(admissionService.markDischargeDrugsDispensed(42, PHARMACY, { tenantId: TENANT })).rejects.toBe(failure);
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
    expect(emitDischargeDrugsDispensedMock).not.toHaveBeenCalled();
  });
});
