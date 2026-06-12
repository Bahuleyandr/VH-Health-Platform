import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));

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
