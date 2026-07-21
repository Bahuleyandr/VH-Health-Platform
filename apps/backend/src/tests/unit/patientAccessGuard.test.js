import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));

// NOTE: these cases use the LEGACY guard form (no careTeamModeGoverned option),
// which is unchanged by Phase 0 — it always enforces (real 403 on deny) and
// never consults the per-tenant enforcement-mode resolver. The off/shadow/
// enforce mode behaviour for care-team-governed coverage is covered in
// careTeamEnforcement-guard.test.js.

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  patientAccessGuard,
  patientAccessGuardForResource,
} = await import('../../middleware/phiAccessMiddleware.js');
const { ACCESS_POLICY_CODES } = await import('../../services/security/accessDecisionService.js');

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
});

function resStub() {
  return {
    statusCode: 200,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    on: jest.fn(),
  };
}

describe('patientAccessGuard', () => {
  it('passes through when no patient context is present', async () => {
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('MEDICAL_RECORD')({
      method: 'GET',
      params: {},
      query: {},
      body: {},
      user: { id: 9, uid: '22222222-2222-4222-8222-222222222222', role: 'DOCTOR' },
    }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('denies no-context PHI operations when patient context is required', async () => {
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('MEDICAL_RECORD', { requirePatientContext: true })({
      method: 'GET',
      params: {},
      query: {},
      body: {},
      user: { id: 9, uid: '22222222-2222-4222-8222-222222222222', role: 'MEDICAL_RECORDS' },
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_CONTEXT_REQUIRED',
    }));
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('uses one generic denial for unresolved and real-but-unauthorized patients when resolution is required', async () => {
    const request = (patientUid) => ({
      id: 'req-pathway-create',
      method: 'POST',
      originalUrl: '/api/v1/care-pathways/instances',
      params: {},
      query: {},
      body: { patient_uid: patientUid },
      tenantId: '00000000-0000-4000-8000-000000000001',
      user: {
        id: 9,
        uid: '22222222-2222-4222-8222-222222222222',
        role: 'DOCTOR',
        tenant_id: '00000000-0000-4000-8000-000000000001',
      },
    });
    const guard = patientAccessGuard('CARE_PATHWAY', {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
      requireResolvedPatient: true,
    });

    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const unresolvedRes = resStub();
    await guard(
      request('44444444-4444-4444-8444-444444444444'),
      unresolvedRes,
      jest.fn(),
    );
    const unresolvedPayload = unresolvedRes.json.mock.calls[0][0];

    prismaMock.$queryRawUnsafe.mockReset();
    prismaMock.$executeRawUnsafe.mockReset();
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const invalidRes = resStub();
    await guard(request('not-a-patient-uuid'), invalidRes, jest.fn());
    const invalidPayload = invalidRes.json.mock.calls[0][0];

    prismaMock.$queryRawUnsafe.mockReset();
    prismaMock.$executeRawUnsafe.mockReset();
    prismaMock.$queryRawUnsafe
      .mockResolvedValue([])
      .mockResolvedValueOnce([{ id: 15, uid: '55555555-5555-4555-8555-555555555555' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);
    const unauthorizedRes = resStub();
    await guard(
      request('55555555-5555-4555-8555-555555555555'),
      unauthorizedRes,
      jest.fn(),
    );
    const unauthorizedPayload = unauthorizedRes.json.mock.calls[0][0];

    expect(unresolvedRes.status).toHaveBeenCalledWith(403);
    expect(invalidRes.status).toHaveBeenCalledWith(403);
    expect(unauthorizedRes.status).toHaveBeenCalledWith(403);
    expect(invalidPayload).toEqual(unresolvedPayload);
    expect(unresolvedPayload).toEqual(unauthorizedPayload);
    expect(unresolvedPayload).toEqual(expect.objectContaining({
      code: 'PATIENT_ACCESS_DENIED',
      message: expect.any(String),
    }));
  });

  it('allows active care-team members and writes an allow audit row', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 15, uid: '11111111-1111-4111-8111-111111111111' }])
      .mockResolvedValueOnce([{ id: 4, care_team_id: 5 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('MEDICAL_RECORD')({
      id: 'req-1',
      method: 'GET',
      originalUrl: '/api/v1/records?patient_id=15',
      params: {},
      query: { patient_id: '15' },
      body: {},
      user: {
        id: 9,
        uid: '22222222-2222-4222-8222-222222222222',
        role: 'DOCTOR',
        tenant_id: '00000000-0000-4000-8000-000000000001',
      },
    }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).not.toContain('ctm.staff_role');
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('allow');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('care_team');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][10]).toBe(5);
  });

  it('denies patient-specific access without relationship or break-glass', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 15, uid: '11111111-1111-4111-8111-111111111111' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuard('MEDICAL_RECORD')({
      id: 'req-2',
      method: 'GET',
      originalUrl: '/api/v1/records?patient_id=15',
      params: {},
      query: { patient_id: '15' },
      body: {},
      user: {
        id: 9,
        uid: '22222222-2222-4222-8222-222222222222',
        role: 'DOCTOR',
        tenant_id: '00000000-0000-4000-8000-000000000001',
      },
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PATIENT_ACCESS_DENIED',
      break_glass_available: false,
    }));
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('deny');
  });

  it('guards row-id resources by resolving the patient before evaluating access', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 15, uid: '11111111-1111-4111-8111-111111111111' }])
      .mockResolvedValueOnce([{ id: 15, uid: '11111111-1111-4111-8111-111111111111' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    const res = resStub();

    await patientAccessGuardForResource('APPOINTMENT', {
      policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE,
      resourceType: 'appointment',
    })({
      id: 'req-resource-1',
      method: 'POST',
      originalUrl: '/api/v1/appointments/42/confirm',
      params: { id: '42' },
      query: {},
      body: {},
      user: {
        id: 9,
        uid: '22222222-2222-4222-8222-222222222222',
        role: 'RECEPTIONIST',
        tenant_id: '00000000-0000-4000-8000-000000000001',
      },
    }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FROM appointments/i);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('role');
  });
});
