import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const service = await import('../../services/paediatric/paediatricImmunisationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('paediatric immunisation tenant authorization', () => {
  it('seeds schedules only after resolving the patient in the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT, birthday: '2025-01-01' }]) // assertPatientInTenant
      .mockResolvedValueOnce([{ id: 9, code: 'BCG', dose_number: 1, recommended_age_days: 0 }]) // catalogue
      .mockResolvedValueOnce([{ id: 5 }]) // O1 resolver: exactly one maternity newborn
      .mockResolvedValueOnce([{ vaccine_catalogue_id: 9, id: 77 }]) // O1 resolver: its newborn doses
      .mockResolvedValueOnce([{ was_insert: true }]); // insert

    await service.seedScheduleForPatient({
      patientUid: PATIENT,
      dob: '2025-01-01',
      tenantId: TENANT,
    });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, TENANT]);

    const [catalogueSql, ...catalogueParams] = queryRawUnsafeMock.mock.calls[1];
    expect(catalogueSql).toContain('FROM vaccine_catalogue');
    expect(catalogueSql).toContain('tenant_id = $1::uuid');
    expect(catalogueParams).toEqual([TENANT]);

    // O1: the newborn-identity lookup and its dose lookup are tenant-scoped —
    // an exact link can never be resolved from another tenant's rows.
    const [newbornSql, ...newbornParams] = queryRawUnsafeMock.mock.calls[2];
    expect(newbornSql).toContain('FROM maternity_newborns');
    expect(newbornSql).toContain('tenant_id = $1::uuid');
    expect(newbornSql).toContain('newborn_patient_uid = $2::uuid');
    expect(newbornParams).toEqual([TENANT, PATIENT]);

    const [doseSql, ...doseParams] = queryRawUnsafeMock.mock.calls[3];
    expect(doseSql).toContain('FROM newborn_immunisations');
    expect(doseSql).toContain('tenant_id = $1::uuid');
    expect(doseParams).toEqual([TENANT, 5]);

    const [insertSql, ...insertParams] = queryRawUnsafeMock.mock.calls[4];
    expect(insertSql).toContain('WHERE patient_immunisations.tenant_id = EXCLUDED.tenant_id');
    expect(insertSql).toContain('newborn_immunisation_id');
    expect(insertParams[0]).toBe(PATIENT);
    expect(insertParams[3]).toBe(77); // exact newborn-dose link wired into the insert
    expect(insertParams[4]).toBe(TENANT);
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
