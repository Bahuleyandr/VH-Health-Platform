import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const service = await import('../../services/paediatric/paediatricImmunisationService.js');
const { classifyLinkage } = await import('../../../scripts/immunisation-linkage-report.mjs');

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockResolvedValue(0);
  setTenantTxMock.mockClear();
});

describe('paediatric immunisation tenant authorization', () => {
  it('classifies a current link as exact only when it equals the sole exact candidate', () => {
    expect(classifyLinkage({
      currentLink: 77, newbornCount: 1, doseCount: 1, candidateLink: 77,
    })).toBe('already_linked');
    expect(classifyLinkage({
      currentLink: 77, newbornCount: 1, doseCount: 1, candidateLink: 88,
    })).toBe('stale_or_mismatched_link');
    expect(classifyLinkage({
      currentLink: 77, newbornCount: 0, doseCount: 0, candidateLink: null,
    })).toBe('stale_or_mismatched_link');
    expect(classifyLinkage({
      currentLink: 77, newbornCount: 2, doseCount: 2, candidateLink: null,
    })).toBe('multiple_doses');
    expect(classifyLinkage({
      currentLink: 77, newbornCount: 2, doseCount: 1, candidateLink: 77,
    })).toBe('multiple_newborns');
    expect(classifyLinkage({
      currentLink: 77,
      newbornCount: 0,
      doseCount: 0,
      candidateLink: null,
      catalogueInTenant: false,
    })).toBe('catalogue_tenant_mismatch');
  });

  it('closes the resolution/write race inside one locked tenant transaction', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT, birthday: '2025-01-01' }]) // assertPatientInTenant
      .mockResolvedValueOnce([{
        total: 1, touched: 1, inserted: 1, updated: 0, linked: 1,
      }]); // atomic exact-resolution + schedule upsert

    await service.seedScheduleForPatient({
      patientUid: PATIENT,
      dob: '2025-01-01',
      tenantId: TENANT,
    });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, TENANT]);

    // O1 race closure: candidate sources are locked before one statement both
    // proves exact identity/dose counts and writes every schedule row.
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock.mock.calls[0][0]).toBe(TENANT);
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock.mock.calls[0][0]).toContain(
      'LOCK TABLE maternity_newborns, newborn_immunisations IN SHARE MODE',
    );

    const [insertSql, ...insertParams] = queryRawUnsafeMock.mock.calls[1];
    expect(insertSql).toContain('WITH exact_newborn AS');
    expect(insertSql).toContain('HAVING COUNT(*) = 1');
    expect(insertSql).toContain('FROM newborn_immunisations');
    expect(insertSql).toContain('INSERT INTO patient_immunisations');
    expect(insertSql).toContain('WHERE patient_immunisations.tenant_id = EXCLUDED.tenant_id');
    expect(insertSql).toContain('newborn_immunisation_id');
    expect(insertParams).toEqual([TENANT, PATIENT, '2025-01-01']);
    expect(executeRawUnsafeMock.mock.invocationCallOrder[0])
      .toBeLessThan(queryRawUnsafeMock.mock.invocationCallOrder[1]);
  });

  it('does not seed or list immunisations for a patient outside the tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]);

    await expect(service.listForPatient(PATIENT, { tenantId: OTHER_TENANT }))
      .rejects.toMatchObject({ statusCode: 404, code: 'PAEDIATRIC_PATIENT_NOT_FOUND' });

    const [countSql, ...countParams] = queryRawUnsafeMock.mock.calls[0];
    expect(countSql).toContain('FROM patient_immunisations');
    expect(countSql).toContain('tenant_id = $2::uuid');
    expect(countParams).toEqual([PATIENT, OTHER_TENANT]);

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[1];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, OTHER_TENANT]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('lists patient immunisations only inside the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([]);

    await service.listForPatient(PATIENT, { tenantId: TENANT });

    const [listSql, ...listParams] = queryRawUnsafeMock.mock.calls[1];
    expect(listSql).toContain('vc.tenant_id = pi.tenant_id');
    expect(listSql).toContain('pi.tenant_id = $2::uuid');
    expect(listSql).toContain('linked.newborn_patient_uid = pi.patient_uid');
    expect(listSql).toContain('linked.vaccine_catalogue_id = pi.vaccine_catalogue_id');
    expect(listSql).toContain('linked.newborn_count = 1');
    expect(listSql).toContain('linked.dose_count = 1');
    expect(listSql).not.toContain('pi.newborn_immunisation_id IS NULL');
    expect(listParams).toEqual([PATIENT, TENANT]);
  });

  it('lists due immunisations only inside the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.listDueForPatient(PATIENT, { tenantId: TENANT, asOf: '2026-06-11' });

    const [dueSql, ...dueParams] = queryRawUnsafeMock.mock.calls[2];
    expect(dueSql).toContain('vc.tenant_id = pi.tenant_id');
    expect(dueSql).toContain('pi.tenant_id = $4::uuid');
    expect(dueSql).toContain('linked.newborn_patient_uid = pi.patient_uid');
    expect(dueSql).toContain('linked.vaccine_catalogue_id = pi.vaccine_catalogue_id');
    expect(dueSql).toContain('linked.newborn_count = 1');
    expect(dueSql).toContain('linked.dose_count = 1');
    expect(dueSql).not.toContain('pi.newborn_immunisation_id IS NULL');
    expect(dueParams).toEqual([PATIENT, '2026-06-11', null, TENANT]);
  });

  it('records doses by id and tenant together', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 12,
      patient_uid: PATIENT,
      status: 'given',
      given_at: '2026-06-11T00:00:00Z',
      given_by: STAFF,
      vaccine_catalogue_id: 9,
    }]);

    await service.recordDose({
      tenantId: TENANT,
      immunisationId: 12,
      status: 'given',
      givenBy: STAFF,
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('UPDATE patient_immunisations');
    expect(sql).toContain('AND tenant_id = $11::uuid');
    expect(params[0]).toBe(12);
    expect(params[10]).toBe(TENANT);
  });

  it('returns not found when a dose id belongs to another tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(service.recordDose({
      tenantId: OTHER_TENANT,
      immunisationId: 12,
      status: 'given',
      givenBy: STAFF,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});
