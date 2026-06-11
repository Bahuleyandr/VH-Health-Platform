import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const transactionMock = jest.fn(async (callback) => callback({
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
}));
const recordCanonicalClinicalEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
    $transaction: transactionMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const bloodBankService = (await import('../../services/bloodbank/bloodBankService.js')).default;
const {
  listUnits,
  registerUnit,
  assertBedsideVerified,
} = await import('../../services/bloodbank/transfusionSafetyService.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  transactionMock.mockClear();
});

describe('blood-bank tenant authorization', () => {
  it('verifies patient ownership before creating a tenant-scoped blood request', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([{ id: 9, tenant_id: TENANT, patient_uid: PATIENT }]);

    await bloodBankService.createRequest({
      patient_uid: PATIENT,
      blood_group: 'A+',
      component: 'prbc',
      units: 1,
      clinical_indication: 'Symptomatic anaemia',
      ordered_by: ACTOR,
    }, { tenantId: TENANT });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('uid = $1::uuid');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, TENANT]);

    const [insertSql, ...insertParams] = queryRawUnsafeMock.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO blood_requests');
    expect(insertSql).toContain('(tenant_id, patient_uid');
    expect(insertParams.slice(0, 2)).toEqual([TENANT, PATIENT]);
  });

  it('rejects request creation when the patient is outside the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(bloodBankService.createRequest({
      patient_uid: PATIENT,
      blood_group: 'A+',
      component: 'prbc',
      units: 1,
      clinical_indication: 'Symptomatic anaemia',
      ordered_by: ACTOR,
    }, { tenantId: TENANT })).rejects.toMatchObject({
      statusCode: 404,
      code: 'BLOOD_BANK_PATIENT_NOT_FOUND',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('scopes legacy crossmatch, issue, inventory, and pending reads by tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 9, status: 'requested' }])
      .mockResolvedValueOnce([{ id: 9, tenant_id: TENANT, status: 'cross_matched' }])
      .mockResolvedValueOnce([{ id: 9, status: 'cross_matched', cross_match_status: 'compatible' }])
      .mockResolvedValueOnce([{ id: 9, tenant_id: TENANT, status: 'issued' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]);

    await bloodBankService.crossMatch(9, {
      cross_match_status: 'compatible',
      cross_matched_by: ACTOR,
    }, { tenantId: TENANT });
    await bloodBankService.issueBlood(9, { issued_by: ACTOR }, { tenantId: TENANT });
    await bloodBankService.getInventory({ tenantId: TENANT });
    await bloodBankService.getPendingRequests({ blood_group: 'A+' }, { tenantId: TENANT });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('WHERE id = $1 AND tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('WHERE id = $3 AND tenant_id = $4::uuid');
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('WHERE id = $1 AND tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[3][0]).toContain('WHERE id = $2 AND tenant_id = $3::uuid');
    expect(queryRawUnsafeMock.mock.calls[4][0]).toContain('WHERE tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[5][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[6][0]).toContain('tenant_id = $1::uuid');
  });

  it('requires tenant context for blood unit stock and bedside verification gates', async () => {
    await expect(listUnits()).rejects.toMatchObject({ code: 'TRANSFUSION_TENANT_REQUIRED' });
    await expect(assertBedsideVerified(9)).rejects.toMatchObject({ code: 'TRANSFUSION_TENANT_REQUIRED' });

    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ crossmatched_unit_id: null }]);

    await registerUnit({
      unitNumber: 'BB-001',
      bloodGroup: 'O-',
      expiryDate: '2027-01-01',
    }, { tenantId: TENANT, actorUid: ACTOR });
    await assertBedsideVerified(9, {
      tenantId: TENANT,
      legacyOverrideReason: 'documented legacy unit-less override',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('INSERT INTO blood_units');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('(tenant_id, unit_number');
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('transfusion_verifications');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('blood_requests');
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('tenant_id = $2::uuid');
  });
});
