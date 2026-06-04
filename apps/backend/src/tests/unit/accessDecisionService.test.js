import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
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
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
} = await import('../../services/security/accessDecisionService.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
});

function reqFor(role, extras = {}) {
  return {
    id: 'req-1',
    method: 'GET',
    originalUrl: '/api/v1/records?patient_id=15',
    params: {},
    query: { patient_id: '15' },
    body: {},
    user: {
      id: 9,
      uid: ACTOR_UID,
      role,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      ...extras.user,
    },
    ...extras,
  };
}

function patientLookup() {
  return [{ id: 15, uid: PATIENT_UID }];
}

describe('accessDecisionService', () => {
  it('denies CNO PHI access without a patient relationship or break-glass override', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('CNO'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.break_glass_available).toBe(false);
    expect(decision.policy_code).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('deny');
  });

  it('denies Admin PHI access without active break-glass but advertises break-glass availability', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('ADMIN'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.break_glass_available).toBe(true);
    expect(decision.reason).toMatch(/relationship/i);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('deny');
  });

  it('allows Admin PHI access through an active break-glass session', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([{ id: 44 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('ADMIN'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessDecision).toBe('break_glass');
    expect(decision.accessSource).toBe('break_glass');
    expect(decision.breakGlassId).toBe(44);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('break_glass');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][11]).toBe(44);
  });

  it('allows receptionist record view only when an OP appointment relationship exists', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 77 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RECEPTIONIST'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('appointment');
    expect(decision.appointmentId).toBe(77);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('appointment');
  });

  it('keeps HR leave/reporting authority out of patient PHI access', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('HR_STAFF'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.phi_access_level).toBe('staff_only');
    expect(decision.reason).toMatch(/does not have a patient PHI access scope/i);
  });

  it('denies OP-only nursing roles from IP-only extraction review capability', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('OP_STAFF_NURSE'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW,
      recordType: 'PATIENT_RECORD_EXTRACTION',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/capability group/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('denies explicit record access when the patient context cannot be resolved', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const decision = await authorizePatientAccessRequest(reqFor('DOCTOR'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
      requireResolvedPatient: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/could not be resolved/i);
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
