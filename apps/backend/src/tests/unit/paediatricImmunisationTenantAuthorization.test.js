import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

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

let mockTxRevision = 0;
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  // Monotonic like pg_current_xact_id() so revision keys stay unique per write.
  currentCanonicalTransactionRevision: jest.fn(async () => String(++mockTxRevision)),
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
  recordCanonicalClinicalEventMock.mockReset();
  recordCanonicalClinicalEventMock.mockResolvedValue({ timeline: {}, audit: {} });
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
        inserted_rows: [{
          id: 12,
          vaccine_catalogue_id: 9,
          due_date: '2025-02-12',
          newborn_immunisation_id: 77,
        }],
      }]); // atomic exact-resolution + schedule upsert

    await service.seedScheduleForPatient({
      patientUid: PATIENT,
      dob: '2025-01-01',
      tenantId: TENANT,
      actorUid: STAFF,
      actorRole: 'NURSING_STAFF',
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
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientUid: PATIENT,
        eventType: 'immunisation.schedule_seeded',
        actorUid: STAFF,
        actorRole: 'NURSING_STAFF',
        visibleToPatient: false,
      }),
      expect.objectContaining({ db: __prismaDefaultMock, strict: true }),
    );
  });

  it('does not seed or list immunisations for a patient outside the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(service.listForPatient(PATIENT, { tenantId: OTHER_TENANT }))
      .rejects.toMatchObject({ statusCode: 404, code: 'PAEDIATRIC_PATIENT_NOT_FOUND' });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, OTHER_TENANT]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('lists patient immunisations only inside the caller tenant without seeding on GET', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT, birthday: '2025-01-01' }])
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
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO patient_immunisations'))).toBe(false);
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('lists due immunisations only inside the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT, birthday: '2025-01-01' }])
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
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 12, newborn_immunisation_id: null }])
      // Effective-state no-op guard: a genuine change proceeds to the UPDATE.
      .mockResolvedValueOnce([{
        id: 12,
        patient_uid: PATIENT,
        status: 'scheduled',
        given_at: null,
        vaccine_catalogue_id: 9,
        effective_state_unchanged: false,
      }])
      .mockResolvedValueOnce([{
        id: 12,
        patient_uid: PATIENT,
        status: 'given',
        given_at: '2026-06-11T00:00:00Z',
        given_by: STAFF,
        given_by_name: 'Nurse',
        batch_number: 'BATCH-1',
        manufacturer: 'Maker',
        site_of_injection: 'left_thigh',
        vaccine_catalogue_id: 9,
        updated_at: '2026-06-11T00:00:00Z',
      }]);

    await service.recordDose({
      tenantId: TENANT,
      immunisationId: 12,
      status: 'given',
      givenBy: STAFF,
      actorRole: 'NURSING_STAFF',
      batchNumber: 'BATCH-1',
      manufacturer: 'Maker',
      siteOfInjection: 'left_thigh',
    });

    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock.mock.calls[0][0]).toBe(TENANT);
    const [lookupSql, ...lookupParams] = queryRawUnsafeMock.mock.calls[0];
    expect(lookupSql).toContain('FROM patient_immunisations');
    expect(lookupSql).toContain('tenant_id = $2::uuid');
    expect(lookupParams).toEqual([12, TENANT]);

    const [guardSql, ...guardParams] = queryRawUnsafeMock.mock.calls[1];
    expect(guardSql).toContain('effective_state_unchanged');
    expect(guardSql).toContain('p.tenant_id = $11::uuid');
    expect(guardSql).toContain('p.newborn_immunisation_id IS NULL');
    expect(guardSql).toContain('FOR UPDATE');
    expect(guardParams[0]).toBe(12);
    expect(guardParams[2]).toBeInstanceOf(Date);
    expect(guardParams[10]).toBe(TENANT);

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[2];
    expect(sql).toContain('UPDATE patient_immunisations');
    expect(sql).toContain('AND tenant_id = $11::uuid');
    expect(sql).toContain('AND newborn_immunisation_id IS NULL');
    expect(params[0]).toBe(12);
    expect(params[2]).toBe(guardParams[2]);
    expect(params[10]).toBe(TENANT);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'immunisation.dose_recorded',
        actorUid: STAFF,
        actorRole: 'NURSING_STAFF',
        payload: expect.objectContaining({
          batch_number: 'BATCH-1',
          manufacturer: 'Maker',
          site_of_injection: 'left_thigh',
        }),
      }),
      expect.objectContaining({ db: __prismaDefaultMock, strict: true }),
    );
  });

  it('updates only the authoritative newborn row for an exact current link', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 12, newborn_immunisation_id: 77 }])
      .mockResolvedValueOnce([{
        id: 12,
        patient_uid: PATIENT,
        vaccine_catalogue_id: 9,
        newborn_immunisation_id: 77,
      }])
      .mockResolvedValueOnce([{ id: 77, status: 'scheduled' }])
      .mockResolvedValueOnce([{
        id: 77,
        status: 'given',
        given_at: '2026-06-11T00:00:00Z',
        given_by: STAFF,
        given_by_name: 'Nurse',
        batch_number: 'BATCH-2',
        manufacturer: 'Maker',
        site_of_injection: 'right_thigh',
        updated_at: '2026-06-11T00:00:00Z',
      }]);

    const result = await service.recordDose({
      tenantId: TENANT,
      immunisationId: 12,
      status: 'given',
      givenAt: '2026-06-11T00:00:00Z',
      givenBy: STAFF,
      actorRole: 'NURSING_STAFF',
      batchNumber: 'BATCH-2',
      manufacturer: 'Maker',
      siteOfInjection: 'right_thigh',
    });

    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock.mock.calls.map(([sql]) => sql)).toEqual([
      'LOCK TABLE maternity_newborns IN SHARE MODE',
      'LOCK TABLE newborn_immunisations IN SHARE ROW EXCLUSIVE MODE',
    ]);

    const [lockedPatientSql, ...lockedPatientParams] = queryRawUnsafeMock.mock.calls[1];
    expect(lockedPatientSql).toContain('FROM patient_immunisations');
    expect(lockedPatientSql).toContain('FOR UPDATE');
    expect(lockedPatientParams).toEqual([12, TENANT]);

    const [exactSql, ...exactParams] = queryRawUnsafeMock.mock.calls[2];
    expect(exactSql).toContain('JOIN maternity_newborns');
    expect(exactSql).toContain('JOIN vaccine_catalogue');
    expect(exactSql).toContain('identity_candidate.newborn_patient_uid = $2::uuid');
    expect(exactSql).toContain('dose_candidate.vaccine_catalogue_id = $3::int');
    expect(exactSql).toContain('ni.id = $4::int');
    expect(exactParams).toEqual([TENANT, PATIENT, 9, 77]);

    const [updateSql, ...updateParams] = queryRawUnsafeMock.mock.calls[3];
    expect(updateSql).toContain('UPDATE newborn_immunisations');
    expect(updateSql).not.toContain('UPDATE patient_immunisations');
    expect(updateSql).toContain("AND status = 'scheduled'");
    expect(updateParams[0]).toBe(77);
    expect(updateParams[10]).toBe(TENANT);
    expect(result).toEqual({
      id: 12,
      patient_uid: PATIENT,
      status: 'given',
      given_at: '2026-06-11T00:00:00Z',
      given_by: STAFF,
      vaccine_catalogue_id: 9,
    });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTable: 'newborn_immunisations',
        sourceId: 77,
        actorUid: STAFF,
        payload: expect.objectContaining({
          patient_immunisation_id: 12,
          newborn_immunisation_id: 77,
          batch_number: 'BATCH-2',
        }),
      }),
      expect.objectContaining({ db: __prismaDefaultMock, strict: true }),
    );
  });

  it('fails closed with LINK_CHANGED when the unlinked guard re-read finds the row concurrently linked', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 12, newborn_immunisation_id: null }])
      // Concurrent NULL -> set linkage flip: the FOR UPDATE guard re-read is
      // scoped to newborn_immunisation_id IS NULL, so it now matches zero rows.
      .mockResolvedValueOnce([]);

    await expect(service.recordDose({
      tenantId: TENANT,
      immunisationId: 12,
      status: 'given',
      givenBy: STAFF,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAEDIATRIC_IMMUNISATION_LINK_CHANGED',
    });

    // The zero-row read really was the locked unlinked-branch guard query.
    const [guardSql, ...guardParams] = queryRawUnsafeMock.mock.calls[1];
    expect(guardSql).toContain('effective_state_unchanged');
    expect(guardSql).toContain('p.newborn_immunisation_id IS NULL');
    expect(guardSql).toContain('FOR UPDATE');
    expect(guardParams[0]).toBe(12);
    expect(guardParams[10]).toBe(TENANT);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => /^\s*UPDATE\s/im.test(sql))).toBe(false);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('fails closed with LINK_CHANGED when a linked row is concurrently unlinked before the locked re-read', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 12, newborn_immunisation_id: 77 }])
      // set -> NULL flip under the table locks: the FOR UPDATE re-read of the
      // patient row reports the link gone before the exactness re-proof runs.
      .mockResolvedValueOnce([{
        id: 12,
        patient_uid: PATIENT,
        vaccine_catalogue_id: 9,
        newborn_immunisation_id: null,
      }]);

    await expect(service.recordDose({
      tenantId: TENANT,
      immunisationId: 12,
      status: 'given',
      givenBy: STAFF,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAEDIATRIC_IMMUNISATION_LINK_CHANGED',
    });

    expect(executeRawUnsafeMock.mock.calls.map(([sql]) => sql)).toEqual([
      'LOCK TABLE maternity_newborns IN SHARE MODE',
      'LOCK TABLE newborn_immunisations IN SHARE ROW EXCLUSIVE MODE',
    ]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => /^\s*UPDATE\s/im.test(sql))).toBe(false);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('fails closed without an update when a stored link is no longer exact', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 12, newborn_immunisation_id: 77 }])
      .mockResolvedValueOnce([{
        id: 12,
        patient_uid: PATIENT,
        vaccine_catalogue_id: 9,
        newborn_immunisation_id: 77,
      }])
      .mockResolvedValueOnce([]);

    await expect(service.recordDose({
      tenantId: TENANT,
      immunisationId: 12,
      status: 'given',
      givenBy: STAFF,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAEDIATRIC_IMMUNISATION_LINK_NOT_EXACT',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => /^\s*UPDATE\s/im.test(sql))).toBe(false);
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
