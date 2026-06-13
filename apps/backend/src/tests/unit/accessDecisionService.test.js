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
  resolvePatientForResourceAccess,
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

  it('allows a referred consultant to view patient records through an active referral relationship', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 88, status: 'pending', referred_to_department: 'Cardiology' }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('DOCTOR'), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { uid: PATIENT_UID },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('referral');
    expect(decision.referralId).toBe(88);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('allow');
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][6]).toBe('referral');
  });

  it('allows receptionist admission writes through role-owned operational workflow access', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('RECEPTIONIST', {
      method: 'POST',
      originalUrl: '/api/v1/admissions',
      query: {},
      body: { patient_uid: PATIENT_UID },
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_ADMISSION_WRITE,
      recordType: 'ADMISSION',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('role');
    expect(decision.reason).toMatch(/operational workflow access/i);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRawUnsafe.mock.calls[0][5]).toBe('allow');
  });

  it('allows pharmacy to view admitted-patient clinical workflow through an active admission relationship', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 27 }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(undefined);

    const decision = await authorizePatientAccessRequest(reqFor('PHARMACY_STAFF', {
      originalUrl: '/api/v1/clinical/drug-chart/admission/27',
      query: { patient_id: '15' },
    }), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      recordType: 'CLINICAL_WORKFLOW',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('admission');
    expect(decision.admissionId).toBe(27);
  });

  it('resolves encounter UUID resources back to the patient context', async () => {
    const encounterId = '33333333-3333-4333-8333-333333333333';
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(patientLookup());

    const patient = await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'encounter',
      resourceId: encounterId,
    });

    expect(patient).toEqual({ id: 15, uid: PATIENT_UID });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBe(encounterId);
  });

  it('resolves owned clinical resource ids through tenant-scoped patient joins', async () => {
    const problemId = '33333333-3333-4333-8333-333333333333';
    const medRecId = '44444444-4444-4444-8444-444444444444';
    const patientEncounterId = '55555555-5555-4555-8555-555555555555';
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup())
      .mockResolvedValueOnce(patientLookup());

    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'patient_problem',
      resourceId: problemId,
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'medication_reconciliation',
      resourceId: medRecId,
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'patient_encounter',
      resourceId: patientEncounterId,
    });
    await resolvePatientForResourceAccess(reqFor('DOCTOR'), {
      resourceType: 'radiology_order',
      resourceId: '12',
    });

    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('FROM patient_problems');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe('00000000-0000-4000-8000-000000000001');
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toContain('FROM medication_reconciliations');
    expect(prismaMock.$queryRawUnsafe.mock.calls[2][0]).toContain('FROM patient_encounters');
    expect(prismaMock.$queryRawUnsafe.mock.calls[3][0]).toContain('FROM radiology_orders');
  });
});
