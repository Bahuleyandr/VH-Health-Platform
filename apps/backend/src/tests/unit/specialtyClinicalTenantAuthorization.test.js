import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '22222222-2222-4222-8222-222222222222';
const STAFF = '33333333-3333-4333-8333-333333333333';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const transactionMock = jest.fn(async (callback) => callback({
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
}));

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  $transaction: transactionMock,
};
const __txMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__txMock),
  setTenant: async (_tenantId, fn) => fn(__txMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__txMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockTxRevision = 0;
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  // Monotonic like pg_current_xact_id() so revision keys stay unique per write.
  currentCanonicalTransactionRevision: jest.fn(async () => String(++mockTxRevision)),
  // maternityService (BE-H2/BE-M2 hardening, 2026-08-09) now also imports the
  // audit recorder plus canonicalOperationalBridgeService, whose module graph
  // pulls these named exports from the mocked module — provide them so the
  // import link resolves (the tenant-authz assertions never exercise them).
  recordClinicalAuditEvent: jest.fn(),
  completeWorkflowSla: jest.fn(),
  startWorkflowSla: jest.fn(),
  isSchemaMissing: jest.fn(() => false),
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  hasActivePrivilege: jest.fn(),
  // maternityService imports these for its OBGyn labour-ward gate; keep the gate
  // inert here (isGateEnabled → false) so these tenant-authz tests are unchanged.
  assertPrivilegeForGate: jest.fn(async () => ({ enforced: false, allowed: true })),
  isGateEnabled: jest.fn(() => false),
  privilegeKey: jest.fn((value) => String(value).trim().toLowerCase()),
}));

jest.unstable_mockModule('../../utils/clinical/vitalSignMonitor.js', () => ({
  checkVitalAnomalies: jest.fn(),
}));

const dental = await import('../../services/clinical/dentalService.js');
const ophthalmology = await import('../../services/clinical/ophthalmologyService.js');
const oncology = await import('../../services/oncology/chemoService.js');
const maternity = await import('../../services/maternity/maternityService.js');
const dialysis = await import('../../services/clinical/dialysisService.js');
const deathCert = await import('../../services/clinical/deathCertificationService.js');
const pcpndt = await import('../../services/compliance/pcpndtService.js');

beforeEach(() => {
  jest.clearAllMocks();
  transactionMock.mockImplementation(async (callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
  }));
});

describe('specialty clinical tenant/object authorization', () => {
  it('dental chart access verifies the patient and reads rows inside the request tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await dental.getChart(PATIENT, { tenantId: TENANT });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('tenant_id = $1::uuid');
    expect(patientParams).toEqual([TENANT, PATIENT]);

    const [findingsSql, ...findingParams] = queryRawUnsafeMock.mock.calls[1];
    expect(findingsSql).toContain('tenant_id = $1::uuid');
    expect(findingParams).toEqual([TENANT, PATIENT]);
  });

  it('ophthalmology refractions cannot attach to an exam outside the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(ophthalmology.addRefraction(44, {
      tenantId: OTHER_TENANT,
      eye: 'od',
      sphere: -1,
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'OPHTHO_EXAM_NOT_FOUND',
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM ophthalmic_exams');
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(params).toEqual([44, OTHER_TENANT]);
  });

  it('oncology treatment plan detail resolves the plan through tenant-bound plan/protocol joins', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(oncology.getPlanDetail(12, { tenantId: OTHER_TENANT }))
      .rejects.toMatchObject({ statusCode: 404, code: 'CHEMO_PLAN_NOT_FOUND' });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('p.tenant_id = $2::uuid');
    expect(sql).toContain('pr.tenant_id = $2::uuid');
    expect(params).toEqual([12, OTHER_TENANT]);
  });

  it('maternity prior-order timeline resolves pregnancy in tenant before querying child records', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        patient_uid: PATIENT,
        lmp_date: '2026-01-01',
        created_at: '2026-01-01T00:00:00Z',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await maternity.listPriorOrdersForPregnancy({ tenantId: TENANT, pregnancy_id: 7 });

    const [pregnancySql, ...pregnancyParams] = queryRawUnsafeMock.mock.calls[0];
    expect(pregnancySql).toContain('tenant_id = $1::uuid');
    expect(pregnancyParams).toEqual([TENANT, 7]);

    const [investigationSql, ...investigationParams] = queryRawUnsafeMock.mock.calls[1];
    expect(investigationSql).toContain('i.tenant_id = $2::uuid');
    expect(investigationParams).toEqual([PATIENT, TENANT, '2026-01-01']);

    const [prescriptionSql, ...prescriptionParams] = queryRawUnsafeMock.mock.calls[2];
    expect(prescriptionSql).toContain('tenant_id = $2::uuid');
    expect(prescriptionParams).toEqual([PATIENT, TENANT, '2026-01-01']);
  });

  it('dialysis serology resolves the dialysis patient inside the tenant before child writes', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(dialysis.recordSerology({
      tenantId: OTHER_TENANT,
      dialysis_patient_id: 9,
      reported_by: STAFF,
    })).rejects.toMatchObject({ statusCode: 404 });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM dialysis_patients');
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(params).toEqual([9, OTHER_TENANT]);
  });

  it('death certification rejects an admission from another patient before inserting the death record', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([{ id: 5, patient_uid: OTHER_PATIENT }]);

    await expect(deathCert.createDeathRecord({
      tenantId: TENANT,
      patient_uid: PATIENT,
      admission_id: 5,
      date_of_death: '2026-06-01',
      time_of_death: '10:00',
      cause_part_1a: 'Cardiac arrest',
    })).rejects.toMatchObject({ statusCode: 403 });

    const [admissionSql, ...admissionParams] = queryRawUnsafeMock.mock.calls[1];
    expect(admissionSql).toContain('tenant_id = $1::uuid');
    expect(admissionParams).toEqual([TENANT, 5]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('PCPNDT Form F rejects a patient reference outside the tenant before resolving machine or sonologist IDs', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(pcpndt.createFormF({
      tenantId: OTHER_TENANT,
      patient_uid: PATIENT,
      patient_name: 'Jane Patient',
      patient_age: 29,
      husband_or_father_name: 'Family',
      full_address: 'Address',
      indication: 'Routine scan',
      machine_id: 1,
      sonologist_id: 2,
      consent_taken: true,
    })).rejects.toMatchObject({ statusCode: 404 });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM users');
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(params).toEqual([OTHER_TENANT, PATIENT]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });
});
