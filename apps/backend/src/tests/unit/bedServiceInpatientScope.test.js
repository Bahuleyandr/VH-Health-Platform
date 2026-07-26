import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const resolveInpatientLocationScopeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/emr/inpatientScopeService.js', () => ({
  ACTIVE_ADMISSION_STATUSES: ['admitted', 'transferred'],
  FULL_INPATIENT_SCOPE_ROLES: new Set(['ADMIN', 'SUPER_ADMIN']),
  MINIMIZED_INPATIENT_PAYLOAD_ROLES: new Set(['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE']),
  applyInpatientAdmissionScope: (baseWhere) => baseWhere,
  resolveInpatientAdmissionScope: jest.fn(async () => ({
    allAdmissions: true,
    admissionWhere: {},
  })),
  resolveInpatientLocationScope: resolveInpatientLocationScopeMock,
}));

const bedService = (await import('../../services/bed/bedService.js')).default;

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  resolveInpatientLocationScopeMock.mockReset();
});

describe('bedService inpatient location scoping', () => {
  it('filters bed board rows to the actor roster floor', async () => {
    resolveInpatientLocationScopeMock.mockResolvedValueOnce({
      allLocations: false,
      wardIds: [],
      wardNames: [],
      bedIds: [],
      floors: [1],
      scope: { type: 'ward_nursing', source: 'current_published_nursing_roster' },
    });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 91, bed_number: 'A-1', patient_full_name: 'Scoped Patient' }]);

    const result = await bedService.getBedsByWard(12, {}, {
      actor: { uid: '10000000-0000-4000-8000-000000000001', id: 12, role: 'NURSING_STAFF' },
      tenantId: TENANT,
    });

    const [sql, housekeepingStatuses, tenantParam, wardParam, floorParam] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('b.tenant_id = $2::uuid');
    expect(sql).toContain('b.ward_id = $3');
    expect(sql).toContain('COALESCE(b.floor, w.floor) = ANY($4::int[])');
    expect(housekeepingStatuses).toEqual(expect.arrayContaining(['open', 'in_progress']));
    expect(tenantParam).toBe(TENANT);
    expect(wardParam).toBe(12);
    expect(floorParam).toEqual([1]);
    expect(result.beds).toHaveLength(1);
    expect(result.scope.type).toBe('ward_nursing');
  });

  it('minimizes patient identifiers for housekeeping bed board rows', async () => {
    resolveInpatientLocationScopeMock.mockResolvedValueOnce({
      allLocations: false,
      wardIds: [3],
      wardNames: ['Ward 3'],
      bedIds: [44],
      floors: [2],
      scope: { type: 'housekeeping', source: 'current_published_housekeeping_roster' },
    });
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 44,
      bed_number: 'HK-1',
      status: 'occupied',
      patient_id: 18,
      patient_uid: '20000000-0000-4000-8000-000000000002',
      patient_name: 'Legacy Name',
      patient_full_name: 'Housekeeping Hidden',
      patient_phone: '9999999999',
      patient_hospital_number: 'VH-000018',
      chief_complaint: 'Fever',
      attending_doctor_name: 'Doctor Visible',
      housekeeping_request_status: 'open',
    }]);

    const result = await bedService.getBedsByWard(3, {}, {
      actor: { uid: '30000000-0000-4000-8000-000000000003', id: 20, role: 'HOUSEKEEPING_STAFF' },
      tenantId: TENANT,
    });

    expect(result.beds[0]).toEqual(expect.objectContaining({
      id: 44,
      bed_number: 'HK-1',
      status: 'occupied',
      patient_id: null,
      patient_uid: null,
      patient_name: null,
      patient_full_name: null,
      patient_phone: null,
      patient_hospital_number: null,
      chief_complaint: null,
      attending_doctor_name: null,
      housekeeping_request_status: 'open',
    }));
  });

  it('returns only scoped ward counts from the ward list', async () => {
    resolveInpatientLocationScopeMock.mockResolvedValueOnce({
      allLocations: false,
      wardIds: [5],
      wardNames: ['Fifth Ward'],
      bedIds: [],
      floors: [],
      scope: { type: 'ward_nursing', source: 'current_published_nursing_roster' },
    });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, name: 'Fifth Ward', bed_count: 6, occupied_count: 4 }]);

    const result = await bedService.listWards({
      actor: { role: 'NURSING_STAFF' },
      tenantId: TENANT,
    });

    const [sql, tenantParam, wardIdsParam, wardNamesParam] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('WITH visible_beds AS');
    expect(sql).toContain('b.tenant_id = $1::uuid');
    expect(sql).toContain('b.ward_id = ANY($2::int[])');
    expect(sql).toContain("LOWER(COALESCE(b.ward_name, w.name, '')) = ANY($3::text[])");
    expect(tenantParam).toBe(TENANT);
    expect(wardIdsParam).toEqual([5]);
    expect(wardNamesParam).toEqual(['fifth ward']);
    expect(result.wards[0].occupied_count).toBe(4);
  });
});

describe('bedService generic update occupancy boundary', () => {
  it('rejects direct patient/admission occupancy writes before querying', async () => {
    await expect(
      bedService.updateBed(44, {
        status: 'occupied',
        patient_uid: '20000000-0000-4000-8000-000000000002',
        admission_id: 71,
      }, { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'BED_OCCUPANCY_REQUIRES_ADMISSION' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('uses an exact tenant predicate for an allowed bed-master update', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 44,
        status: 'available',
        patient_id: null,
        patient_uid: null,
        patient_name: null,
        admission_id: null,
      }])
      .mockResolvedValueOnce([{ id: 44, status: 'maintenance', tenant_id: TENANT }]);

    await expect(
      bedService.updateBed(44, { status: 'maintenance' }, { tenantId: TENANT }),
    ).resolves.toMatchObject({ id: 44, status: 'maintenance' });

    expect(queryUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryUnsafeMock.mock.calls[0][2]).toBe(TENANT);
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $6::uuid');
    expect(queryUnsafeMock.mock.calls[1][6]).toBe(TENANT);
  });

  it('refuses to move an occupied bed out of occupancy through generic PUT', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 44,
      status: 'occupied',
      patient_id: 18,
      patient_uid: '20000000-0000-4000-8000-000000000002',
      patient_name: 'Linked Patient',
      admission_id: 71,
    }]);

    await expect(
      bedService.updateBed(44, { status: 'maintenance' }, { tenantId: TENANT }),
    ).rejects.toMatchObject({
      code: 'BED_OCCUPIED_TRANSITION_REQUIRES_ADMISSION',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('requires the ready workflow before a cleaning bed becomes available', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 44,
      status: 'cleaning',
      patient_id: null,
      patient_uid: null,
      patient_name: null,
      admission_id: null,
    }]);

    await expect(
      bedService.updateBed(44, { status: 'available' }, { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'BED_READY_WORKFLOW_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});
