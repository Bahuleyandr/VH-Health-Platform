import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();
const qualityIncidentsMock = {
  create: jest.fn(),
  findFirst: jest.fn(),
  update: jest.fn(),
};
const infectionCasesMock = {
  create: jest.fn(),
};

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  quality_incidents: qualityIncidentsMock,
  infection_cases: infectionCasesMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const qualityService = (await import('../../services/quality/qualityService.js')).default;

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
  Object.values(qualityIncidentsMock).forEach((mock) => mock.mockReset());
  Object.values(infectionCasesMock).forEach((mock) => mock.mockReset());
});

describe('quality service tenant authorization', () => {
  it('requires tenant context for quality reads', async () => {
    await expect(qualityService.getIncidents()).rejects.toMatchObject({
      statusCode: 403,
      code: 'QUALITY_TENANT_REQUIRED',
    });
  });

  it('verifies patient ownership and stores tenant_id for incident reports', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([]);
    qualityIncidentsMock.create.mockResolvedValue({
      id: 1,
      incident_number: 'INC-202606-00000000000040008000000000000001-0001',
      tenant_id: TENANT,
    });

    await qualityService.reportIncident({
      reported_by: ACTOR,
      patient_uid: PATIENT,
      incident_type: 'fall',
      severity: 'HIGH',
      description: 'Fall while transferring from bed',
      date_occurred: '2026-06-10T10:00:00.000Z',
      tenantId: TENANT,
    });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('uid = $1::uuid');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, TENANT]);

    const [numberSql, ...numberParams] = queryRawUnsafeMock.mock.calls[1];
    expect(numberSql).toContain('FROM quality_incidents');
    expect(numberSql).toContain('tenant_id = $1::uuid');
    expect(numberSql).toContain('incident_number LIKE $2');
    expect(numberParams[0]).toBe(TENANT);

    const createData = qualityIncidentsMock.create.mock.calls[0][0].data;
    expect(createData.tenant_id).toBe(TENANT);
    expect(createData.patient_uid).toBe(PATIENT);
    expect(createData.severity).toBe('major');
  });

  it('scopes incident list queries by tenant as the first bound predicate', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([{ id: 1, tenant_id: TENANT }]);

    await qualityService.getIncidents({
      tenantId: TENANT,
      status: 'reported',
      severity: 'CRITICAL',
    });

    const [countSql, ...countParams] = queryRawUnsafeMock.mock.calls[0];
    expect(countSql).toContain('WHERE tenant_id = $1::uuid AND status = $2 AND severity = $3');
    expect(countParams).toEqual([TENANT, 'reported', 'sentinel']);

    const [listSql, ...listParams] = queryRawUnsafeMock.mock.calls[1];
    expect(listSql).toContain('FROM quality_incidents WHERE tenant_id = $1::uuid');
    expect(listSql).toContain('LIMIT $4 OFFSET $5');
    expect(listParams.slice(0, 3)).toEqual([TENANT, 'reported', 'sentinel']);
  });

  it('updates incidents only after a tenant-scoped lookup succeeds', async () => {
    qualityIncidentsMock.findFirst.mockResolvedValue({ id: 7, status: 'reported' });
    qualityIncidentsMock.update.mockResolvedValue({ id: 7, tenant_id: TENANT, status: 'resolved' });

    await qualityService.updateIncident('7', {
      status: 'resolved',
      investigated_by: ACTOR,
      tenantId: TENANT,
    });

    expect(qualityIncidentsMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7, tenant_id: TENANT },
    }));
    expect(qualityIncidentsMock.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: expect.objectContaining({
        status: 'resolved',
        investigated_by: ACTOR,
        resolved_at: expect.any(Date),
      }),
    }));
  });

  it('scopes quality dashboard aggregates by tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ total: '2' }])
      .mockResolvedValueOnce([{ open_count: '1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '1' }]);

    await qualityService.getQualityDashboard({ tenantId: TENANT });

    for (const call of queryRawUnsafeMock.mock.calls) {
      expect(call[0]).toContain('tenant_id = $1::uuid');
      expect(call[1]).toBe(TENANT);
    }
  });

  it('verifies patient ownership and stores tenant_id for infection cases', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT }]);
    infectionCasesMock.create.mockResolvedValue({ id: 5, tenant_id: TENANT, patient_uid: PATIENT });

    await qualityService.reportInfectionCase({
      patient_uid: PATIENT,
      organism: 'MRSA',
      infection_site: 'wound',
      detection_date: '2026-06-10T10:00:00.000Z',
      reported_by: ACTOR,
      tenantId: TENANT,
    });

    const [patientSql, ...patientParams] = queryRawUnsafeMock.mock.calls[0];
    expect(patientSql).toContain('FROM users');
    expect(patientSql).toContain('tenant_id = $2::uuid');
    expect(patientParams).toEqual([PATIENT, TENANT]);

    const createData = infectionCasesMock.create.mock.calls[0][0].data;
    expect(createData.tenant_id).toBe(TENANT);
    expect(createData.patient_uid).toBe(PATIENT);
  });

  it('scopes infection surveillance and outbreak queries by tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_cases: '0', isolation_count: '0', unique_organisms: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: '0' }]);

    await qualityService.getInfectionSurveillance({ tenantId: TENANT, organism: 'MRSA' });
    await qualityService.getOutbreakAlerts({ tenantId: TENANT });

    for (const call of queryRawUnsafeMock.mock.calls) {
      expect(call[0]).toContain('tenant_id = $1::uuid');
      expect(call[1]).toBe(TENANT);
    }
  });
});
